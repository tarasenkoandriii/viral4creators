/**
 * AI Publisher — месячный потолок AI продукта (P-B2, проектный документ
 * §6.7 `pub_ai_budget_months`, §12.1, Р-PUB-9; аудит P3-13).
 *
 *  - Оценка вызова «сверху» — `estimateCallMicroUsd`: вход — потолок
 *    промпта `MAX_PROMPT_CHARS` (токенов не больше символов), выход —
 *    `geminiOutputCeiling(maxOutputTokens)` (тот же потолок, что уходит
 *    провайдеру). Оценка детерминирована по (модель, генератор): задание
 *    `ai-calls-reap` и финализация освобождают ровно то, что резервировал
 *    старт, не храня оценку отдельно.
 *  - Резерв — условный `UPDATE … WHERE cap − spent − reserved ≥ est`
 *    (как `assist-admin-mode/admin-budget.ts`): параллельные вызовы не
 *    превысят потолок — второй ждёт блокировку строки и перепроверяет
 *    условие на новой версии (EvalPlanQual, READ COMMITTED).
 *  - После ответа резерв заменяется фактом; при неизвестной цене резерв
 *    остаётся оценкой (§12.1) — неизвестное не ноль.
 *
 * Модель без ставки (`unpriced`) — `priced:false` и оценка по наибольшим
 * ставкам прайса (не ноль, аудит S1-4): вызов возможен, только если гейт
 * `ai_use` пропустил (`ai_unpriced_allowed`), резерв остаётся оценкой.
 */
import { MODEL_RATES, estimateCost, rateFor } from '../../../shared/ai-pricing';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';
import type { ProductRef, PubTx } from '../core/ports';

/** Потолок промпта (system + user) в символах — основание оценки сверху. */
export const MAX_PROMPT_CHARS = 120_000;

export interface CallEstimate {
  priced: boolean;
  estMicroUsd: bigint;
}

/**
 * Ставка «сверху» для модели без строки прайса (аудит S1-4, S2-4):
 * наибольшие ставки входа и выхода среди текстовых моделей прайса.
 * Неизвестная цена — не ноль: резерв месяца и потолок прогона считают её.
 */
export function unpricedFallbackRate(): {
  inputPerMTok: number;
  outputPerMTok: number;
} {
  let inputPerMTok = 0;
  let outputPerMTok = 0;
  for (const r of Object.values(MODEL_RATES)) {
    if (r.inputPerMTok === undefined || r.outputPerMTok === undefined) continue;
    inputPerMTok = Math.max(inputPerMTok, r.inputPerMTok);
    outputPerMTok = Math.max(outputPerMTok, r.outputPerMTok);
  }
  return { inputPerMTok, outputPerMTok };
}

export function estimateCallMicroUsd(
  model: string,
  maxOutputTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): CallEstimate {
  const outputTokens = geminiOutputCeiling(maxOutputTokens);
  if (!rateFor(model, env)) {
    const f = unpricedFallbackRate();
    return {
      priced: false,
      estMicroUsd: BigInt(
        Math.ceil(
          (MAX_PROMPT_CHARS * f.inputPerMTok + outputTokens * f.outputPerMTok) /
            1_000_000,
        ),
      ),
    };
  }
  const est = estimateCost(
    model,
    { inputTokens: MAX_PROMPT_CHARS, outputTokens },
    env,
  );
  return { priced: true, estMicroUsd: BigInt(est.costMicroUsd) };
}

export type ReserveResult =
  { ok: true } | { ok: false; reason: 'month_not_open' | 'cap_exhausted' };

/** Резерв оценки в строке месяца (одна инструкция, без чтения агрегатов). */
export async function reserveAiMonth(
  tx: PubTx,
  product: ProductRef,
  month: string,
  est: bigint,
): Promise<ReserveResult> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "sites"."pub_ai_budget_months"
       SET "reservedMicroUsd" = "reservedMicroUsd" + ${est},
           "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "productId" = ${product.id} AND "accountId" = ${product.accountId}
       AND "month" = ${month}
       AND "capMicroUsd" - "spentMicroUsd" - "reservedMicroUsd" >= ${est}
    RETURNING "id"`;
  if (rows.length === 1) return { ok: true };
  const exists = await tx.pubAiBudgetMonth.findFirst({
    where: { productId: product.id, month },
    select: { id: true },
  });
  return { ok: false, reason: exists ? 'cap_exhausted' : 'month_not_open' };
}

/**
 * Замена резерва фактом: `actual` известен — резерв снят, факт в `spent`;
 * `actual = null` и `keepReserve` (цена неизвестна) — резерв остаётся
 * оценкой; иначе (денег провайдер не взял) — резерв просто снят.
 */
export async function settleAiMonth(
  tx: PubTx,
  product: ProductRef,
  month: string,
  est: bigint,
  actual: bigint | null,
  keepReserve = false,
): Promise<void> {
  if (actual === null && keepReserve) return;
  await tx.$executeRaw`
    UPDATE "sites"."pub_ai_budget_months"
       SET "reservedMicroUsd" = GREATEST(0, "reservedMicroUsd" - ${est}),
           "spentMicroUsd" = "spentMicroUsd" + ${actual ?? 0n},
           "revision" = "revision" + 1, "updatedAt" = now()
     WHERE "productId" = ${product.id} AND "accountId" = ${product.accountId}
       AND "month" = ${month}`;
}

/** Остаток месяца (для разрешения третьей генерации, §12.5). */
export async function aiMonthRemaining(
  tx: Pick<PubTx, 'pubAiBudgetMonth'>,
  productId: string,
  month: string,
): Promise<bigint | null> {
  const row = await tx.pubAiBudgetMonth.findFirst({
    where: { productId, month },
    select: { capMicroUsd: true, spentMicroUsd: true, reservedMicroUsd: true },
  });
  if (!row) return null;
  return row.capMicroUsd - row.spentMicroUsd - row.reservedMicroUsd;
}
