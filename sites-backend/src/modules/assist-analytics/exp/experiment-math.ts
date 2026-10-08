/**
 * Статистика экспериментов (Э3-бис; ТЗ §5-тер.2, Р-42) — ЧИСТЫЙ модуль.
 *
 * Честность (решения Э3-бис, план «Э3-бис — сделано»):
 *  - ФИКСИРОВАННЫЙ ГОРИЗОНТ без подглядывания: результат считается и
 *    показывается только после `endsAt`; до этого — число единиц по группам
 *    и SRM (проверка корректности, не эффективности). Продление «потому что
 *    почти значимо» невозможно — горизонт задаётся при старте;
 *  - мощность ДО старта: по трафику с согласием за 28 дней — какой эффект
 *    эксперимент способен увидеть (MDE); > 30% — запуск не предлагается;
 *  - минимальная выборка: если к горизонту в группе меньше расчётного —
 *    итог «недостаточно данных», а не «эффекта нет»;
 *  - единица — посетитель с согласием (хеш ключа визита), она же единица
 *    рандомизации: поправка на кластеры не нужна; анализ — по назначению
 *    (intent-to-treat): мелькнувшая кнопка у holdout размывает эффект к нулю,
 *    но не создаёт ложного;
 *  - SRM: χ² долей единиц против заданной доли, p < 0.001 → «испорчен».
 * Назначение группы — FNV-1a 32 от `соль:ключ визита` (то же в загрузчике:
 * группа известна странице сразу, сервер её пересчитывает и не верит
 * клиенту).
 */

export const EXPERIMENT_KINDS = ['holdout', 'greeting', 'suggestions'] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

/** α = 0.05 (двусторонний), мощность 80%. */
export const Z_ALPHA2 = 1.959964;
export const Z_BETA = 0.841621;
/** Больше этого MDE — «на вашем трафике прирост не измерить» (§5-тер.2). */
export const MAX_MDE_REL = 0.3;
export const SRM_P = 0.001;
/** SRM проверяется с этого числа единиц (раньше χ² неустойчив). */
export const SRM_MIN_UNITS = 100;

export const EXPERIMENT_LIMITS = {
  holdoutShareMin: 0.05,
  holdoutShareMax: 0.2,
  holdoutShareDefault: 0.1,
  variantShare: 0.5,
  horizonMin: 14,
  horizonMax: 56,
  horizonDefault: 28,
  /** Окно истории для расчёта мощности. */
  powerWindowDays: 28,
  greetingChars: 300,
  suggestions: 4,
  suggestionChars: 80,
  /** Единицы законченного эксперимента хранятся столько (итог — в result). */
  unitsRetentionDays: 30,
} as const;

/** FNV-1a 32 бит (UTF-16 коды; те же байты в загрузчике). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Группа: b — «вариант B» (у holdout — без виджета), иначе a. */
export function armOf(
  salt: string,
  visitKey: string,
  share: number,
): 'a' | 'b' {
  return fnv1a32(`${salt}:${visitKey}`) / 4294967296 < share ? 'b' : 'a';
}

export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Всего единиц, чтобы увидеть относительный эффект `mdeRel` при базе p. */
export function requiredTotal(
  p: number,
  mdeRel: number,
  share: number,
): number {
  if (!(p > 0 && p < 1) || !(mdeRel > 0) || !(share > 0 && share < 1)) {
    return Infinity;
  }
  const z = Z_ALPHA2 + Z_BETA;
  return Math.ceil(
    (z * z * p * (1 - p) * (1 / share + 1 / (1 - share))) / (p * mdeRel) ** 2,
  );
}

/** Минимальный относительный эффект, видимый на N единиц. */
export function mdeFor(p: number, total: number, share: number): number {
  if (!(p > 0 && p < 1) || !(total > 0) || !(share > 0 && share < 1)) {
    return Infinity;
  }
  const se = Math.sqrt(
    p * (1 - p) * (1 / (total * share) + 1 / (total * (1 - share))),
  );
  return ((Z_ALPHA2 + Z_BETA) * se) / p;
}

export interface PowerEstimate {
  /** Единиц (посетителей с согласием) за 28 дней истории. */
  units28: number;
  /** Конверсий основной цели у них. */
  conversions28: number;
  baseRate: number;
  unitsPerDay: number;
  expectedUnits: number;
  /** Видимый эффект к горизонту (относительный). */
  mdeRel: number;
  /** Нужно единиц в меньшей группе. */
  minUnitsPerArm: number;
  ok: boolean;
  /** no_traffic | no_conversions | underpowered | null */
  reason: string | null;
}

export function estimatePower(p: {
  units28: number;
  conversions28: number;
  share: number;
  horizonDays: number;
}): PowerEstimate {
  const days = EXPERIMENT_LIMITS.powerWindowDays;
  const unitsPerDay = p.units28 / days;
  const expectedUnits = Math.floor(unitsPerDay * p.horizonDays);
  const baseRate = p.units28 > 0 ? p.conversions28 / p.units28 : 0;
  const base = {
    units28: p.units28,
    conversions28: p.conversions28,
    baseRate: Math.round(baseRate * 1e4) / 1e4,
    unitsPerDay: Math.round(unitsPerDay * 10) / 10,
    expectedUnits,
  };
  if (p.units28 <= 0) {
    return {
      ...base,
      mdeRel: Infinity,
      minUnitsPerArm: 0,
      ok: false,
      reason: 'no_traffic',
    };
  }
  if (p.conversions28 <= 0 || baseRate >= 1) {
    return {
      ...base,
      mdeRel: Infinity,
      minUnitsPerArm: 0,
      ok: false,
      reason: 'no_conversions',
    };
  }
  const mde = mdeFor(baseRate, expectedUnits, p.share);
  // Эксперимент проектируется на тот эффект, который он способен увидеть.
  const design = Math.ceil(mde * 100) / 100;
  const total = requiredTotal(baseRate, design, p.share);
  const minUnitsPerArm = Number.isFinite(total)
    ? Math.ceil(total * Math.min(p.share, 1 - p.share))
    : 0;
  const ok = Number.isFinite(mde) && mde <= MAX_MDE_REL;
  return {
    ...base,
    mdeRel: Number.isFinite(mde) ? Math.round(mde * 1e4) / 1e4 : Infinity,
    minUnitsPerArm,
    ok,
    reason: ok ? null : 'underpowered',
  };
}

/** SRM: p-значение χ² (1 степень свободы) долей против заданной `share` (у b). */
export function srmP(nA: number, nB: number, share: number): number | null {
  const n = nA + nB;
  if (n <= 0 || !(share > 0 && share < 1)) return null;
  const eB = n * share;
  const eA = n - eB;
  const chi = (nA - eA) ** 2 / eA + (nB - eB) ** 2 / eB;
  return 2 * (1 - normalCdf(Math.sqrt(chi)));
}

export interface ExperimentResult {
  nA: number;
  nB: number;
  xA: number;
  xB: number;
  rateA: number;
  rateB: number;
  /** rateB − rateA и его 95% интервал (несгруппированная ошибка). */
  diff: number;
  ciLow: number;
  ciHigh: number;
  /** Двусторонний тест двух долей (объединённая ошибка). */
  p: number | null;
  /** (rateB − rateA) / rateA; null при rateA = 0. */
  liftRel: number | null;
  /** significant | not_significant | insufficient_sample */
  verdict: 'significant' | 'not_significant' | 'insufficient_sample';
  /**
   * Заход 9 (хвост аудита Э3-бис (2)): срабатывания основной цели за срок
   * эксперимента по доверию. Соль группы публична (группу считает
   * страница) — конверсии «со страницы» (`trust: page`) посетитель или
   * конкурент может накрутить в одну группу; SRM ловит только дисбаланс
   * единиц. Доля `page` > 0 — итог стоит перепроверить; честная основная
   * цель — вебхук s2s (`assistRef`, verified) или заявка помощника.
   */
  goalTrust?: GoalTrust;
}

export interface GoalTrust {
  /** Завершённых срабатываний цели за срок (все посетители). */
  total: number;
  /** Из них со страницы (trust: page). */
  page: number;
  /** page / total (4 знака); null — срабатываний не было. */
  pageShare: number | null;
}

export function goalTrustOf(total: number, page: number): GoalTrust {
  const t = Math.max(0, Math.round(total));
  const pg = Math.min(t, Math.max(0, Math.round(page)));
  return {
    total: t,
    page: pg,
    pageShare: t > 0 ? Math.round((pg / t) * 1e4) / 1e4 : null,
  };
}

const r = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export function analyze(p: {
  nA: number;
  nB: number;
  xA: number;
  xB: number;
  minUnitsPerArm: number;
}): ExperimentResult {
  const rateA = p.nA > 0 ? p.xA / p.nA : 0;
  const rateB = p.nB > 0 ? p.xB / p.nB : 0;
  const diff = rateB - rateA;
  const seU =
    p.nA > 0 && p.nB > 0
      ? Math.sqrt((rateA * (1 - rateA)) / p.nA + (rateB * (1 - rateB)) / p.nB)
      : 0;
  let pv: number | null = null;
  if (p.nA > 0 && p.nB > 0) {
    const pool = (p.xA + p.xB) / (p.nA + p.nB);
    const se = Math.sqrt(pool * (1 - pool) * (1 / p.nA + 1 / p.nB));
    pv =
      se === 0
        ? diff === 0
          ? 1
          : 0
        : 2 * (1 - normalCdf(Math.abs(diff) / se));
  }
  const enough =
    Math.min(p.nA, p.nB) >= p.minUnitsPerArm && p.minUnitsPerArm > 0;
  return {
    nA: p.nA,
    nB: p.nB,
    xA: p.xA,
    xB: p.xB,
    rateA: r(rateA),
    rateB: r(rateB),
    diff: r(diff),
    ciLow: r(diff - Z_ALPHA2 * seU),
    ciHigh: r(diff + Z_ALPHA2 * seU),
    p: pv === null ? null : r(pv),
    liftRel: rateA > 0 ? r(diff / rateA) : null,
    verdict: !enough
      ? 'insufficient_sample'
      : pv !== null && pv < 0.05
        ? 'significant'
        : 'not_significant',
  };
}

/** Ключ визита из браузера: случайная строка (загрузчик), без смысла. */
export const VISIT_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
