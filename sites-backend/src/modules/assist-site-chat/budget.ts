/**
 * Атомарный бюджет ответов — W3 (ТЗ §4.5 «Резерв вместо прочитал-решил» и
 * три уточнения аудита 01.10; приёмка Э2 п.5).
 *
 * Схема (таблицы assist_budget_days, assist_budget_reservations):
 *  1. INSERT строк дня (site:<siteId>, platform:all) ON CONFLICT DO NOTHING;
 *  2. в ОДНОЙ транзакции: условный UPDATE строки сайта
 *     `SET reserved = reserved + :est WHERE spent + reserved + :est <= :cap`
 *     и тот же — строки платформы; 0 строк → откат, отказ (`site_budget` /
 *     `platform_budget`); затем INSERT резерва (id, siteId, day, est,
 *     expiresAt = now + reservationTtlMs). Блокировка строки дня сериализует
 *     гонку — НЕ считать SUM резервов в одном снапшоте (READ COMMITTED
 *     не увидит параллельный резерв).
 *  3. settle(факт): DELETE своей строки резерва RETURNING; если удалена —
 *     `reserved -= est, spent += факт` у обеих строк; если её уже снял крон —
 *     только `spent += факт`. Вызывается тем экземпляром, что генерирует.
 *  4. sweep (крон assist-budget-sweep): DELETE просроченных RETURNING →
 *     `reserved -= Σest` по строкам — каждый резерв вычитается ровно раз.
 * Оценка est — по длине промпта и maxOutputTokens (сверху): перерасход ≤
 * «факт − оценка» одного ответа.
 *
 * Э5 (голос, §4.10): резерв голоса (`voice` в reserve) держит ещё и строку
 * `scope='voice'` сайта — отдельный суточный потолок голоса В ДОПОЛНЕНИЕ к
 * потолкам сайта и платформы (голос тратит общие деньги дня, но не больше
 * своего потолка); отказ — `voice_budget`. Строка резерва помечена
 * `voice=true`: settle и sweep снимают и её.
 *
 * Порядок блокировок везде один — строка голоса сайта (если есть), строки
 * сайтов (по возрастанию ключа), затем строка платформы: резерв, списание и снятие не держат платформу,
 * ожидая сайт, — взаимной блокировки нет. Перед резервом снимаются
 * просроченные резервы ЭТОГО сайта (§4.5 уточнение 2: «до прохода крона
 * они перестают учитываться») — отдельной транзакцией, чтобы отказ
 * резерва не откатил снятие.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import {
  effectivePlatformCapMicroUsd,
  readWidgetPlatformSettings,
} from '../../common/platform-settings';
import { widgetPlatformDailyCapMicroUsd } from '../../config/widget-env';
import type { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import {
  claimUnits,
  releaseUnits,
} from '../assist-billing/public/entitlements';
import type { SubscriptionState } from '../assist-billing/subscription-state';

export type BudgetDenied = 'site_budget' | 'platform_budget' | 'voice_budget';

export interface BudgetReservation {
  id: string;
  siteId: string;
  day: string;
  estMicroUsd: number;
  expiresAt: Date;
  /** Э5: резерв держит и строку голоса сайта. */
  voice?: boolean;
}

/** Клиент — публичный (маршрут виджета) или основной (крон): только сырой SQL и транзакции. */
export type BudgetDb = Pick<
  AssistPublicDb,
  '$queryRawUnsafe' | '$executeRawUnsafe' | '$transaction'
>;

const DAYS = '"sites"."assist_budget_days"';
const RES = '"sites"."assist_budget_reservations"';

/** Ключ строки платформы (scope=platform). */
export const PLATFORM_KEY = 'all';

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function utcPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

class Denied extends Error {
  constructor(readonly kind: BudgetDenied) {
    super(kind);
  }
}

/**
 * Оценка ответа СВЕРХУ (§4.5): вход — каркас, персона, сводка, 6 фрагментов
 * по максимуму, история и вопрос (символы → токены с запасом: 2 символа на
 * токен, кириллица режется мельче латиницы), выход — maxOutputTokens;
 * плюс эмбеддинги вопроса (поиск + перевод) и короткий вызов перевода.
 */
export function answerEstimateMicroUsd(p: {
  systemChars: number;
  historyChars: number;
  questionChars: number;
}): number {
  const sources = 6 * (2_400 + 600);
  const pageAndContext = 1_500;
  const inChars =
    p.systemChars + sources + pageAndContext + p.historyChars + p.questionChars;
  const answer = estimateCost(GEMINI_MODEL, {
    inputTokens: Math.ceil(inChars / 2),
    outputTokens: WIDGET_DEFAULTS.maxOutputTokens,
  }).costMicroUsd;
  const qTokens = Math.ceil(p.questionChars / 2) + 16;
  const embed = estimateCost(KNOWLEDGE_DEFAULTS.embedModel, {
    inputTokens: qTokens * 2,
  }).costMicroUsd;
  const translate = estimateCost(GEMINI_MODEL, {
    inputTokens: qTokens + 200,
    outputTokens: qTokens + 64,
  }).costMicroUsd;
  // Нет ставки (unpriced) — не ноль: резерв обязан что-то держать.
  return Math.max(1_000, Math.ceil(answer + embed + translate));
}

@Injectable()
export class SiteBudget {
  /** Тесты подменяют env (потолок платформы). */
  env: NodeJS.ProcessEnv = process.env;

  async reserve(
    db: BudgetDb,
    p: {
      siteId: string;
      siteCapMicroUsd: number;
      estMicroUsd: number;
      now?: Date;
      /** Э5: резерв голоса — ещё и суточный потолок голоса сайта. */
      voiceCapMicroUsd?: number;
    },
  ): Promise<
    | { ok: true; reservation: BudgetReservation }
    | { ok: false; denied: BudgetDenied }
  > {
    const now = p.now ?? new Date();
    const day = utcDay(now);
    const est = Math.max(1, Math.ceil(p.estMicroUsd));
    const platformCap = effectivePlatformCapMicroUsd(
      widgetPlatformDailyCapMicroUsd(this.env),
      await readWidgetPlatformSettings(db),
    );
    await this.sweep(db, now, p.siteId);
    const voice = p.voiceCapMicroUsd !== undefined;
    await db.$executeRawUnsafe(
      `INSERT INTO ${DAYS} ("scope", "key", "day", "updatedAt")
       VALUES ('site', $1, $2, now()), ('platform', $3, $2, now())${voice ? `, ('voice', $1, $2, now())` : ''}
       ON CONFLICT DO NOTHING`,
      p.siteId,
      day,
      PLATFORM_KEY,
    );
    const reservation: BudgetReservation = {
      id: randomUUID(),
      siteId: p.siteId,
      day,
      estMicroUsd: est,
      expiresAt: new Date(now.getTime() + WIDGET_DEFAULTS.reservationTtlMs),
      ...(voice ? { voice: true } : {}),
    };
    try {
      await db.$transaction(async (tx) => {
        if (voice) {
          const v = await tx.$executeRawUnsafe(
            `UPDATE ${DAYS} SET "reservedMicroUsd" = "reservedMicroUsd" + $3, "updatedAt" = now()
              WHERE "scope" = 'voice' AND "key" = $1 AND "day" = $2
                AND "spentMicroUsd" + "reservedMicroUsd" + $3 <= $4`,
            p.siteId,
            day,
            est,
            Math.max(0, Math.floor(p.voiceCapMicroUsd ?? 0)),
          );
          if (v !== 1) throw new Denied('voice_budget');
        }
        const site = await tx.$executeRawUnsafe(
          `UPDATE ${DAYS} SET "reservedMicroUsd" = "reservedMicroUsd" + $3, "updatedAt" = now()
            WHERE "scope" = 'site' AND "key" = $1 AND "day" = $2
              AND "spentMicroUsd" + "reservedMicroUsd" + $3 <= $4`,
          p.siteId,
          day,
          est,
          Math.max(0, Math.floor(p.siteCapMicroUsd)),
        );
        if (site !== 1) throw new Denied('site_budget');
        const platform = await tx.$executeRawUnsafe(
          `UPDATE ${DAYS} SET "reservedMicroUsd" = "reservedMicroUsd" + $3, "updatedAt" = now()
            WHERE "scope" = 'platform' AND "key" = $1 AND "day" = $2
              AND "spentMicroUsd" + "reservedMicroUsd" + $3 <= $4`,
          PLATFORM_KEY,
          day,
          est,
          platformCap,
        );
        if (platform !== 1) throw new Denied('platform_budget');
        await tx.$executeRawUnsafe(
          `INSERT INTO ${RES} ("id", "siteId", "day", "estMicroUsd", "expiresAt", "voice")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          reservation.id,
          p.siteId,
          day,
          est,
          reservation.expiresAt,
          voice,
        );
      });
    } catch (e) {
      if (e instanceof Denied) return { ok: false, denied: e.kind };
      throw e;
    }
    return { ok: true, reservation };
  }

  async settle(
    db: BudgetDb,
    reservation: BudgetReservation,
    actualMicroUsd: number,
  ): Promise<void> {
    const actual = Number.isFinite(actualMicroUsd)
      ? Math.max(0, Math.round(actualMicroUsd))
      : 0;
    await db.$transaction(async (tx) => {
      const del = await tx.$queryRawUnsafe<Array<{ est: bigint }>>(
        `DELETE FROM ${RES} WHERE "id" = $1 RETURNING "estMicroUsd" AS est`,
        reservation.id,
      );
      // Резерв уже снят кроном (функция жила дольше TTL) — только факт.
      const est = del.length ? Number(del[0].est) : 0;
      const rows: Array<readonly [string, string]> = [
        ...(reservation.voice ? [['voice', reservation.siteId] as const] : []),
        ['site', reservation.siteId],
        ['platform', PLATFORM_KEY],
      ];
      for (const [scope, key] of rows) {
        await tx.$executeRawUnsafe(
          `UPDATE ${DAYS}
              SET "reservedMicroUsd" = GREATEST(0, "reservedMicroUsd" - $4),
                  "spentMicroUsd" = "spentMicroUsd" + $5, "updatedAt" = now()
            WHERE "scope" = $1 AND "key" = $2 AND "day" = $3`,
          scope,
          key,
          reservation.day,
          est,
          actual,
        );
      }
    });
  }

  /**
   * Крон: снять просроченные резервы; возвращает число снятых. `siteId` —
   * только резервы одного сайта (перед новым резервом этого сайта).
   */
  async sweep(db: BudgetDb, now?: Date, siteId?: string): Promise<number> {
    const at = now ?? new Date();
    return db.$transaction(async (tx) => {
      const rows = siteId
        ? await tx.$queryRawUnsafe<
            Array<{ siteId: string; day: string; est: bigint; voice: boolean }>
          >(
            `DELETE FROM ${RES} WHERE "siteId" = $1 AND "expiresAt" <= $2
             RETURNING "siteId", "day", "estMicroUsd" AS est, "voice"`,
            siteId,
            at,
          )
        : await tx.$queryRawUnsafe<
            Array<{ siteId: string; day: string; est: bigint; voice: boolean }>
          >(
            `DELETE FROM ${RES} WHERE "expiresAt" <= $1
             RETURNING "siteId", "day", "estMicroUsd" AS est, "voice"`,
            at,
          );
      if (!rows.length) return 0;
      const bySite = new Map<string, number>();
      const byVoice = new Map<string, number>();
      const byDay = new Map<string, number>();
      for (const r of rows) {
        const k = `${r.siteId}\u0000${r.day}`;
        bySite.set(k, (bySite.get(k) ?? 0) + Number(r.est));
        if (r.voice) byVoice.set(k, (byVoice.get(k) ?? 0) + Number(r.est));
        byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.est));
      }
      const release = (scope: string, key: string, day: string, n: number) =>
        tx.$executeRawUnsafe(
          `UPDATE ${DAYS} SET "reservedMicroUsd" = GREATEST(0, "reservedMicroUsd" - $4), "updatedAt" = now()
            WHERE "scope" = $1 AND "key" = $2 AND "day" = $3`,
          scope,
          key,
          day,
          n,
        );
      for (const k of [...byVoice.keys()].sort()) {
        const [sid, day] = k.split('\u0000');
        await release('voice', sid, day, byVoice.get(k) as number);
      }
      for (const k of [...bySite.keys()].sort()) {
        const [sid, day] = k.split('\u0000');
        await release('site', sid, day, bySite.get(k) as number);
      }
      for (const day of [...byDay.keys()].sort()) {
        await release('platform', PLATFORM_KEY, day, byDay.get(day) as number);
      }
      return rows.length;
    });
  }
}

/**
 * Квота диалогов (§4.5 уточнение 3, §7.1; Э4 — по тарифу КАБИНЕТА): при
 * ответе модели, который засчитывает диалог (первый после открытия или 30
 * минут тишины), и на 31-м/61-м ответе — занять единицы одним условным
 * UPDATE счётчика периода подписки (assist-billing/public/entitlements).
 * Два параллельных «последних» диалога — открывается один. Предпросмотр
 * (site.preview) квоту не тратит — решает вызывающий.
 */
@Injectable()
export class DialogQuota {
  async claim(
    db: BudgetDb,
    p: {
      accountId: string;
      state: SubscriptionState;
      units: number;
      dialogs: number;
    },
  ): Promise<boolean> {
    return claimUnits(db, p);
  }

  async release(
    db: BudgetDb,
    p: {
      accountId: string;
      state: SubscriptionState;
      units: number;
      dialogs: number;
    },
  ): Promise<void> {
    if (!p.state.periodKey) return;
    await releaseUnits(db, {
      accountId: p.accountId,
      periodKey: p.state.periodKey,
      units: p.units,
      dialogs: p.dialogs,
    });
  }
}
