/**
 * Приём s2s-события цели — A (см. goal-webhook.controller.ts). Основная
 * роль; дедуп (siteId, goalId, orderId); слияние с page-событием загрузчика
 * того же заказа; возвраты. В лог — id сайта и код, без orderId и сумм.
 *
 * Порядок проверок (уточнение A): подпись (401 одинаково для «нет сайта /
 * нет секрета / нет подписи / старая / чужая» — не оракул) → лимит сайта
 * (429) → Idempotency-Key (400) → тело (400) → orderId (422) → цель
 * (неизвестная/на паузе/без детектора s2s|crm — 400 WEBHOOK_BODY_INVALID:
 * бэкенд заказчика должен узнать об ошибке настройки, подпись уже доказала,
 * что это он).
 *
 * Слияние (§5-тер.1 «Дедуп и доверие», §5-тер.16 п.5):
 *  - то же orderId у page-события (js с orderId) — строка одна по
 *    уникальному ключу: поднимаем доверие до verified, сумма — из вебхука;
 *  - у page-события orderId нет (URL «спасибо») — ближайшее по времени
 *    page-событие той же цели без orderId в окне ±30 мин, ещё не слитое,
 *    сливается в verified (атрибуция, диалог и путь — из page-события: он
 *    знает визит). Обратный порядок (страница после вебхука) роль виджета
 *    сама не сольёт (у неё нет SELECT) — это делает свёртка
 *    (`mergePendingPageEvents`, каждые 10 мин).
 * Повтор `completed` с тем же ключом — `duplicate`; `refunded|cancelled`
 * по учтённому orderId — статус меняется (`updated`), свёртка вычитает.
 */
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import { PrismaService } from '../../prisma/prisma.service';
import { analyticsError } from './analytics-errors';
import type { GoalWebhookEvent, GoalWebhookResult } from './api-types';
import {
  CURRENCY,
  GOAL_KEY,
  storedDetectors,
  validGoalValue,
  validOrderId,
} from './goal-types';
import { IntegrationsService } from './integrations.service';
import { dayInTz, siteTz } from './site-time';
import { AnalyticsRollup } from './system/analytics-rollup.service';
import { verifyGoalWebhook } from './webhook-signature';

const STATUSES = ['completed', 'refunded', 'cancelled'] as const;
const BODY_KEYS = [
  'goalKey',
  'orderId',
  'value',
  'currency',
  'status',
  'occurredAt',
  'assistGroup',
  'assistRef',
];
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

type Db = Pick<PrismaService, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/** Разбор тела вебхука: белый список полей, типы, даты. */
export function parseWebhookEvent(
  raw: string,
):
  | { ok: true; ev: GoalWebhookEvent; occurredAt: Date }
  | { ok: false; orderIdInvalid?: boolean } {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false };
  const b = o as Record<string, unknown>;
  if (Object.keys(b).some((k) => !BODY_KEYS.includes(k))) return { ok: false };
  if (typeof b.goalKey !== 'string' || !GOAL_KEY.test(b.goalKey)) {
    return { ok: false };
  }
  if (typeof b.orderId !== 'string') return { ok: false };
  if (!(STATUSES as readonly unknown[]).includes(b.status))
    return { ok: false };
  if (typeof b.occurredAt !== 'string' || !ISO.test(b.occurredAt)) {
    return { ok: false };
  }
  const occurredAt = new Date(b.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return { ok: false };
  if (b.value !== undefined && b.value !== null && !validGoalValue(b.value)) {
    return { ok: false };
  }
  if (
    b.currency !== undefined &&
    b.currency !== null &&
    (typeof b.currency !== 'string' || !CURRENCY.test(b.currency))
  ) {
    return { ok: false };
  }
  if (!validOrderId(b.orderId)) return { ok: false, orderIdInvalid: true };
  return {
    ok: true,
    occurredAt,
    ev: {
      goalKey: b.goalKey,
      orderId: b.orderId,
      value: (b.value as number | null | undefined) ?? null,
      currency: (b.currency as string | null | undefined) ?? null,
      status: b.status as GoalWebhookEvent['status'],
      occurredAt: b.occurredAt,
    },
  };
}

/**
 * Слить page-событие той же цели без orderId (±30 мин) в verified-строку.
 * Один UPDATE … FROM (DELETE … RETURNING): page-строка исчезает, её
 * атрибуция/диалог/путь переходят в verified. true — слили.
 */
export async function mergeNearestPage(
  db: Db,
  verifiedId: string,
): Promise<boolean> {
  const win = Math.round(ANALYTICS_DEFAULTS.mergeWindowMs / 1000);
  const n = await db.$executeRawUnsafe(
    `WITH v AS (
       SELECT "id", "siteId", "goalId", "occurredAt"
         FROM "sites"."assist_site_goal_events"
        WHERE "id" = $1 AND "trust" = 'verified'
     ),
     p AS (
       SELECT e."id" FROM "sites"."assist_site_goal_events" e, v
        WHERE e."siteId" = v."siteId" AND e."goalId" = v."goalId"
          AND e."trust" = 'page' AND e."orderId" IS NULL
          AND e."occurredAt" BETWEEN v."occurredAt" - ($2::int * interval '1 second')
                                 AND v."occurredAt" + ($2::int * interval '1 second')
        ORDER BY abs(extract(epoch FROM e."occurredAt" - v."occurredAt")), e."id"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     ),
     d AS (
       DELETE FROM "sites"."assist_site_goal_events" e USING p
        WHERE e."id" = p."id"
        RETURNING e."attribution", e."conversationId", e."assist", e."path"
     )
     UPDATE "sites"."assist_site_goal_events" t
        SET "attribution" = CASE WHEN d."attribution" IN ('direct', 'assisted', 'unassisted')
                                 THEN d."attribution" ELSE t."attribution" END,
            "conversationId" = COALESCE(t."conversationId", d."conversationId"),
            "assist" = COALESCE(t."assist", d."assist"),
            "path" = COALESCE(t."path", d."path")
       FROM d
      WHERE t."id" = $1`,
    verifiedId,
    win,
  );
  return n > 0;
}

@Injectable()
export class GoalWebhookService {
  private readonly logger = new Logger(GoalWebhookService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    @Optional() private readonly rollup?: AnalyticsRollup,
  ) {}

  private unauthorized() {
    return analyticsError(
      HttpStatus.UNAUTHORIZED,
      'SIGNATURE_INVALID',
      'Подпись не прошла проверку',
    );
  }

  async receive(p: {
    siteId: string;
    rawBody: string;
    signature: string | undefined;
    idempotencyKey: string | undefined;
  }): Promise<GoalWebhookResult> {
    const raw = typeof p.rawBody === 'string' ? p.rawBody : '';
    if (
      Buffer.byteLength(raw, 'utf8') > ANALYTICS_DEFAULTS.webhookBodyMaxBytes
    ) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'WEBHOOK_BODY_INVALID',
        'Тело больше 4 КБ',
      );
    }
    const secret = await this.integrations.webhookSecret(p.siteId);
    const now = this.now();
    if (
      !secret ||
      verifyGoalWebhook(
        secret,
        raw,
        p.signature,
        Math.floor(now.getTime() / 1000),
      ) !== 'ok'
    ) {
      this.logger.warn(
        `вебхук целей: подпись отклонена (site ${safeId(p.siteId)})`,
      );
      throw this.unauthorized();
    }
    const site = await this.prisma.assistSite.findUnique({
      where: { siteId: p.siteId },
      select: { accountId: true, siteId: true, timezone: true },
    });
    if (!site) throw this.unauthorized();
    if (!(await this.rateOk(site.siteId, now))) {
      throw analyticsError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Слишком много событий — повторите позже',
      );
    }
    const key =
      typeof p.idempotencyKey === 'string' ? p.idempotencyKey.trim() : '';
    if (!key) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Нужен заголовок Idempotency-Key (= orderId)',
      );
    }
    const parsed = parseWebhookEvent(raw);
    if (!parsed.ok) {
      if (parsed.orderIdInvalid) {
        throw analyticsError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'GOAL_ORDER_ID_INVALID',
          'orderId похож на контакт или не того формата',
        );
      }
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'WEBHOOK_BODY_INVALID',
        'Тело события не той формы',
      );
    }
    const ev = parsed.ev;
    if (key !== ev.orderId) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key должен совпадать с orderId',
      );
    }
    const goal = await this.prisma.assistSiteGoal.findUnique({
      where: { siteId_key: { siteId: site.siteId, key: ev.goalKey } },
      select: {
        id: true,
        template: true,
        detectors: true,
        valueMode: true,
        fixedValue: true,
        currency: true,
        status: true,
      },
    });
    const kinds = goal ? storedDetectors(goal.detectors, goal.template) : [];
    if (
      !goal ||
      goal.status === 'paused' ||
      !kinds.some((d) => d.kind === 's2s' || d.kind === 'crm')
    ) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'WEBHOOK_BODY_INVALID',
        'Цель с этим ключом не принимает события сервера',
      );
    }
    const source = kinds.some((d) => d.kind === 's2s') ? 's2s' : 'crm';
    const value =
      goal.valueMode === 'none'
        ? null
        : (ev.value ?? (goal.valueMode === 'fixed' ? goal.fixedValue : null));
    const currency = value === null ? null : (ev.currency ?? goal.currency);

    const result = await this.apply({
      timezone: site.timezone,
      accountId: site.accountId,
      siteId: site.siteId,
      goalId: goal.id,
      source,
      ev,
      occurredAt: parsed.occurredAt,
      value,
      currency,
      now,
    });
    await this.integrations.touchWebhook(site.siteId);
    this.logger.log(`вебхук целей: ${result} (site ${site.siteId})`);
    return { result };
  }

  private async apply(p: {
    timezone: string;
    accountId: string;
    siteId: string;
    goalId: string;
    source: 's2s' | 'crm';
    ev: GoalWebhookEvent;
    occurredAt: Date;
    value: Prisma.Decimal | number | null;
    currency: string | null;
    now: Date;
  }): Promise<GoalWebhookResult['result']> {
    const where = {
      siteId_goalId_orderId: {
        siteId: p.siteId,
        goalId: p.goalId,
        orderId: p.ev.orderId,
      },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.prisma.assistSiteGoalEvent.findUnique({
        where,
        select: { id: true, trust: true, status: true, occurredAt: true },
      });
      if (existing) {
        if (p.ev.status !== 'completed') {
          if (existing.status === p.ev.status) return 'duplicate';
          await this.prisma.assistSiteGoalEvent.update({
            where: { id: existing.id },
            data: { status: p.ev.status },
            select: { id: true },
          });
          await this.rerollDay(p.siteId, p.timezone, existing.occurredAt);
          return 'updated';
        }
        if (existing.trust === 'verified') return 'duplicate';
        // page-событие с тем же orderId (js) — поднять до verified.
        await this.prisma.assistSiteGoalEvent.update({
          where: { id: existing.id },
          data: {
            trust: 'verified',
            source: p.source,
            value: p.value,
            currency: p.currency,
            status: 'completed',
          },
          select: { id: true },
        });
        return 'merged';
      }
      const id = randomUUID();
      const r = await this.prisma.assistSiteGoalEvent.createMany({
        data: [
          {
            id,
            accountId: p.accountId,
            siteId: p.siteId,
            goalId: p.goalId,
            occurredAt: p.occurredAt,
            receivedAt: p.now,
            source: p.source,
            trust: 'verified',
            orderId: p.ev.orderId,
            value: p.value,
            currency: p.currency,
            status: p.ev.status,
            attribution: 'unknown',
          },
        ],
        skipDuplicates: true,
      });
      // Гонка двух одинаковых вебхуков: второй увидит строку на повторе.
      if (r.count === 0) continue;
      if (
        p.ev.status === 'completed' &&
        (await mergeNearestPage(this.prisma, id))
      ) {
        return 'merged';
      }
      return 'created';
    }
    return 'duplicate';
  }

  /**
   * Возврат приходит через дни и недели после заказа, а кроны пересчитывают
   * только сегодня/вчера/позавчера: без пересчёта дня ЗАКАЗА вычет в
   * свёртке не случился бы никогда (§5-тер.16 п.4). Пересчёт дня целиком
   * идемпотентен; сбой — только в лог (событие уже записано).
   */
  private async rerollDay(
    siteId: string,
    timezone: string,
    occurredAt: Date,
  ): Promise<void> {
    if (!this.rollup) return;
    try {
      await this.rollup.rollupDay(
        siteId,
        dayInTz(occurredAt, siteTz(timezone)),
      );
    } catch (e) {
      this.logger.warn(
        `вебхук целей: пересчёт дня не удался (site ${siteId}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
    }
  }

  /** 120 событий в минуту на сайт (§6 контракта) — окно в assist_rate_buckets. */
  private async rateOk(siteId: string, now: Date): Promise<boolean> {
    const win = 60_000;
    const start = Math.floor(now.getTime() / win) * win;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
       VALUES ('goal-webhook-site-min', $1, $2, 1, $3)
       ON CONFLICT ("scope", "key", "bucket") DO UPDATE
         SET "count" = "sites"."assist_rate_buckets"."count" + 1
         WHERE "sites"."assist_rate_buckets"."count" < $4
       RETURNING "count"`,
      siteId,
      new Date(start).toISOString(),
      new Date(start + win),
      ANALYTICS_DEFAULTS.webhooksPerSitePerMinute,
    );
    return rows.length > 0;
  }
}

/** id сайта из URL — в лог только безопасные символы. */
function safeId(v: string): string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : '?';
}
