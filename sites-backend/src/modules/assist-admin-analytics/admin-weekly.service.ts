/**
 * Выводы недели и еженедельный отчёт «Админки» (заход 10, №57; ТЗ
 * §5-тер.13 У-24/У-27, §5-тер.7) — системный код крона assist-admin-embed-run.
 *
 *  - неделя — понедельник…воскресенье UTC; работа недели — с понедельника
 *    06:00 UTC (после суточной свёртки воскресенья), один раз на сайт:
 *    условный UPDATE `weeklyReportWeek` (дедуп сайт × неделя — повтор крона
 *    и два инстанса не пришлют отчёт дважды);
 *  - находки считает код по свёрткам и разметке ТОЛЬКО «Админки» (вход
 *    «Сайта» сюда не попадает — У-24); модель лишь формулирует (uk/ru/en),
 *    числа проверяются; модели нет, резерв не прошёл, проверка не прошла —
 *    сухие строки кодом. Деньги — тот же резерв, что у разметки
 *    (`reserveAdminTurn`, доля потолка «Админки»), операция
 *    `assist-admin-insight`;
 *  - отчёт — ТОЛЬКО владельцу кабинета и `assistAdmin: owner` (У-27), каждому
 *    на ЕГО языке (`recipientsWithLang`, Р-З9-7); выключатель — настройка
 *    `weeklyReport`. Недели без диалогов — без вывода и без отчёта;
 *  - заход 11 (Р-З11-В3): сегодняшняя сводка `assist-digest` ещё впереди —
 *    отчёт ждёт её и уходит её разделом (одно сообщение); остаток после
 *    сводки досылает `flush` отдельным сообщением (admin-weekly-digest.ts).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  effectivePlatformCapMicroUsd,
  readWidgetPlatformSettings,
} from '../../common/platform-settings';
import { widgetPlatformDailyCapMicroUsd } from '../../config/widget-env';
import { readState } from '../assist-billing/public/entitlements';
import { ASSIST_PLANS, siteDailyCapFromPlan } from '../assist-billing/plans';
import {
  reserveAdminTurn,
  settleAdminTurn,
} from '../assist-admin-mode/admin-budget';
import {
  type FetchLike,
  recipientsWithLang,
  sendToMembersByLang,
} from '../assist-knowledge-core/notify';
import { GeminiText, TextModelError, spentOf } from '../site-ai/text-model';
import {
  ADMIN_INSIGHT_OPERATION,
  adminAnalyticsCap,
  adminInsightEstimateMicroUsd,
  adminLiteModel,
} from './admin-analytics-env';
import { ROLE_TOTAL } from './admin-rollup.service';
import {
  ADMIN_REPORT_LANGS,
  type AdminFinding,
  type AdminInsightItem,
  type AdminWeekTotals,
  addDaysIso,
  buildInsightPrompt,
  parseInsightItems,
  sumWeek,
  weekFindings,
  weekStartOf,
  weeklyReportText,
} from './admin-report-text';
import { recordAdminUsage } from './admin-usage';
import {
  AdminWeeklyDigest,
  type AdminWeeklyTexts,
  digestAhead,
  digestPassed,
  parseWeeklyTexts,
} from './admin-weekly-digest';

/** С какого часа понедельника (UTC) делается неделя. */
export const ADMIN_WEEKLY_HOUR_UTC = 6;
/**
 * Аудит з11 P2-2 (решение координатора): пока сегодняшняя сводка впереди,
 * тик недели берёт до стольких сайтов (обычно — `maxSites` раннера, 5),
 * чтобы до 06:30 отчёт разделом сводки получило как можно больше сайтов.
 * Время тика (10–25 с) по-прежнему ограничивает проход: модель — только
 * если успевает (`ADMIN_INSIGHT_MIN_CALL_MS`), иначе сухие строки кодом.
 */
export const ADMIN_WEEKLY_SITES_BEFORE_DIGEST = 25;
const INSIGHT_RETENTION_DAYS = 400;
/** Таймаут вызова выводов и минимум остатка тика для него. */
export const ADMIN_INSIGHT_CALL_TIMEOUT_MS = 20_000;
export const ADMIN_INSIGHT_MIN_CALL_MS = 5_000;

export interface AdminWeeklyTickResult {
  week: string | null;
  sites: number;
  reports: number;
  insightsWithModel: number;
  /** Р-З11-В3: сайтов, чей отчёт ждёт раздела сегодняшней сводки. */
  queued: number;
  /** Р-З11-В3: досланных отдельно (получатели без сводки). */
  flushed: number;
}

/** Владелец кабинета или `assistAdmin: owner` (§3.2, У-27). */
export const adminOwner = (m: {
  role: string;
  productRoles: { assistAdmin?: string | null };
}) => m.role === 'owner' || m.productRoles.assistAdmin === 'owner';

@Injectable()
export class AdminWeekly {
  private readonly logger = new Logger(AdminWeekly.name);
  env: NodeJS.ProcessEnv = process.env;
  /** Подмена отправки — только тестами (никогда из env). */
  fetchImpl: FetchLike | undefined;

  /**
   * Р-З11-В3: ожидание сводки — тот же провайдер, что у assist-digest
   * (ключ замка и часы подменяют только тесты).
   */
  readonly digest: AdminWeeklyDigest;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly text: GeminiText,
    @Optional() digest?: AdminWeeklyDigest,
  ) {
    this.digest = digest ?? new AdminWeeklyDigest(prisma, sitesDb);
  }

  /** Неделя к обработке (понедельник прошлой недели) или null — рано. */
  static dueWeek(now: Date): string | null {
    const monday = weekStartOf(now);
    const ready =
      new Date(`${monday}T00:00:00Z`).getTime() +
      ADMIN_WEEKLY_HOUR_UTC * 3_600_000;
    return now.getTime() >= ready ? addDaysIso(monday, -7) : null;
  }

  async tick(p: {
    now: Date;
    deadline: number;
    maxSites: number;
    siteIds?: string[] | null;
  }): Promise<AdminWeeklyTickResult> {
    const out: AdminWeeklyTickResult = {
      week: AdminWeekly.dueWeek(p.now),
      sites: 0,
      reports: 0,
      insightsWithModel: 0,
      queued: 0,
      flushed: 0,
    };
    // Досылка остатка ожиданий — в каждом тике, и вне понедельника.
    try {
      out.flushed = await this.flush(p.deadline, p.siteIds);
    } catch (e) {
      this.logger.error(
        `досылка недели «Админки»: ${(e as Error | null)?.name ?? 'Error'}`,
      );
    }
    const week = out.week;
    if (!week) return out;
    // P2-2: сводка сегодня впереди — сайтов за тик больше.
    const ahead = digestAhead(
      await this.digest.dbNow(),
      await this.digest.digestState(),
    );
    const maxSites = ahead
      ? Math.max(p.maxSites, ADMIN_WEEKLY_SITES_BEFORE_DIGEST)
      : p.maxSites;
    const due = await this.prisma.$queryRawUnsafe<
      Array<{ accountId: string; siteId: string }>
    >(
      `SELECT "accountId", "siteId" FROM "sites"."assist_admin_settings"
        WHERE "adminModeEnabled"
          AND ("weeklyReportWeek" IS NULL OR "weeklyReportWeek" < $1)
          AND ($3::text[] IS NULL OR "siteId" = ANY($3::text[]))
        ORDER BY "siteId" LIMIT $2`,
      week,
      Math.max(1, maxSites),
      p.siteIds ?? null,
    );
    for (const s of due) {
      if (Date.now() >= p.deadline) break;
      // Дедуп сайт × неделя: строку забирает ровно один тик.
      const claimed = await this.sitesDb
        .forAccount(s.accountId)
        .assistAdminSettings.updateMany({
          where: {
            siteId: s.siteId,
            OR: [
              { weeklyReportWeek: null },
              { weeklyReportWeek: { lt: week } },
            ],
          },
          data: { weeklyReportWeek: week },
        });
      if (claimed.count !== 1) continue;
      out.sites++;
      try {
        const r = await this.site(
          s.accountId,
          s.siteId,
          week,
          p.now,
          p.deadline,
        );
        if (r.sent) out.reports++;
        if (r.queued) out.queued++;
        if (r.model) out.insightsWithModel++;
      } catch (e) {
        this.logger.error(
          `неделя «Админки» ${s.siteId}: ${(e as Error | null)?.name ?? 'Error'}`,
        );
      }
    }
    return out;
  }

  /**
   * Р-З11-В3: остаток ожидания сводки — отдельным сообщением, когда сводка,
   * стартовавшая после постановки, прошла (или ждём дольше страховки).
   * Остаток забирается атомарно (`takeRest`) — с разделом сводки не
   * пересечётся. Получатели — те, кто и сейчас владелец «Админки»; отчёт
   * выключили в настройках — не шлём.
   */
  async flush(deadline: number, siteIds?: string[] | null): Promise<number> {
    const rows = await this.digest.pendingRows(siteIds);
    if (!rows.length) return 0;
    // Часы базы — те же, что у замка сводки и `digestPendingAt` (P3-6).
    const now = await this.digest.dbNow();
    const state = await this.digest.digestState();
    let sent = 0;
    for (const r of rows) {
      if (Date.now() >= deadline) break;
      if (!digestPassed(now, r.digestPendingAt, state)) continue;
      const taken = await this.digest.takeRest(r.accountId, r.id);
      const texts = parseWeeklyTexts(r.digestTexts);
      if (!taken.length || !texts) continue;
      try {
        const settings = await this.sitesDb
          .forAccount(r.accountId)
          .assistAdminSettings.findFirst({
            where: { siteId: r.siteId },
            select: { weeklyReport: true },
          });
        if (!settings?.weeklyReport) continue;
        const want = new Set(taken);
        const to = (
          await recipientsWithLang(this.sitesDb, r.accountId, adminOwner)
        ).filter((x) => want.has(x.chatId.toString()));
        sent += await sendToMembersByLang({
          recipients: to,
          texts,
          hashPath: `/sites/${r.siteId}/admin-mode/stats`,
          env: this.env,
          fetchImpl: this.fetchImpl,
        });
      } catch (e) {
        // P3-5: сбой между забором и отправкой — получатели возвращаются в
        // ожидание (следующий тик дошлёт), а не пропадают молча.
        await this.digest
          .releaseMany(r.accountId, r.id, taken)
          .catch(() => undefined);
        this.logger.error(
          `досылка недели «Админки» ${r.siteId}: ${(e as Error | null)?.name ?? 'Error'}, получатели возвращены`,
        );
      }
    }
    return sent;
  }

  /** Выводы старше `INSIGHT_RETENTION_DAYS` — прочь (раз в сутки). */
  async purge(now: Date, siteIds?: string[] | null): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_admin_insights"
        WHERE "weekStart" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      addDaysIso(weekStartOf(now), -INSIGHT_RETENTION_DAYS),
      siteIds ?? null,
    );
  }

  /** Числа недели (`*`-строки свёртки) с понедельника `week`. */
  async totals(
    accountId: string,
    siteId: string,
    week: string,
  ): Promise<AdminWeekTotals> {
    const rows = await this.sitesDb
      .forAccount(accountId)
      .assistAdminDailyStat.findMany({
        where: {
          siteId,
          role: ROLE_TOTAL,
          day: { gte: week, lt: addDaysIso(week, 7) },
        },
      });
    return sumWeek(rows);
  }

  /** Вывод и отчёт одного сайта за неделю `week`. */
  async site(
    accountId: string,
    siteId: string,
    week: string,
    now: Date,
    /** Срок тика (мс эпохи): модель — только если успевает. */
    deadline = Date.now() + 30_000,
  ): Promise<{
    sent: boolean;
    model: boolean;
    findings: AdminFinding[];
    /** Р-З11-В3: получателей, чей отчёт ждёт сводки (0 — ушёл сразу). */
    queued?: number;
  }> {
    const db = this.sitesDb.forAccount(accountId);
    const totals = await this.totals(accountId, siteId, week);
    if (totals.conversations === 0 && totals.questions === 0) {
      return { sent: false, model: false, findings: [] };
    }
    const prev = await this.totals(accountId, siteId, addDaysIso(week, -7));
    const start = new Date(`${week}T00:00:00Z`);
    const end = new Date(`${addDaysIso(week, 7)}T00:00:00Z`);
    const [labels, learningNew, settings, site] = await Promise.all([
      db.assistAdminConversationLabel.findMany({
        where: { siteId, conversationAt: { gte: start, lt: end } },
        select: { taskType: true, answerFound: true, status: true },
        take: 20_000,
      }),
      db.assistAdminLearningItem.count({ where: { siteId, status: 'new' } }),
      db.assistAdminSettings.findFirst({
        where: { siteId },
        select: { weeklyReport: true },
      }),
      db.site.findFirst({ where: { id: siteId }, select: { name: true } }),
    ]);
    const findings = weekFindings({ totals, labels, learningNew });
    const items = findings.length
      ? await this.modelItems(accountId, siteId, findings, now, deadline)
      : null;
    await db.assistAdminInsight.upsert({
      where: { siteId_weekStart: { siteId, weekStart: week } },
      create: {
        accountId,
        siteId,
        weekStart: week,
        findings: findings as unknown as Prisma.InputJsonValue,
        text: items
          ? (items.items as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        model: items?.model ?? null,
        costMicroUsd: items?.cost ?? 0,
      },
      update: {
        findings: findings as unknown as Prisma.InputJsonValue,
        text: items
          ? (items.items as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        model: items?.model ?? null,
        costMicroUsd: items?.cost ?? 0,
      },
    });
    if (!settings?.weeklyReport) {
      return { sent: false, model: !!items, findings };
    }
    const to = await recipientsWithLang(this.sitesDb, accountId, adminOwner);
    const texts = Object.fromEntries(
      ADMIN_REPORT_LANGS.map((lang) => [
        lang,
        weeklyReportText({
          lang,
          siteName: site?.name ?? siteId,
          weekStart: week,
          totals,
          prev: prev.conversations || prev.questions ? prev : null,
          findings,
          items: items?.items ?? null,
        }),
      ]),
    ) as AdminWeeklyTexts;
    // Р-З11-В3: сводка сегодня ещё впереди — отчёт уйдёт её разделом.
    // Часы — базы (P3-6): с ними сравниваются старт и замок сводки.
    const dbNow = to.length ? await this.digest.dbNow() : now;
    if (to.length && digestAhead(dbNow, await this.digest.digestState())) {
      await db.assistAdminInsight.updateMany({
        where: { siteId, weekStart: week },
        data: {
          digestPending: to.map((r) => r.chatId.toString()),
          digestPendingAt: dbNow,
          digestTexts: texts as unknown as Prisma.InputJsonValue,
        },
      });
      return { sent: false, model: !!items, findings, queued: to.length };
    }
    const sent = await sendToMembersByLang({
      recipients: to,
      texts,
      hashPath: `/sites/${siteId}/admin-mode/stats`,
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
    return { sent: sent > 0, model: !!items, findings };
  }

  /** Формулировки моделью — с резервом до вызова; иначе null. */
  private async modelItems(
    accountId: string,
    siteId: string,
    findings: AdminFinding[],
    now: Date,
    deadline: number,
  ): Promise<{
    items: AdminInsightItem[];
    model: string;
    cost: number;
  } | null> {
    const lite = adminLiteModel(this.env);
    if (!lite.ok) return null;
    // Срок тика учитывает длительность вызова (аудит захода 10, P3 (2)):
    // не успевает — сухие строки кодом, без резерва.
    const left = deadline - Date.now() - 1_000;
    if (left < ADMIN_INSIGHT_MIN_CALL_MS) return null;
    const st = await readState(this.prisma, accountId, now);
    if (!st.planId || !ASSIST_PLANS[st.planId].adminRead) return null;
    const rsv = await reserveAdminTurn(this.prisma, {
      siteId,
      siteCapMicroUsd: adminAnalyticsCap(siteDailyCapFromPlan(st.planId)),
      platformCapMicroUsd: effectivePlatformCapMicroUsd(
        widgetPlatformDailyCapMicroUsd(this.env),
        await readWidgetPlatformSettings(this.prisma),
      ),
      estMicroUsd: adminInsightEstimateMicroUsd(lite.model, this.env),
      now,
    });
    if (!rsv.ok) return null;
    const prompt = buildInsightPrompt(findings);
    let actual: number | null = null;
    let raw: string | null = null;
    try {
      const res = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        temperature: 0,
        maxOutputTokens: 1_500,
        timeoutMs: Math.min(ADMIN_INSIGHT_CALL_TIMEOUT_MS, left),
        model: lite.model,
      });
      actual = await recordAdminUsage(this.sitesDb, this.env, {
        accountId,
        siteId,
        operation: ADMIN_INSIGHT_OPERATION,
        spent: res,
      });
      raw = res.text;
    } catch (e) {
      const spent = spentOf(e);
      if (spent) {
        actual = await recordAdminUsage(this.sitesDb, this.env, {
          accountId,
          siteId,
          operation: ADMIN_INSIGHT_OPERATION,
          spent,
        }).catch(() => null);
      } else if (!(e instanceof TextModelError)) {
        await settleAdminTurn(this.prisma, rsv.reservation, null).catch(
          () => undefined,
        );
        throw e;
      } else {
        actual = 0;
      }
    }
    await settleAdminTurn(this.prisma, rsv.reservation, actual).catch(
      () => undefined,
    );
    const items = raw === null ? null : parseInsightItems(raw, findings);
    return items ? { items, model: lite.model, cost: actual ?? 0 } : null;
  }
}
