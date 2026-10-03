/**
 * Публичная сторона Э3-бис — связанный режим (согласие), эксперименты,
 * поведение (ТЗ §5-тер.2, §5-тер.8–10; решения «Э3-бис — сделано»).
 * ТОЛЬКО AssistPublicDb (assist_public, колоночные GRANT миграции
 * `_assist_ai_analytics`); маршруты — assist-widget (`/widget/v1/exp`,
 * `/widget/v1/pv`, `/widget/v1/visit`, `/widget/v1/ref`).
 *
 * Согласие (§5-тер.9, Р-47): всё здесь — только для посетителя, давшего
 * согласие на аналитику баннеру сайта (`V4CAssist('consent', { analytics:
 * true })` или Google Consent Mode, если владелец включил); GPC/DNT —
 * «без согласия» (решает чанк загрузчика: без согласия он ничего сюда не
 * шлёт, а сервер без ключа визита ничего не принимает). Ключ визита из
 * браузера в базу не пишется — только `visitHash` (sha256 с секретом
 * платформы и солью сайта): выгрузка одного сайта не сопоставима с другим.
 *
 * Конфиг загрузчика (`analytics`) отдаётся, только если владелец включил
 * связанный режим и тариф его разрешает (`linkedWindowDays > 0`, Business+):
 * без него чанк `ana.js` не грузится вовсе (ноль запросов, ноль записей).
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { widgetIpSecret } from '../../../config/widget-env';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { ASSIST_PLANS, type AssistPlanId } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { refSecret } from '../ai/ai-env';
import { effectiveAnalyticsConfig } from '../analytics-config';
import { armOf, VISIT_KEY_RE } from '../exp/experiment-math';
import { pathMatchesMask } from '../goal-types';
import {
  DEFAULT_EXCLUDED_BEHAVIOR_PATHS,
  sourceCategory,
  uaFamily,
  type PageViewInput,
} from './page-view';

const DAY = 24 * 60 * 60 * 1000;
/** `V4CAssist('ref')` живёт столько (вебхук заказа приходит после оплаты). */
export const REF_TTL_MS = 2 * DAY;
/** Квота поведения сверяется с базой не чаще (§5-тер.10 «приблизительно»). */
const QUOTA_CACHE_MS = 60_000;

export interface PublicExperiment {
  id: string;
  kind: 'holdout' | 'greeting' | 'suggestions';
  share: number;
  salt: string;
  goalKey: string;
  variant: unknown;
}

/** Фрагмент конфига загрузчика (WidgetPublicConfig.analytics). */
export interface WidgetAnalyticsPublic {
  /** Связанный режим включён: чанк слушает `V4CAssist('consent')`. */
  consent: { gcm: boolean };
  /** Поведение страниц (bf.js) — только с согласием посетителя. */
  behavior: boolean;
  experiment: {
    id: string;
    kind: PublicExperiment['kind'];
    share: number;
    salt: string;
    variant: unknown;
  } | null;
}

/** Хеш ключа визита: секрет платформы + соль сайта; сырой ключ не хранится. */
export function visitHashOf(
  siteId: string,
  ipSalt: string | null,
  v: string,
): string {
  return createHash('sha256')
    .update(`${widgetIpSecret() ?? ''}:${ipSalt ?? ''}:${siteId}:v:${v}`)
    .digest('hex')
    .slice(0, 32);
}

const b64 = (b: Buffer) => b.toString('base64url');

/** Непрозрачная ссылка на визит для вебхука заказа (§5-тер.1 `assistRef`). */
export function issueRef(
  siteId: string,
  visitHash: string,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = refSecret(env);
  if (!secret) return null;
  const exp = Math.floor((now.getTime() + REF_TTL_MS) / 1000);
  const body = `${exp}.${visitHash}`;
  const sig = createHmac('sha256', secret).update(`${siteId}.${body}`).digest();
  return `r1.${body}.${b64(sig.subarray(0, 18))}`;
}

/** Проверка ref: подпись этого сайта и срок → visitHash, иначе null. */
export function verifyRef(
  siteId: string,
  ref: unknown,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof ref !== 'string' || ref.length > 120) return null;
  const m = /^r1\.(\d{9,11})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{24})$/.exec(ref);
  const secret = refSecret(env);
  if (!m || !secret) return null;
  if (Number(m[1]) * 1000 < now.getTime()) return null;
  const want = createHmac('sha256', secret)
    .update(`${siteId}.${m[1]}.${m[2]}`)
    .digest()
    .subarray(0, 18);
  const got = Buffer.from(m[3], 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return m[2];
}

export function validVisitKey(v: unknown): v is string {
  return typeof v === 'string' && VISIT_KEY_RE.test(v);
}

@Injectable()
export class AiIntake {
  private readonly logger = new Logger(AiIntake.name);
  env: NodeJS.ProcessEnv = process.env;
  private readonly quota = new Map<string, { at: number; used: number }>();

  constructor(readonly db: AssistPublicDb) {}

  /** Идущий эксперимент сайта (колонки роли) или null. */
  async runningExperiment(
    siteId: string,
    now: Date,
  ): Promise<PublicExperiment | null> {
    const rows = await this.db.$queryRawUnsafe<
      Array<PublicExperiment & { endsAt: Date }>
    >(
      `SELECT "id", "kind", "share", "salt", "goalKey", "variant", "endsAt"
         FROM "sites"."assist_site_experiments"
        WHERE "siteId" = $1 AND "status" = 'running' AND "startedAt" <= $2 AND "endsAt" > $2
        ORDER BY "startedAt" DESC LIMIT 1`,
      siteId,
      now,
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          kind: r.kind,
          share: Number(r.share),
          salt: r.salt,
          goalKey: r.goalKey,
          variant: r.variant ?? null,
        }
      : null;
  }

  /** Тариф кабинета → права Э3-бис (null — тарифа нет). */
  async planOf(accountId: string, now: Date): Promise<AssistPlanId | null> {
    const st = await readState(this.db, accountId, now);
    return st.planId;
  }

  /** Конфиг загрузчика: только при связанном режиме и тарифе с ним. */
  async publicAnalytics(
    site: { siteId: string; accountId: string; analytics: unknown },
    now: Date,
  ): Promise<WidgetAnalyticsPublic | null> {
    const cfg = effectiveAnalyticsConfig(site.analytics);
    if (!cfg.linked) return null;
    const planId = await this.planOf(site.accountId, now);
    const plan = planId ? ASSIST_PLANS[planId] : null;
    if (!plan || plan.linkedWindowDays <= 0) return null;
    const exp = plan.experiments
      ? await this.runningExperiment(site.siteId, now)
      : null;
    return {
      consent: { gcm: cfg.linkedGcm },
      behavior:
        cfg.behavior &&
        plan.behaviorViewsPerMonth > 0 &&
        !(await this.quotaOut(site.accountId, plan.behaviorViewsPerMonth, now)),
      experiment: exp
        ? {
            id: exp.id,
            kind: exp.kind,
            share: exp.share,
            salt: exp.salt,
            variant: exp.variant,
          }
        : null,
    };
  }

  /**
   * Включение посетителя с согласием в эксперимент: группа считается здесь
   * заново (клиенту не верим), единица — `visitHash`. Повтор — без дубля.
   */
  async enroll(p: {
    site: {
      siteId: string;
      accountId: string;
      ipSalt: string | null;
      analytics: unknown;
    };
    experimentId: string;
    v: string;
    now: Date;
  }): Promise<'enrolled' | 'ignored'> {
    if (!validVisitKey(p.v) || typeof p.experimentId !== 'string') {
      return 'ignored';
    }
    const cfg = effectiveAnalyticsConfig(p.site.analytics);
    if (!cfg.linked) return 'ignored';
    const exp = await this.runningExperiment(p.site.siteId, p.now);
    if (!exp || exp.id !== p.experimentId) return 'ignored';
    const planId = await this.planOf(p.site.accountId, p.now);
    if (!planId || !ASSIST_PLANS[planId].experiments) return 'ignored';
    const arm = armOf(exp.salt, p.v, exp.share);
    const unitHash = visitHashOf(p.site.siteId, p.site.ipSalt, p.v);
    // Без цели конфликта: у роли нет SELECT на всю строку (как сигналы L).
    await this.db.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_site_experiment_units"
         ("experimentId", "unitHash", "arm", "enrolledAt")
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      exp.id,
      unitHash,
      arm,
      p.now,
    );
    return 'enrolled';
  }

  /**
   * Конверсия основной цели у единицы идущего эксперимента (раз; только
   * после включения). Зовут приём целей (loader/iframe/builtin) и вебхук.
   */
  async markConversion(p: {
    siteId: string;
    goalKey: string;
    visitHash: string;
    at: Date;
  }): Promise<boolean> {
    const n = await this.db.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_experiment_units" u
          SET "converted" = true, "convertedAt" = $4
         FROM "sites"."assist_site_experiments" e
        WHERE e."id" = u."experimentId" AND e."siteId" = $1 AND e."status" = 'running'
          AND e."goalKey" = $2 AND u."unitHash" = $3 AND NOT u."converted"
          AND u."enrolledAt" <= $4 AND e."endsAt" > $4`,
      p.siteId,
      p.goalKey,
      p.visitHash,
      p.at,
    );
    return n > 0;
  }

  /** Связанный режим: диалог этого посетителя ↔ визит (только колонка visitHash). */
  async linkVisit(p: {
    site: {
      siteId: string;
      ipSalt: string | null;
      analytics: unknown;
      accountId: string;
    };
    conversationId: string;
    visitorId: string;
    v: string;
    now: Date;
  }): Promise<boolean> {
    if (!validVisitKey(p.v)) return false;
    if (!effectiveAnalyticsConfig(p.site.analytics).linked) return false;
    const planId = await this.planOf(p.site.accountId, p.now);
    if (!planId || ASSIST_PLANS[planId].linkedWindowDays <= 0) return false;
    const n = await this.db.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_conversations" SET "visitHash" = $4
        WHERE "id" = $1 AND "siteId" = $2 AND "visitorId" = $3
          AND ("visitHash" IS NULL OR "visitHash" <> $4)`,
      p.conversationId,
      p.site.siteId,
      p.visitorId,
      visitHashOf(p.site.siteId, p.site.ipSalt, p.v),
    );
    return n > 0;
  }

  /**
   * Последний диалог визита с ответом помощника в окне атрибуции — для
   * «с участием» на другой странице (§5-тер.2, только связанный режим).
   */
  async linkedConversation(p: {
    siteId: string;
    visitHash: string;
    windowDays: number;
    at: Date;
  }): Promise<string | null> {
    if (p.windowDays <= 0) return null;
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT c."id" FROM "sites"."assist_site_conversations" c
        WHERE c."siteId" = $1 AND c."visitHash" = $2 AND NOT c."suspicious"
          AND c."createdAt" <= $3 AND c."lastMessageAt" >= $4
          AND EXISTS (SELECT 1 FROM "sites"."assist_site_messages" m
                       WHERE m."conversationId" = c."id" AND m."role" = 'assistant'
                         AND m."answerPath" IN ('model', 'faq', 'cache')
                         AND m."streamState" IN ('complete', 'partial'))
        ORDER BY c."lastMessageAt" DESC LIMIT 1`,
      p.siteId,
      p.visitHash,
      p.at,
      new Date(p.at.getTime() - p.windowDays * DAY),
    );
    return rows[0]?.id ?? null;
  }

  /** Окно связанного режима сайта (настройка, не больше тарифа); 0 — выкл. */
  async linkedWindow(
    site: { accountId: string; analytics: unknown },
    now: Date,
  ): Promise<number> {
    const cfg = effectiveAnalyticsConfig(site.analytics);
    if (!cfg.linked) return 0;
    const planId = await this.planOf(site.accountId, now);
    const max = planId ? ASSIST_PLANS[planId].linkedWindowDays : 0;
    return Math.min(cfg.linkedWindowDays, max);
  }

  // ── поведение (§5-тер.8–10) ──────────────────────────────────────────

  private async quotaOut(
    accountId: string,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    const c = this.quota.get(accountId);
    if (c && now.getTime() - c.at < QUOTA_CACHE_MS) return c.used >= limit;
    const [r] = await this.db.$queryRawUnsafe<Array<{ n: bigint | null }>>(
      `SELECT sum(ec."count") AS n FROM "sites"."assist_site_event_counts" ec
         JOIN "sites"."assist_sites" a ON a."siteId" = ec."siteId"
        WHERE a."accountId" = $1 AND ec."kind" = 'bf_pv' AND ec."day" >= $2`,
      accountId,
      `${now.toISOString().slice(0, 7)}-01`,
    );
    const used = Number(r?.n ?? 0);
    this.quota.set(accountId, { at: now.getTime(), used });
    return used >= limit;
  }

  /**
   * Итог просмотра: только связанный режим + поведение у владельца + тариф
   * + квота; исключённые пути — молча мимо. Первый итог pvId — вставка и
   * счётчик квоты; повтор (вкладку скрыли ещё раз) — перезапись метрик.
   */
  async pageView(p: {
    site: { siteId: string; accountId: string; analytics: unknown };
    ownHost: string | null;
    input: PageViewInput;
    userAgent: string | undefined;
    now: Date;
  }): Promise<'recorded' | 'updated' | 'ignored'> {
    const cfg = effectiveAnalyticsConfig(p.site.analytics);
    if (!cfg.linked || !cfg.behavior) return 'ignored';
    const planId = await this.planOf(p.site.accountId, p.now);
    const plan = planId ? ASSIST_PLANS[planId] : null;
    if (
      !plan ||
      plan.behaviorViewsPerMonth <= 0 ||
      plan.linkedWindowDays <= 0
    ) {
      return 'ignored';
    }
    const i = p.input;
    const excluded = [...DEFAULT_EXCLUDED_BEHAVIOR_PATHS, ...cfg.excludedPaths];
    if (excluded.some((m) => pathMatchesMask(i.path, m))) return 'ignored';
    const ua = uaFamily(p.userAgent);
    const metrics = [
      i.scrollMax,
      i.activeMs,
      i.totalMs,
      i.clicks,
      i.rageClicks,
      i.jsErrors,
      i.errorGroups.length ? JSON.stringify(i.errorGroups) : null,
      i.formStarted,
      i.formSubmitted,
      i.formAbandonField,
      i.formInvalid,
      i.backNav,
      i.lcpMs,
      i.inpMs,
      i.cls,
      i.chatOpened,
    ];
    const upd = await this.db.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_page_views"
          SET "scrollMax" = GREATEST("scrollMax", $3), "activeMs" = $4, "totalMs" = $5,
              "clicks" = $6, "rageClicks" = $7, "jsErrors" = $8, "errorGroups" = $9::jsonb,
              "formStarted" = $10, "formSubmitted" = $11, "formAbandonField" = $12,
              "formInvalid" = $13, "backNav" = $14, "lcpMs" = $15, "inpMs" = $16,
              "cls" = $17, "chatOpened" = $18, "updatedAt" = now()
        WHERE "siteId" = $1 AND "id" = $2`,
      p.site.siteId,
      i.pv,
      ...metrics,
    );
    if (upd > 0) return 'updated';
    if (
      await this.quotaOut(p.site.accountId, plan.behaviorViewsPerMonth, p.now)
    ) {
      return 'ignored';
    }
    const n = await this.db.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_site_page_views"
         ("id", "siteId", "day", "startedAt", "path", "prevPath", "source", "refHost",
          "utmCampaign", "device", "os", "browser",
          "scrollMax", "activeMs", "totalMs", "clicks", "rageClicks", "jsErrors", "errorGroups",
          "formStarted", "formSubmitted", "formAbandonField", "formInvalid", "backNav",
          "lcpMs", "inpMs", "cls", "chatOpened", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23, $24,
               $25, $26, $27, $28, now())
       ON CONFLICT DO NOTHING`,
      i.pv,
      p.site.siteId,
      p.now.toISOString().slice(0, 10),
      new Date(p.now.getTime() - i.totalMs),
      i.path,
      i.prevPath,
      sourceCategory(i.refHost, i.utmMedium, p.ownHost),
      i.refHost === p.ownHost ? null : i.refHost,
      i.utmCampaign,
      i.device,
      ua.os,
      ua.browser,
      ...metrics,
    );
    if (n > 0) {
      await this.db.$executeRaw(Prisma.sql`
        INSERT INTO "sites"."assist_site_event_counts" ("siteId", "day", "kind", "key", "hour", "count")
        VALUES (${p.site.siteId}, ${p.now.toISOString().slice(0, 10)}, 'bf_pv', '', ${p.now.getUTCHours()}, 1)
        ON CONFLICT ("siteId", "day", "kind", "key", "hour") DO UPDATE
          SET "count" = "sites"."assist_site_event_counts"."count" + 1`);
      const c = this.quota.get(p.site.accountId);
      if (c) c.used++;
      return 'recorded';
    }
    return 'ignored';
  }

  /** Лог без данных посетителя: только id сайта и код. */
  note(siteId: string, what: string): void {
    this.logger.log(`ana site=${siteId} ${what}`);
  }
}
