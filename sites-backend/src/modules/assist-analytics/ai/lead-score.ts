/**
 * Lead score диалога — КОД, не модель (Э3-бис; ТЗ §5-тер.4, Р-44). ЧИСТЫЙ
 * модуль.
 *
 * Логистическая модель с весами-приорами по вертикали (магазин / услуги /
 * SaaS); признаки — только поведение в диалоге и на сайте (стадия,
 * сигналы покупки, длина, клик по кнопке помощника, страница товара/корзины,
 * голос, повтор визита в связанном режиме) и, с малым весом, сырая оценка
 * модели. Объяснимость: каждый признак возвращает свой вклад (`features`),
 * TMA показывает «почему горячий».
 *
 * Чего в признаках НЕТ — и это закреплено тестом (не дискриминация, §5-тер.4
 * «Чего не делаем»): язык, страна/город, устройство и браузер, имя и
 * контакты, источник трафика. Score не принимает решений (скидки, отказ в
 * обслуживании — их в продукте нет): корзина — подсказка владельцу.
 *
 * До калибровки — корзины hot / warm / cold; калибровка (Pro, ≥ 50
 * известных исходов и ≥ 200 размеченных) — Platt по logit(score): вероятность.
 */
import type { BuyingSignal, Intent, Stage } from './label-schema';

export const VERTICALS = ['shop', 'services', 'saas', 'other'] as const;
export type Vertical = (typeof VERTICALS)[number];

export type LeadBucket = 'hot' | 'warm' | 'cold';

/** Пороги корзин по score 0–100. */
export const BUCKET_HOT = 60;
export const BUCKET_WARM = 30;

/** Признаки — белый список (тест: ни одного демографического/технического). */
export const LEAD_FEATURES = [
  'stage',
  'signals',
  'model',
  'turns',
  'assist_click',
  'page_product',
  'page_cart',
  'voice',
  'repeat_visit',
  'intent',
] as const;
export type LeadFeature = (typeof LEAD_FEATURES)[number];

export interface LeadInput {
  stage: Stage;
  intent: Intent;
  buyingSignals: BuyingSignal[];
  /** null — не учитывается (инъекция или нет оценки). */
  llmLikelihood: number | null;
  /** Реплик посетителя. */
  visitorTurns: number;
  assistClick: boolean;
  pagePath: string | null;
  voice: boolean;
  /** Повторный визит — только связанный режим (согласие). */
  repeatVisit: boolean;
}

export interface LeadScore {
  score: number;
  bucket: LeadBucket;
  /** Вклад признаков (логиты), по убыванию модуля, без нулевых. */
  features: Array<{ f: LeadFeature; c: number }>;
  /** Сумма логитов (для калибровки). */
  z: number;
}

/** Свободный член по вертикали: база конверсии разговаривающих (приор). */
const INTERCEPT: Record<Vertical, number> = {
  shop: -2.2,
  services: -2.0,
  saas: -2.4,
  other: -2.2,
};

const STAGE_W: Record<Stage, number> = {
  explore: 0,
  compare: 0.8,
  decide: 1.6,
  post_purchase: -1.0,
  support: -1.2,
};

const SIGNAL_W: Record<BuyingSignal, number> = {
  asked_price: 0.5,
  asked_delivery: 0.5,
  asked_payment: 0.7,
  asked_stock_specific: 0.6,
  asked_how_to_order: 0.9,
  opened_lead_form: 1.2,
  asked_discount: 0.4,
  compared_competitor: 0.3,
};
const SIGNALS_CAP = 2.5;

const INTENT_W: Partial<Record<Intent, number>> = {
  offtopic_spam: -2.5,
  job: -2,
  complaint: -0.8,
  order_status: -0.6,
  returns: -0.6,
  wholesale_partnership: 0.3,
};

/** Вес сырой оценки модели — малый (Р-44: «один из признаков»). */
const MODEL_W = 0.6;

const PRODUCT_RE =
  /\/(product|products|item|items|tovar|tovary|catalog|katalog|shop|p)(\/|$)/i;
const CART_RE =
  /\/(cart|basket|checkout|order|korzina|koshyk|kosik|oformlenie|zamovlennya)(\/|$|-)/i;

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function leadScore(input: LeadInput, vertical: Vertical): LeadScore {
  const parts: Array<{ f: LeadFeature; c: number }> = [];
  const add = (f: LeadFeature, c: number) => {
    if (c !== 0 && Number.isFinite(c)) parts.push({ f, c: r2(c) });
  };
  add('stage', STAGE_W[input.stage] ?? 0);
  add('intent', INTENT_W[input.intent] ?? 0);
  const sig = input.buyingSignals.reduce((s, x) => s + (SIGNAL_W[x] ?? 0), 0);
  add('signals', Math.min(SIGNALS_CAP, sig));
  if (input.llmLikelihood !== null) {
    add('model', MODEL_W * (input.llmLikelihood / 100 - 0.5) * 2);
  }
  add(
    'turns',
    Math.min(0.6, 0.25 * Math.log1p(Math.max(0, input.visitorTurns - 1))),
  );
  if (input.assistClick) add('assist_click', 0.6);
  const path = input.pagePath ?? '';
  if (CART_RE.test(path)) add('page_cart', 0.8);
  else if (PRODUCT_RE.test(path)) add('page_product', 0.4);
  if (input.voice) add('voice', 0.1);
  if (input.repeatVisit) add('repeat_visit', 0.3);
  const z = INTERCEPT[vertical] + parts.reduce((s, p) => s + p.c, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 * sigmoid(z))));
  return {
    score,
    bucket: bucketOf(score),
    features: parts.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)),
    z: r2(z),
  };
}

export function bucketOf(score: number): LeadBucket {
  return score >= BUCKET_HOT ? 'hot' : score >= BUCKET_WARM ? 'warm' : 'cold';
}

export function isVertical(v: unknown): v is Vertical {
  return typeof v === 'string' && (VERTICALS as readonly string[]).includes(v);
}

// ── калибровка (Platt) и метрики качества (§5-тер.16) ───────────────────

export interface Platt {
  a: number;
  b: number;
}

/** logit(score/100) с отсечкой краёв. */
export function scoreLogit(score: number): number {
  const p = Math.min(0.99, Math.max(0.01, score / 100));
  return Math.log(p / (1 - p));
}

export function plattProb(score: number, p: Platt): number {
  return sigmoid(p.a * scoreLogit(score) + p.b);
}

/**
 * Подбор Platt методом Ньютона с целевыми Платта (y+ = (N+ + 1)/(N+ + 2),
 * y− = 1/(N− + 2)) — без переобучения на малых выборках. null — вырождено.
 */
export function fitPlatt(
  rows: Array<{ score: number; y: 0 | 1 }>,
): Platt | null {
  const pos = rows.filter((r) => r.y === 1).length;
  const neg = rows.length - pos;
  if (pos === 0 || neg === 0) return null;
  const hi = (pos + 1) / (pos + 2);
  const lo = 1 / (neg + 2);
  const xs = rows.map((r) => scoreLogit(r.score));
  const ts = rows.map((r) => (r.y === 1 ? hi : lo));
  let a = 1;
  let b = 0;
  for (let it = 0; it < 100; it++) {
    let g1 = 0;
    let g2 = 0;
    let h11 = 1e-9;
    let h22 = 1e-9;
    let h12 = 0;
    for (let i = 0; i < xs.length; i++) {
      const p = sigmoid(a * xs[i] + b);
      const d = p - ts[i];
      const w = p * (1 - p);
      g1 += d * xs[i];
      g2 += d;
      h11 += w * xs[i] * xs[i];
      h22 += w;
      h12 += w * xs[i];
    }
    const det = h11 * h22 - h12 * h12;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (h22 * g1 - h12 * g2) / det;
    const db = (h11 * g2 - h12 * g1) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) break;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a: Math.round(a * 1e4) / 1e4, b: Math.round(b * 1e4) / 1e4 };
}

/** AUC (Манна–Уитни, ничьи — половина). null — нет одного из классов. */
export function auc(rows: Array<{ p: number; y: 0 | 1 }>): number | null {
  const pos = rows.filter((r) => r.y === 1);
  const neg = rows.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return null;
  const sorted = [...rows].sort((x, y) => x.p - y.p);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) if (sorted[k].y === 1) rankSum += avg;
    i = j + 1;
  }
  const u = rankSum - (pos.length * (pos.length + 1)) / 2;
  return Math.round((u / (pos.length * neg.length)) * 1e4) / 1e4;
}

export function brier(rows: Array<{ p: number; y: 0 | 1 }>): number | null {
  if (!rows.length) return null;
  const s = rows.reduce((acc, r) => acc + (r.p - r.y) ** 2, 0);
  return Math.round((s / rows.length) * 1e4) / 1e4;
}

/** ECE по 10 корзинам равной ширины. */
export function ece(rows: Array<{ p: number; y: 0 | 1 }>): number | null {
  if (!rows.length) return null;
  let e = 0;
  for (let k = 0; k < 10; k++) {
    const bin = rows.filter((r) =>
      k === 9 ? r.p >= k / 10 : r.p >= k / 10 && r.p < (k + 1) / 10,
    );
    if (!bin.length) continue;
    const conf = bin.reduce((s, r) => s + r.p, 0) / bin.length;
    const acc = bin.reduce((s, r) => s + r.y, 0) / bin.length;
    e += (bin.length / rows.length) * Math.abs(conf - acc);
  }
  return Math.round(e * 1e4) / 1e4;
}

/** Порог калибровки (§5-тер.4). */
export const CALIBRATION_MIN_POSITIVES = 50;
export const CALIBRATION_MIN_TOTAL = 200;
