/**
 * Данные вкладки «Помощник» админки платформы (ТЗ §8, пункты 1–5 и 8) —
 * по всем кабинетам сразу, основной ролью. Только режим «Сайт»: ответы и
 * знания «Админки» сюда не попадают никогда (У-6/У-15) — таблиц
 * `assist_admin_*` модуль не читает.
 *
 *  1. Сводка — кабинеты, сайты, хосты по статусу, диалоги/сутки, расход,
 *     выручка и маржа по тарифам, доля отказов по причинам.
 *  2. Кабинеты и сайты — поиск по домену/владельцу, тариф и счётчик,
 *     ручная смена тарифа и продление, блокировка сайта, потолок сайта.
 *  3. Ревью — флагованные ответы и 👎 (текст уже маскирован), журнал
 *     доступа; «в eval платформы» — только при согласии кабинета в DPA;
 *     «написать заказчику» — сообщение владельцу в бот Помощника.
 *  4. Анти-абьюз — suspicious-трафик, всплески, opt-out доменов.
 *  5. Настройки — рубильник виджета и потолок платформы (env — верхняя
 *     граница), модели — только чтение.
 *  8. Расходы — `assist-*` из site_ai_usage, топ-10 сайтов против выручки.
 */

import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIDGET_SETTINGS_KEY,
  parseWidgetSettings,
  readWidgetPlatformSettings,
  resetPlatformSettingsCache,
  type WidgetPlatformSettings,
} from '../../common/platform-settings';
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import {
  parseWidgetRelease,
  readVoiceControlPlatform,
  readWidgetRelease,
  resetVoiceControlPlatformCache,
  VOICE_CONTROL_SETTINGS_KEY,
  WIDGET_RELEASE_KEY,
  writePlatformSetting,
} from '../../common/voice-control-platform';
import { voiceControlPlatformEnabled } from '../assist-site-voice-control/voice-control-config';
import {
  widgetPlatformDailyCapMicroUsd,
  widgetPlatformEnabled,
} from '../../config/widget-env';
import { PrismaService } from '../../prisma/prisma.service';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { BillingNotices } from '../assist-billing/billing-notices';
import { LEGAL_DOCUMENTS, paymentRates } from '../assist-billing/billing-env';
import { ASSIST_PLANS, MICRO, isAssistPlanId } from '../assist-billing/plans';
import { readState, readUsage } from '../assist-billing/public/entitlements';
import { unitsLimit } from '../assist-billing/subscription-state';

const DAY = 24 * 60 * 60 * 1000;

export function adminError(code: string, message: string, status: number) {
  return new HttpException({ message, error: code, code }, status);
}

const n = (v: unknown): number =>
  typeof v === 'bigint'
    ? Number(v)
    : typeof v === 'number'
      ? v
      : Number(v ?? 0);

export interface AccountRow {
  accountId: string;
  ownerTelegramId: string | null;
  createdAt: string;
  sites: number;
  domains: string[];
  plan: string | null;
  status: string;
  method: string;
  paidThrough: string | null;
  units: number;
  limit: number;
}

@Injectable()
export class PlatformAdmin {
  private readonly logger = new Logger(PlatformAdmin.name);
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notices?: BillingNotices,
  ) {}

  private async log(actor: string, action: string, target?: string) {
    await this.prisma.assistPlatformAccessLog.create({
      data: { actor, action, target: target?.slice(0, 200) ?? null },
    });
  }

  // ── 1. Сводка ───────────────────────────────────────────────────────

  async summary(days: number) {
    const now = this.now();
    const since = new Date(now.getTime() - days * DAY);
    const [accounts] = await this.prisma.$queryRawUnsafe<
      Array<{ accounts: bigint; assist: bigint; sites: bigint }>
    >(
      `SELECT (SELECT count(*) FROM "sites"."site_accounts") AS accounts,
              (SELECT count(DISTINCT "accountId") FROM "sites"."assist_sites") AS assist,
              (SELECT count(*) FROM "sites"."assist_sites") AS sites`,
    );
    const hosts = await this.prisma.$queryRawUnsafe<
      Array<{ status: string; c: bigint }>
    >(
      `SELECT h."status", count(*) AS c FROM "sites"."site_hosts" h
         JOIN "sites"."assist_sites" a ON a."siteId" = h."siteId"
        GROUP BY h."status" ORDER BY h."status"`,
    );
    const plans = await this.prisma.$queryRawUnsafe<
      Array<{ planId: string; status: string; c: bigint }>
    >(
      `SELECT "planId", "status", count(*) AS c FROM "sites"."assist_subscriptions"
        GROUP BY "planId", "status" ORDER BY 1, 2`,
    );
    const dialogs = await this.prisma.$queryRawUnsafe<
      Array<{ day: string; c: bigint }>
    >(
      `SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, count(*) AS c
         FROM "sites"."assist_site_conversations"
        WHERE "dialogCounted" AND "createdAt" >= $1
        GROUP BY 1 ORDER BY 1`,
      since,
    );
    const [spend] = await this.prisma.$queryRawUnsafe<
      Array<{ s: bigint | null }>
    >(
      `SELECT sum("costMicroUsd") AS s FROM "sites"."site_ai_usage"
        WHERE "operation" LIKE 'assist-%' AND "createdAt" >= $1`,
      since,
    );
    const revenue = await this.prisma.$queryRawUnsafe<
      Array<{ planId: string | null; s: bigint | null; c: bigint }>
    >(
      `SELECT "planId", sum("amountMicroUsd") AS s, count(*) AS c FROM "sites"."assist_payments"
        WHERE "status" = 'succeeded' AND "paidAt" >= $1
        GROUP BY "planId" ORDER BY 1`,
      since,
    );
    const refusals = await this.prisma.$queryRawUnsafe<
      Array<{ rule: string | null; c: bigint }>
    >(
      `SELECT "trace"->>'rule' AS rule, count(*) AS c FROM "sites"."assist_site_messages"
        WHERE "role" = 'assistant' AND "streamState" = 'refused' AND "createdAt" >= $1
        GROUP BY 1 ORDER BY 2 DESC`,
      since,
    );
    const [answers] = await this.prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT count(*) AS c FROM "sites"."assist_site_messages"
        WHERE "role" = 'assistant' AND "createdAt" >= $1`,
      since,
    );
    const spendUsd = n(spend?.s) / MICRO;
    const revenueUsd = revenue.reduce((a, r) => a + n(r.s), 0) / MICRO;
    return {
      days,
      accounts: n(accounts.accounts),
      assistAccounts: n(accounts.assist),
      assistSites: n(accounts.sites),
      hostsByStatus: hosts.map((h) => ({ status: h.status, count: n(h.c) })),
      subscriptions: plans.map((p) => ({
        planId: p.planId,
        status: p.status,
        count: n(p.c),
      })),
      dialogsPerDay: dialogs.map((d) => ({ day: d.day, count: n(d.c) })),
      spendUsd,
      revenueUsd,
      marginUsd: revenueUsd - spendUsd,
      revenueByPlan: revenue.map((r) => ({
        planId: r.planId,
        usd: n(r.s) / MICRO,
        payments: n(r.c),
      })),
      answers: n(answers?.c),
      refusals: refusals.map((r) => ({
        rule: r.rule ?? 'unknown',
        count: n(r.c),
      })),
    };
  }

  // ── 2. Кабинеты и сайты ─────────────────────────────────────────────

  async accounts(q: string, limit: number): Promise<AccountRow[]> {
    const term = q.trim().toLowerCase().slice(0, 100);
    const tg = /^\d{3,20}$/.test(term) ? BigInt(term) : null;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        createdAt: Date;
        owner: bigint | null;
        sites: bigint;
        domains: string[] | null;
      }>
    >(
      `SELECT a."id", a."createdAt",
              (SELECT m."telegramId" FROM "sites"."site_account_members" m
                WHERE m."accountId" = a."id" AND m."role" = 'owner' ORDER BY m."createdAt" LIMIT 1) AS owner,
              (SELECT count(*) FROM "sites"."assist_sites" s WHERE s."accountId" = a."id") AS sites,
              (SELECT array_agg(DISTINCT h."host") FROM "sites"."site_hosts" h WHERE h."accountId" = a."id") AS domains
         FROM "sites"."site_accounts" a
        WHERE EXISTS (SELECT 1 FROM "sites"."assist_sites" s WHERE s."accountId" = a."id")
          AND ($1 = '' OR a."id" = $1
               OR EXISTS (SELECT 1 FROM "sites"."site_hosts" h WHERE h."accountId" = a."id" AND h."host" LIKE '%' || $1 || '%')
               OR ($2::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM "sites"."site_account_members" m
                     WHERE m."accountId" = a."id" AND m."telegramId" = $2::bigint)))
        ORDER BY a."createdAt" DESC
        LIMIT $3`,
      term,
      tg,
      Math.min(Math.max(limit, 1), 100),
    );
    const now = this.now();
    const out: AccountRow[] = [];
    for (const r of rows) {
      const state = await readState(this.prisma, r.id, now);
      const usage = await readUsage(this.prisma, r.id, state.periodKey);
      out.push({
        accountId: r.id,
        ownerTelegramId: r.owner === null ? null : r.owner.toString(),
        createdAt: r.createdAt.toISOString(),
        sites: n(r.sites),
        domains: (r.domains ?? []).slice(0, 10),
        plan: state.planId,
        status: state.status,
        method: state.method,
        paidThrough: state.paidThrough?.toISOString() ?? null,
        units: usage.units,
        limit: unitsLimit(state, usage.extraUnits),
      });
    }
    return out;
  }

  async account(id: string, actor: string) {
    const acc = await this.prisma.siteAccount.findUnique({
      where: { id },
      select: { id: true, createdAt: true, type: true, region: true },
    });
    if (!acc)
      throw adminError('NOT_FOUND', 'Кабинет не найден', HttpStatus.NOT_FOUND);
    await this.log(actor, 'account:view', id);
    const now = this.now();
    const state = await readState(this.prisma, id, now);
    const usage = await readUsage(this.prisma, id, state.periodKey);
    const sub = await this.prisma.assistSubscription.findUnique({
      where: { accountId: id },
      select: {
        planId: true,
        status: true,
        method: true,
        anchorAt: true,
        paidThrough: true,
        cancelAtPeriodEnd: true,
        autoTopUp: true,
        autoTopUpCapMicroUsd: true,
        renewAttempts: true,
        lastRenewError: true,
        note: true,
      },
    });
    const sites = await this.prisma.assistSite.findMany({
      where: { accountId: id },
      select: {
        siteId: true,
        enabled: true,
        chatPaused: true,
        operatorBlockedAt: true,
        dailyCapMicroUsd: true,
        widgetVersion: true,
        site: {
          select: {
            name: true,
            hosts: { select: { host: true, status: true, expiresAt: true } },
          },
        },
      },
    });
    const payments = await this.prisma.assistPayment.findMany({
      where: { accountId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        kind: true,
        planId: true,
        units: true,
        method: true,
        status: true,
        currency: true,
        amountMinor: true,
        amountMicroUsd: true,
        failureReason: true,
        createdAt: true,
        paidAt: true,
      },
    });
    const legal = await this.prisma.assistLegalAcceptance.findMany({
      where: { accountId: id },
      select: {
        document: true,
        version: true,
        evalConsent: true,
        acceptedAt: true,
      },
    });
    return {
      accountId: acc.id,
      createdAt: acc.createdAt.toISOString(),
      type: acc.type,
      region: acc.region,
      state: {
        planId: state.planId,
        status: state.status,
        method: state.method,
        periodStart: state.periodStart?.toISOString() ?? null,
        periodEnd: state.periodEnd?.toISOString() ?? null,
        paidThrough: state.paidThrough?.toISOString() ?? null,
      },
      usage: { ...usage, limit: unitsLimit(state, usage.extraUnits) },
      subscription: sub
        ? {
            ...sub,
            anchorAt: sub.anchorAt.toISOString(),
            paidThrough: sub.paidThrough.toISOString(),
            autoTopUpCapUsd: Number(sub.autoTopUpCapMicroUsd) / MICRO,
            autoTopUpCapMicroUsd: undefined,
          }
        : null,
      sites: sites.map((s) => ({
        siteId: s.siteId,
        name: s.site.name,
        enabled: s.enabled,
        chatPaused: s.chatPaused,
        blocked: s.operatorBlockedAt !== null,
        dailyCapUsd:
          s.dailyCapMicroUsd === null ? null : s.dailyCapMicroUsd / MICRO,
        widgetVersion: s.widgetVersion,
        hosts: s.site.hosts.map((h) => ({
          host: h.host,
          status: h.status,
          expiresAt: h.expiresAt?.toISOString() ?? null,
        })),
      })),
      payments: payments.map((p) => ({
        ...p,
        amountUsd: Number(p.amountMicroUsd) / MICRO,
        amountMicroUsd: undefined,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null,
      })),
      legal: legal.map((l) => ({
        ...l,
        current:
          l.version === LEGAL_DOCUMENTS[l.document as 'terms' | 'dpa']?.version,
        acceptedAt: l.acceptedAt.toISOString(),
      })),
    };
  }

  /** Ручной тариф (пилот, компенсация): `days` с сейчас, способ manual. */
  async setPlan(
    id: string,
    actor: string,
    body: { planId: string; days: number; note?: string },
  ) {
    if (!isAssistPlanId(body.planId)) {
      throw adminError(
        'BAD_REQUEST',
        'Тариф: trial|start|business|pro',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > 730) {
      throw adminError(
        'BAD_REQUEST',
        'Дней — от 1 до 730',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.assertAccount(id);
    const now = this.now();
    const data = {
      planId: body.planId,
      status: 'active',
      method: 'manual',
      anchorAt: now,
      paidThrough: new Date(now.getTime() + body.days * DAY),
      cancelAtPeriodEnd: false,
      recTokenEnc: null,
      autoTopUp: false,
      starsChargeId: null,
      starsPayerTelegramId: null,
      note: body.note?.slice(0, 500) ?? null,
    };
    await this.prisma.assistSubscription.upsert({
      where: { accountId: id },
      create: { accountId: id, ...data },
      update: data,
    });
    await this.log(actor, `account:set-plan:${body.planId}:${body.days}d`, id);
    return this.account(id, actor);
  }

  /** Продлить действующий период на `days` (тот же тариф и якорь). */
  async extend(id: string, actor: string, days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw adminError(
        'BAD_REQUEST',
        'Дней — от 1 до 365',
        HttpStatus.BAD_REQUEST,
      );
    }
    const sub = await this.prisma.assistSubscription.findUnique({
      where: { accountId: id },
      select: { paidThrough: true },
    });
    if (!sub) {
      throw adminError(
        'CONFLICT',
        'Подписки нет — задайте тариф',
        HttpStatus.CONFLICT,
      );
    }
    const base = Math.max(sub.paidThrough.getTime(), this.now().getTime());
    await this.prisma.assistSubscription.update({
      where: { accountId: id },
      data: { paidThrough: new Date(base + days * DAY), status: 'active' },
    });
    await this.log(actor, `account:extend:${days}d`, id);
    return this.account(id, actor);
  }

  async setSite(
    siteId: string,
    actor: string,
    body: {
      blocked?: boolean;
      dailyCapUsd?: number | null;
      /** Э6-бис (г), решение владельца п.2: потолок планов голосового управления в сутки. */
      voiceControlPlansPerDay?: number | null;
    },
  ) {
    const row = await this.prisma.assistSite.findUnique({
      where: { siteId },
      select: { accountId: true },
    });
    if (!row)
      throw adminError('NOT_FOUND', 'Сайт не найден', HttpStatus.NOT_FOUND);
    const data: Prisma.AssistSiteUpdateInput = {};
    if (body.blocked !== undefined) {
      data.operatorBlockedAt = body.blocked ? this.now() : null;
    }
    if (body.dailyCapUsd !== undefined) {
      data.dailyCapMicroUsd =
        body.dailyCapUsd === null ? null : Math.round(body.dailyCapUsd * MICRO);
    }
    if (body.voiceControlPlansPerDay !== undefined)
      data.voiceControlPlansPerDay = body.voiceControlPlansPerDay;
    await this.prisma.assistSite.update({ where: { siteId }, data });
    await this.log(
      actor,
      `site:${body.blocked !== undefined ? (body.blocked ? 'block' : 'unblock') : body.voiceControlPlansPerDay !== undefined ? `vc-plans:${body.voiceControlPlansPerDay ?? 'plan'}` : 'cap'}`,
      siteId,
    );
    return this.account(row.accountId, actor);
  }

  // ── Э6-бис (г): голосовое управление — рубильник, канарейка, инциденты ──

  /** Рубильник голосового управления платформы, выпуски виджета, журнал монитора. */
  async voiceControl() {
    resetVoiceControlPlatformCache();
    const [platform, release, incidents, sites] = await Promise.all([
      readVoiceControlPlatform(this.prisma),
      readWidgetRelease(this.prisma),
      this.prisma.assistSiteVoiceIncident.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          siteId: true,
          kind: true,
          code: true,
          metrics: true,
          createdAt: true,
        },
      }),
      // Сайты не в норме: подсказка (монитор/владелец) и выключенные нарушением.
      this.prisma.assistSite.findMany({
        where: {
          OR: [
            { voiceControlSiteState: 'degraded' },
            { voiceControlSiteStateBy: 'violation' },
          ],
        },
        select: {
          siteId: true,
          voiceControlSiteState: true,
          voiceControlSiteStateBy: true,
          voiceControlSiteStateReason: true,
          voiceControlSiteStateAt: true,
        },
        take: 100,
      }),
    ]);
    return {
      platform,
      envEnabled: voiceControlPlatformEnabled(this.env),
      release,
      incidents: incidents.map((i) => ({
        ...i,
        createdAt: i.createdAt.toISOString(),
      })),
      sites: sites.map((x) => ({
        siteId: x.siteId,
        state: x.voiceControlSiteState,
        by: x.voiceControlSiteStateBy,
        reason: x.voiceControlSiteStateReason,
        at: x.voiceControlSiteStateAt?.toISOString() ?? null,
      })),
    };
  }

  async setVoiceControl(
    actor: string,
    patch: {
      enabled?: boolean;
      stable?: string | null;
      canary?: string | null;
      canaryPercent?: number;
    },
  ) {
    const now = this.now();
    if (patch.enabled !== undefined) {
      await writePlatformSetting(
        this.prisma,
        VOICE_CONTROL_SETTINGS_KEY,
        {
          enabled: patch.enabled,
          reason: patch.enabled ? null : 'operator',
          at: now.toISOString(),
        },
        actor,
      );
      await this.log(actor, `voice-control:${patch.enabled ? 'on' : 'off'}`);
    }
    if (
      patch.stable !== undefined ||
      patch.canary !== undefined ||
      patch.canaryPercent !== undefined
    ) {
      resetVoiceControlPlatformCache();
      const cur = await readWidgetRelease(this.prisma);
      const stable = patch.stable === undefined ? cur.stable : patch.stable;
      const canary = patch.canary === undefined ? cur.canary : patch.canary;
      const next = parseWidgetRelease({
        stable,
        canary,
        canaryPercent: patch.canaryPercent ?? cur.canaryPercent,
        // Новая канарейка — новое окно сравнения.
        canarySince:
          canary && canary !== cur.canary ? now.toISOString() : cur.canarySince,
        rolledBack: cur.rolledBack,
      });
      if (canary && !next.canary) {
        throw adminError(
          'BAD_REQUEST',
          'Канарейка — только вместе со стабильным выпуском и не равная ему',
          HttpStatus.BAD_REQUEST,
        );
      }
      await writePlatformSetting(this.prisma, WIDGET_RELEASE_KEY, next, actor);
      await this.log(
        actor,
        `widget-release:${next.stable ?? '-'}:${next.canary ?? '-'}:${next.canaryPercent}`,
      );
    }
    return this.voiceControl();
  }

  /**
   * Нарушение запрета по жалобе (§5-бис.14: «обнаружено разбором журнала,
   * жалобой или регистратором») — сайт в `off`, инцидент. Включить снова —
   * владелец после нового `pass` мастера.
   */
  async voiceIncident(siteId: string, actor: string, reason: string) {
    const row = await this.prisma.assistSite.findUnique({
      where: { siteId },
      select: { accountId: true },
    });
    if (!row)
      throw adminError('NOT_FOUND', 'Сайт не найден', HttpStatus.NOT_FOUND);
    const code = /^[a-z0-9_]{1,30}$/.test(reason) ? reason : 'complaint';
    await this.prisma.assistSite.update({
      where: { siteId },
      data: {
        voiceControlSiteState: 'off',
        voiceControlSiteTestId: null,
        voiceControlSiteStateAt: this.now(),
        voiceControlSiteStateBy: 'violation',
        voiceControlSiteStateReason: code,
      },
    });
    await this.prisma.assistSiteVoiceIncident.create({
      data: {
        accountId: row.accountId,
        siteId,
        kind: 'off',
        code: 'violation',
        metrics: { by: 'operator', reason: code },
      },
    });
    await this.log(actor, `voice-control:incident:${code}`, siteId);
    return this.voiceControl();
  }

  private async assertAccount(id: string) {
    const acc = await this.prisma.siteAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!acc)
      throw adminError('NOT_FOUND', 'Кабинет не найден', HttpStatus.NOT_FOUND);
  }

  async messageOwner(id: string, actor: string, text: string) {
    const clean = text.trim().slice(0, 2000);
    if (!clean)
      throw adminError(
        'BAD_REQUEST',
        'Пустое сообщение',
        HttpStatus.BAD_REQUEST,
      );
    await this.assertAccount(id);
    const sent =
      (await this.notices?.send(
        id,
        `Сообщение от команды Помощника:\n\n${clean}`,
      )) ?? 0;
    await this.log(actor, 'account:message', id);
    return { sent };
  }

  // ── 3. Ревью (только «Сайт», текст маскирован) ──────────────────────

  async review(actor: string, days: number, limit: number) {
    const since = new Date(this.now().getTime() - days * DAY);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        accountId: string;
        siteId: string;
        conversationId: string;
        text: string;
        flags: string[];
        rating: number | null;
        createdAt: Date;
        question: string | null;
        consent: boolean | null;
      }>
    >(
      `SELECT m."id", m."accountId", m."siteId", m."conversationId", m."text", m."flags",
              m."rating", m."createdAt",
              (SELECT v."text" FROM "sites"."assist_site_messages" v
                WHERE v."conversationId" = m."conversationId" AND v."role" = 'visitor'
                  AND v."createdAt" <= m."createdAt" ORDER BY v."createdAt" DESC LIMIT 1) AS question,
              (SELECT l."evalConsent" FROM "sites"."assist_legal_acceptances" l
                WHERE l."accountId" = m."accountId" AND l."document" = 'dpa' AND l."version" = $3) AS consent
         FROM "sites"."assist_site_messages" m
        WHERE m."role" = 'assistant' AND m."createdAt" >= $1
          AND (cardinality(m."flags") > 0 OR m."rating" = -1)
        ORDER BY m."createdAt" DESC
        LIMIT $2`,
      since,
      Math.min(Math.max(limit, 1), 200),
      LEGAL_DOCUMENTS.dpa.version,
    );
    await this.log(actor, `review:list:${rows.length}`);
    return rows.map((r) => ({
      messageId: r.id,
      accountId: r.accountId,
      siteId: r.siteId,
      conversationId: r.conversationId,
      question: r.question,
      answer: r.text,
      flags: r.flags,
      rating: r.rating,
      createdAt: r.createdAt.toISOString(),
      evalConsent: r.consent === true,
    }));
  }

  async addToEval(messageId: string, actor: string) {
    const [r] = await this.prisma.$queryRawUnsafe<
      Array<{
        accountId: string;
        siteId: string;
        text: string;
        question: string | null;
        consent: boolean | null;
      }>
    >(
      `SELECT m."accountId", m."siteId", m."text",
              (SELECT v."text" FROM "sites"."assist_site_messages" v
                WHERE v."conversationId" = m."conversationId" AND v."role" = 'visitor'
                  AND v."createdAt" <= m."createdAt" ORDER BY v."createdAt" DESC LIMIT 1) AS question,
              (SELECT l."evalConsent" FROM "sites"."assist_legal_acceptances" l
                WHERE l."accountId" = m."accountId" AND l."document" = 'dpa' AND l."version" = $2) AS consent
         FROM "sites"."assist_site_messages" m
        WHERE m."id" = $1 AND m."role" = 'assistant'`,
      messageId,
      LEGAL_DOCUMENTS.dpa.version,
    );
    if (!r)
      throw adminError('NOT_FOUND', 'Ответ не найден', HttpStatus.NOT_FOUND);
    if (r.consent !== true) {
      throw adminError(
        'NO_CONSENT',
        'Заказчик не дал согласия в DPA на использование ответов в eval платформы',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.assistPlatformEvalCandidate.createMany({
      data: [
        {
          accountId: r.accountId,
          siteId: r.siteId,
          messageId,
          question: r.question ?? '',
          answer: r.text,
          addedBy: actor,
        },
      ],
      skipDuplicates: true,
    });
    await this.log(actor, 'review:eval-add', messageId);
    return { added: true };
  }

  // ── 4. Анти-абьюз ───────────────────────────────────────────────────

  async abuse(days: number) {
    const now = this.now();
    const since = new Date(now.getTime() - days * DAY);
    const suspicious = await this.prisma.$queryRawUnsafe<
      Array<{ siteId: string; accountId: string; c: bigint; total: bigint }>
    >(
      `SELECT c."siteId", c."accountId",
              count(*) FILTER (WHERE c."suspicious") AS c, count(*) AS total
         FROM "sites"."assist_site_conversations" c
        WHERE c."createdAt" >= $1
        GROUP BY 1, 2 HAVING count(*) FILTER (WHERE c."suspicious") > 0
        ORDER BY 3 DESC LIMIT 20`,
      since,
    );
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const spikes = await this.prisma.$queryRawUnsafe<
      Array<{ siteId: string; today: bigint; avg: number | null }>
    >(
      `SELECT c."siteId",
              count(*) FILTER (WHERE c."createdAt" >= $1) AS today,
              (count(*) FILTER (WHERE c."createdAt" < $1))::float / 7 AS avg
         FROM "sites"."assist_site_conversations" c
        WHERE c."createdAt" >= $2
        GROUP BY 1
       HAVING count(*) FILTER (WHERE c."createdAt" >= $1) >= 20
          AND count(*) FILTER (WHERE c."createdAt" >= $1)
              >= 3 * GREATEST(1, (count(*) FILTER (WHERE c."createdAt" < $1))::float / 7)
        ORDER BY 2 DESC LIMIT 20`,
      dayStart,
      new Date(dayStart.getTime() - 7 * DAY),
    );
    const optOut = await this.prisma.siteOptOutDomain.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { domain: true, source: true, createdAt: true },
    });
    return {
      suspicious: suspicious.map((s) => ({
        siteId: s.siteId,
        accountId: s.accountId,
        suspicious: n(s.c),
        total: n(s.total),
      })),
      spikes: spikes.map((s) => ({
        siteId: s.siteId,
        today: n(s.today),
        avgPerDay: Math.round((s.avg ?? 0) * 10) / 10,
      })),
      optOut: optOut.map((o) => ({
        ...o,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  async addOptOut(domain: string, actor: string) {
    const d = domain.trim().toLowerCase();
    if (!/^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(d)) {
      throw adminError(
        'BAD_REQUEST',
        'Домен вида example.com',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.prisma.siteOptOutDomain.createMany({
      data: [{ domain: d, source: 'operator', confirmedAt: this.now() }],
      skipDuplicates: true,
    });
    await this.log(actor, 'optout:add', d);
    return { domain: d };
  }

  async removeOptOut(domain: string, actor: string) {
    const d = domain.trim().toLowerCase();
    const r = await this.prisma.siteOptOutDomain.deleteMany({
      where: { domain: d },
    });
    await this.log(actor, 'optout:remove', d);
    return { removed: r.count };
  }

  // ── 5. Настройки ────────────────────────────────────────────────────

  async settings() {
    resetPlatformSettingsCache();
    const s = await readWidgetPlatformSettings(this.prisma);
    const rates = paymentRates(this.env);
    return {
      widget: s,
      env: {
        widgetEnabled: widgetPlatformEnabled(this.env),
        platformDailyCapUsd: widgetPlatformDailyCapMicroUsd(this.env) / MICRO,
        sandboxPublicEnabled:
          this.env.ASSIST_SANDBOX_PUBLIC_ENABLED?.trim().toLowerCase() ===
          'true',
      },
      models: {
        chat: GEMINI_MODEL,
        embeddings: KNOWLEDGE_DEFAULTS.embedModel,
      },
      rates,
      plans: Object.values(ASSIST_PLANS).map((p) => ({
        id: p.id,
        priceUsdMonthly: p.priceUsdMonthly,
        dialogsPerMonth: p.dialogsPerMonth,
        overageUsdPer100: p.overageUsdPer100,
      })),
      legal: LEGAL_DOCUMENTS,
    };
  }

  async setSettings(actor: string, patch: Partial<WidgetPlatformSettings>) {
    const cur = parseWidgetSettings(
      (
        await this.prisma.assistPlatformSetting.findUnique({
          where: { key: WIDGET_SETTINGS_KEY },
        })
      )?.value,
    );
    const next: WidgetPlatformSettings = {
      enabled: patch.enabled ?? cur.enabled,
      dailyCapUsd:
        patch.dailyCapUsd === undefined ? cur.dailyCapUsd : patch.dailyCapUsd,
    };
    await this.prisma.assistPlatformSetting.upsert({
      where: { key: WIDGET_SETTINGS_KEY },
      create: {
        key: WIDGET_SETTINGS_KEY,
        value: next as unknown as Prisma.InputJsonValue,
        updatedBy: actor,
      },
      update: {
        value: next as unknown as Prisma.InputJsonValue,
        updatedBy: actor,
      },
    });
    await this.log(
      actor,
      `settings:widget:${next.enabled ? 'on' : 'off'}:${next.dailyCapUsd ?? 'env'}`,
    );
    resetPlatformSettingsCache();
    return this.settings();
  }

  // ── 8. Расходы ──────────────────────────────────────────────────────

  async costs(days: number) {
    const since = new Date(this.now().getTime() - days * DAY);
    const byOperation = await this.prisma.$queryRawUnsafe<
      Array<{ operation: string; s: bigint | null; calls: bigint }>
    >(
      `SELECT "operation", sum("costMicroUsd") AS s, sum("calls") AS calls
         FROM "sites"."site_ai_usage"
        WHERE "operation" LIKE 'assist-%' AND "createdAt" >= $1
        GROUP BY 1 ORDER BY 2 DESC NULLS LAST`,
      since,
    );
    const topSites = await this.prisma.$queryRawUnsafe<
      Array<{
        siteId: string;
        accountId: string | null;
        s: bigint | null;
        revenue: bigint | null;
      }>
    >(
      `SELECT u."siteId", min(u."accountId") AS "accountId", sum(u."costMicroUsd") AS s,
              (SELECT sum(p."amountMicroUsd") FROM "sites"."assist_payments" p
                WHERE p."accountId" = min(u."accountId") AND p."status" = 'succeeded' AND p."paidAt" >= $1) AS revenue
         FROM "sites"."site_ai_usage" u
        WHERE u."operation" LIKE 'assist-%' AND u."createdAt" >= $1 AND u."siteId" IS NOT NULL
        GROUP BY u."siteId" ORDER BY 3 DESC NULLS LAST LIMIT 10`,
      since,
    );
    return {
      days,
      byOperation: byOperation.map((r) => ({
        operation: r.operation,
        usd: n(r.s) / MICRO,
        calls: n(r.calls),
      })),
      topSites: topSites.map((r) => ({
        siteId: r.siteId,
        accountId: r.accountId,
        costUsd: n(r.s) / MICRO,
        accountRevenueUsd: n(r.revenue) / MICRO,
      })),
    };
  }
}
