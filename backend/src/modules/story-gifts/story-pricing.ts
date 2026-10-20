/**
 * Р-ST3-2: price of a paid Story step in platform credits. Pure functions.
 *
 *   P = max(floor, reserveUsd / (1 − f − m))
 *
 * - `reserveUsd` — the conservative provider reserve of the step
 *   (story-budget.ts: 4× TTS + assembly + QA), not the expected cost;
 * - `f` — fee of the most expensive payment channel. Telegram Stars: the
 *   code and docs have no number (ТЗ TMA §7.1: «Stars — существенно больше,
 *   ПРОВЕРИТЬ»), so the brief's 0.30 is used;
 * - `m` — margin 0.5; `floor` — $2.99.
 *
 * P is converted to credits at the CHEAPEST real price of one credit among
 * the credit packs and channels (`creditPacks`, `estimateAmountMicroUsd`) and
 * rounded up: whichever pack the buyer used, the credits cover P.
 */
import {
  creditPacks,
  estimateAmountMicroUsd,
} from '../../common/billing-pricing';

export const STORY_PRICE_FLOOR_MICRO_USD = 2_990_000;
export const STORY_PRICE_CHANNEL_FEE = 0.3;
export const STORY_PRICE_MARGIN = 0.5;

export interface StoryChargeView {
  credits: number;
  /** Credits × the cheapest credit price, USD (what the buyer pays at best). */
  usdEquivalent: number;
  /** The member's free first gift. */
  free: boolean;
}

export const STORY_CHARGE_NONE: StoryChargeView = Object.freeze({
  credits: 0,
  usdEquivalent: 0,
  free: false,
}) as StoryChargeView;

/** Price in micro-USD of a step with the given provider reserve. */
export function storyPriceMicroUsd(reserveMicroUsd: number): number {
  const reserve = Math.max(0, Math.ceil(reserveMicroUsd));
  const share =
    Math.round((1 - STORY_PRICE_CHANNEL_FEE - STORY_PRICE_MARGIN) * 1e6) / 1e6;
  return Math.max(STORY_PRICE_FLOOR_MICRO_USD, Math.ceil(reserve / share));
}

/**
 * The cheapest price of ONE credit, micro-USD, over every pack and channel.
 * Packs with 0 credits or a 0 price (promo) are ignored: they would make
 * Story free. `null` — no priced pack at all (paid steps are unavailable).
 */
export function storyCreditMicroUsd(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  let best: number | null = null;
  for (const pack of creditPacks(undefined, env)) {
    if (pack.credits <= 0) continue;
    const prices = [
      pack.stars > 0 ? estimateAmountMicroUsd('STARS', pack.stars, env) : 0,
      pack.wayforpayMinor > 0
        ? estimateAmountMicroUsd('WAYFORPAY', pack.wayforpayMinor, env)
        : 0,
    ].filter((p) => p > 0);
    for (const price of prices) {
      const perCredit = price / pack.credits;
      if (best === null || perCredit < best) best = perCredit;
    }
  }
  return best;
}

export interface StoryPrice {
  credits: number;
  priceMicroUsd: number;
  usdEquivalent: number;
}

/** Credits for a step; `null` when credits are not priced. */
export function storyCreditPrice(
  reserveMicroUsd: number,
  env: NodeJS.ProcessEnv = process.env,
): StoryPrice | null {
  const credit = storyCreditMicroUsd(env);
  if (!credit) return null;
  const priceMicroUsd = storyPriceMicroUsd(reserveMicroUsd);
  // 1e-9 guards float noise of `price / credits` from turning 5 into 6.
  const credits = Math.max(1, Math.ceil(priceMicroUsd / credit - 1e-9));
  return {
    credits,
    priceMicroUsd,
    usdEquivalent: Math.round((credits * credit) / 1e4) / 100,
  };
}

/** «Price from» for the public capabilities: the floor step in credits. */
export function storyPriceFromUsd(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return storyCreditPrice(0, env)?.usdEquivalent ?? null;
}
