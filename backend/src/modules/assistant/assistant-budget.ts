/**
 * П-Г5 (Р-З10-5): атомарный резерв дневного бюджета ИИ-консультанта
 * лендинга. До захода 10 консультант читал «сколько уже потрачено» и
 * решал ДО платного вызова — несколько параллельных вопросов проходили
 * проверку одновременно и все уходили в Gemini, пока строка `AiUsage`
 * первого ещё не записана (TOCTOU, SECURITY-PROPOSALS П-Г5).
 *
 * Схема — «резерв → вызов → снятие», как у `SerpApiUsageService`, но в
 * деньгах и БЕЗ миграции backend:
 *  - транзакция с `pg_advisory_xact_lock` (один замок консультанта; до
 *    захода 11 — на UTC-сутки) сериализует резервы (тот же приём, что
 *    `CreditLedgerService.reserveForGeneration`);
 *  - внутри: потрачено за сутки (`AiUsage`, `operation: 'assistant'`) +
 *    «в полёте» (строки `rate_limits` с ключом
 *    `assistant-budget:<YYYY-MM-DD>:<uuid>`, `count` — оценка в µ$) +
 *    оценка этого вопроса > потолка → отказ; иначе — строка резерва;
 *  - резерв снимается (DELETE своей строки) ПОСЛЕ записи `AiUsage` с
 *    настоящим расходом модели или сразу, если модель не прислала ни одного
 *    токена — между записью и снятием расход посчитан дважды, то есть с
 *    запасом, а не в обратную сторону;
 *  - аудит захода 10 (P2-1): вопрос, оборванный ПОСЛЕ первого токена
 *    (клиент закрыл SSE до `done` — `AiUsage` с расходом не записан),
 *    иначе обходил бы потолок: резерв истекал бы через TTL, и обрывом за
 *    миг до `done` можно было бы тратить без счёта. Такой резерв
 *    превращается в расход до конца UTC-суток (`commitAssistantReserve`:
 *    `windowStart` = конец суток — «в полёте» считает его весь день,
 *    чистка `rate_limits` уберёт через час после полуночи).
 *
 *  - полночь UTC (заход 11, Р-З11-Г6; хвост П-Г5): расход вопроса пишется
 *    в `AiUsage` в момент ответа, то есть в те сутки, когда вопрос
 *    ЗАКОНЧИЛСЯ. Поэтому «в полёте» — живые резервы ЛЮБЫХ суток (вопрос,
 *    начатый в 23:59:50, в 00:00:05 ещё идёт и заплатит новые сутки), а
 *    замок — один на консультанта, не на сутки (резервы 23:59:59 и
 *    00:00:01 больше не идут мимо друг друга). Оборванный вопрос
 *    становится расходом суток ОБРЫВА: строка переименовывается в
 *    `assistant-budget:spent:<сутки обрыва>:<uuid>` (`windowStart` = конец
 *    этих суток) — живым резервом она больше не считается, а расход
 *    вчерашнего обрыва не съедает сегодняшний бюджет. Строки старого
 *    формата (обрыв до выката: ключ суток резерва, `windowStart` = конец
 *    суток) считаются живыми, пока не выйдет TTL от полуночи, — в первые
 *    5 минут после полуночи дня выката запас, а не перерасход.
 *
 * Почему по строке на резерв, а не один счётчик на день (как предлагала
 * инвентаризация): у строки своё время (`windowStart` = момент резерва),
 * и резерв процесса, убитого посреди стрима (таймаут функции Vercel),
 * перестаёт учитываться сам через `ASSISTANT_RESERVE_TTL_MS` — общий
 * счётчик с потерянным «минусом» держал бы бюджет заниженным до конца
 * суток. Хвосты строк убирает штатная чистка `rate_limits` (`pruneRateLimits`,
 * старше часа). В ключе нет ничего о посетителе (Ш0.7).
 */
import { randomUUID } from 'crypto';
import { estimateCost } from '../../common/ai-pricing';
import { startOfDayUtc } from '../../common/spend-limits';
import type { PrismaService } from '../../prisma/prisma.service';

export const ASSISTANT_BUDGET_KEY_PREFIX = 'assistant-budget:';
/** Расход оборванного вопроса: `assistant-budget:spent:<сутки>:<uuid>`. */
export const ASSISTANT_SPENT_KEY_PREFIX = `${ASSISTANT_BUDGET_KEY_PREFIX}spent:`;
/**
 * Замок резервов — один на консультанта (не на сутки): иначе резервы по
 * обе стороны полуночи шли бы параллельно, не видя друг друга.
 */
const ASSISTANT_BUDGET_LOCK = 'assistant-budget';
/**
 * Срок жизни резерва: стрим ≤ 90 с (`DEFAULT_CHAT_TIMEOUTS`) + запись
 * обмена — с запасом. Старше — резерв процесса, который не дожил до
 * снятия; в «в полёте» он больше не идёт.
 */
export const ASSISTANT_RESERVE_TTL_MS = 5 * 60_000;
/** Символов на токен для оценки входа — с запасом (кириллица ≈ 2,5–4). */
const CHARS_PER_TOKEN = 3;

/**
 * Оценка вопроса в µ$ — худший случай по выходу (`maxOutputTokens`) и
 * вход по длине промпта. Не меньше 1 µ$: резерв всегда виден другим.
 */
export function estimateAssistantReserve(
  model: string,
  inputChars: number,
  maxOutputTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { costMicroUsd } = estimateCost(
    model,
    {
      inputTokens: Math.ceil(Math.max(0, inputChars) / CHARS_PER_TOKEN),
      cachedInputTokens: 0,
      outputTokens: maxOutputTokens,
    },
    env,
  );
  return Math.max(1, Math.ceil(costMicroUsd));
}

function dayKey(now: Date): string {
  return startOfDayUtc(now).toISOString().slice(0, 10);
}

/** Ключ расхода оборванного вопроса — сутки обрыва, тот же uuid. */
export function assistantSpentKey(reserveKey: string, now: Date): string {
  const id = reserveKey.slice(reserveKey.lastIndexOf(':') + 1);
  return `${ASSISTANT_SPENT_KEY_PREFIX}${dayKey(now)}:${id}`;
}

export type AssistantReserveResult =
  | { ok: true; key: string }
  | { ok: false; spentMicroUsd: number; inFlightMicroUsd: number };

/**
 * Резерв оценки до вызова модели. `ok: false` — бюджет (с учётом уже
 * зарезервированного другими) не вмещает этот вопрос. Ошибки базы
 * пробрасываются: решает вызывающий (консультант отказывает, не зовёт
 * модель).
 */
export async function reserveAssistantBudget(
  prisma: PrismaService,
  input: { budgetMicroUsd: number; estimateMicroUsd: number; now?: Date },
): Promise<AssistantReserveResult> {
  const now = input.now ?? new Date();
  const day = dayKey(now);
  const since = startOfDayUtc(now);
  const aliveAfter = new Date(now.getTime() - ASSISTANT_RESERVE_TTL_MS);
  const prefix = `${ASSISTANT_BUDGET_KEY_PREFIX}${day}:`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ASSISTANT_BUDGET_LOCK}))`;
    const spent = (await tx.aiUsage.aggregate({
      where: { operation: 'assistant', createdAt: { gte: since } },
      _sum: { costMicroUsd: true },
    })) as { _sum: { costMicroUsd: number | bigint | null } };
    const spentMicroUsd = Number(spent._sum.costMicroUsd ?? 0);
    // «В полёте»: живые резервы любых суток (вопрос через полночь
    // заплатит эти сутки) + расход оборванных в ЭТИ сутки. Одним
    // диапазоном по индексу `windowStart` (аудит P3-8: `OR`/`LIKE` при
    // сортировке не «C» — полный проход `rate_limits` под замком): у
    // расхода этих суток `windowStart` = конец суток > `aliveAfter`, у
    // вчерашнего расхода ключ другого дня — отсекается условием ключа.
    const rows = await tx.$queryRaw<{ s: bigint | number | null }[]>`
      SELECT COALESCE(SUM("count"), 0) AS s FROM "rate_limits"
      WHERE "windowStart" > ${aliveAfter}
        AND "key" LIKE ${`${ASSISTANT_BUDGET_KEY_PREFIX}%`}
        AND ("key" NOT LIKE ${`${ASSISTANT_SPENT_KEY_PREFIX}%`}
             OR "key" LIKE ${`${ASSISTANT_SPENT_KEY_PREFIX}${day}:%`})
    `;
    const inFlightMicroUsd = Number(rows[0]?.s ?? 0);
    if (
      spentMicroUsd + inFlightMicroUsd + input.estimateMicroUsd >
      input.budgetMicroUsd
    ) {
      return { ok: false as const, spentMicroUsd, inFlightMicroUsd };
    }
    const key = `${prefix}${randomUUID()}`;
    // `count` — Int: оценка одного вопроса — тысячи µ$, до потолка Int
    // (≈ 2 147 долларов) далеко; на всякий случай — обрезка.
    const amount = Math.min(input.estimateMicroUsd, 2_000_000_000);
    await tx.$executeRaw`
      INSERT INTO "rate_limits" ("key", "windowStart", "count")
      VALUES (${key}, ${now}, ${amount})
    `;
    return { ok: true as const, key };
  });
}

/** Конец текущих UTC-суток (начало следующих). */
export function endOfDayUtc(now: Date): Date {
  return new Date(startOfDayUtc(now).getTime() + 24 * 3_600_000);
}

/**
 * Резерв оборванного после первого токена вопроса — в расход до конца
 * суток ОБРЫВА (P2-1; Р-З11-Г6: вопрос, начатый вчера и оборванный
 * сегодня, платит сегодня). Никогда не бросает: не вышло — резерв истечёт
 * по TTL.
 */
export async function commitAssistantReserve(
  prisma: PrismaService,
  key: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await prisma.$executeRaw`
      UPDATE "rate_limits"
      SET "key" = ${assistantSpentKey(key, now)}, "windowStart" = ${endOfDayUtc(now)}
      WHERE "key" = ${key}
    `;
    return true;
  } catch {
    return false;
  }
}

/** Снятие резерва. Никогда не бросает: не снялся — истечёт по TTL. */
export async function releaseAssistantBudget(
  prisma: PrismaService,
  key: string,
): Promise<boolean> {
  try {
    await prisma.$executeRaw`DELETE FROM "rate_limits" WHERE "key" = ${key}`;
    return true;
  } catch {
    return false;
  }
}
