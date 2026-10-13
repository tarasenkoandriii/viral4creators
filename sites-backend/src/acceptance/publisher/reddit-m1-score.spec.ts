/**
 * [AT-RD-06] P-R M1 — детерминизм и свойства Opportunity Score v1
 * (reddit-manual-mvp-adapted.md §M1.4, §9; A06). Тест свойств на
 * воспроизводимом генераторе (seed фиксирован, 5 000 наборов):
 *  - одинаковые входы → побайтно одинаковый результат (в т. ч. при другом
 *    порядке ключей и повторном вызове);
 *  - диапазоны 0..100, `priority ≤ relevance`, `priority` убывает по риску;
 *  - монотонность: рост фактора релевантности не уменьшает relevance, рост
 *    фактора риска не уменьшает risk;
 *  - `null` не превращается в 0: группа `null`, фактор в `missing`;
 *  - совпадение с эталонной формулой в рациональных числах (без float).
 * Плюс сквозная часть: одна и та же возможность, пересчитанная по API,
 * даёт тот же score (БД — `reddit-m1-policy.spec.ts`).
 */
import {
  REDDIT_SCORE_FACTORS,
  type RedditScoreFactor,
} from '../../modules/publisher/contracts/states';
import type { RedditFactors } from '../../modules/publisher/contracts/reddit-api';
import {
  SCORE_WEIGHTS_V1,
  computeScore,
} from '../../modules/publisher/reddit/score';

/** mulberry32 — воспроизводимый ГПСЧ. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gen(r: () => number, nullRate = 0.1): RedditFactors {
  return Object.fromEntries(
    REDDIT_SCORE_FACTORS.map((k) => {
      const v = r() < nullRate ? null : Math.floor(r() * 101);
      return [k, { value: v, why: v === null ? null : `w${v}` }];
    }),
  ) as RedditFactors;
}

/** Эталон: целые веса в сотых, округление половины вверх в рациональных числах. */
function reference(f: RedditFactors) {
  const g = (w: Partial<Record<RedditScoreFactor, number>>) => {
    let num = 0;
    for (const [k, wt] of Object.entries(w)) {
      const v = f[k as RedditScoreFactor].value;
      if (v === null) return null;
      num += (wt as number) * v;
    }
    // round(num/100), .5 → вверх
    return num % 100 >= 50 ? Math.ceil(num / 100) : Math.floor(num / 100);
  };
  const relevance = g(SCORE_WEIGHTS_V1.relevance);
  const risk = g(SCORE_WEIGHTS_V1.risk);
  let priority: number | null = null;
  if (relevance !== null && risk !== null) {
    const num = relevance * (100 - risk);
    priority = num % 100 >= 50 ? Math.ceil(num / 100) : Math.floor(num / 100);
  }
  return { relevance, risk, priority };
}

const N = 5000;

describe('[AT-RD-06] score v1 — одинаковые входы дают одинаковый результат (тест свойств)', () => {
  it(`детерминизм: ${N} наборов, повтор и перестановка ключей — побайтно равно`, () => {
    const r = rng(20261013);
    for (let i = 0; i < N; i++) {
      const f = gen(r);
      const a = JSON.stringify(computeScore(f));
      const b = JSON.stringify(computeScore(structuredClone(f)));
      const reversed = Object.fromEntries(
        Object.entries(f).reverse(),
      ) as RedditFactors;
      const c = JSON.stringify(computeScore(reversed));
      expect(b).toBe(a);
      expect(c).toBe(a);
    }
  });

  it('совпадение с эталоном в рациональных числах; диапазоны; priority ≤ relevance', () => {
    const r = rng(42);
    for (let i = 0; i < N; i++) {
      const f = gen(r);
      const s = computeScore(f);
      const ref = reference(f);
      expect({
        relevance: s.relevance,
        risk: s.risk,
        priority: s.priority,
      }).toEqual(ref);
      const values = [s.relevance, s.risk, s.priority].filter(
        (v): v is number => v !== null,
      );
      expect(
        values.every((v) => Number.isInteger(v) && v >= 0 && v <= 100),
      ).toBe(true);
      expect(s.priority === null || s.priority <= s.relevance!).toBe(true);
    }
  });

  it('монотонность: +фактор релевантности не уменьшает relevance; +фактор риска не уменьшает risk и не увеличивает priority', () => {
    const r = rng(7);
    const relKeys = Object.keys(
      SCORE_WEIGHTS_V1.relevance,
    ) as RedditScoreFactor[];
    const riskKeys = Object.keys(SCORE_WEIGHTS_V1.risk) as RedditScoreFactor[];
    for (let i = 0; i < N; i++) {
      const f = gen(r, 0);
      const base = computeScore(f);
      const k = [...relKeys, ...riskKeys][i % 8];
      const up = structuredClone(f);
      up[k] = {
        value: Math.min(100, (f[k].value ?? 0) + 1 + (i % 30)),
        why: 'up',
      };
      const s = computeScore(up);
      const monotone = relKeys.includes(k)
        ? s.relevance! >= base.relevance!
        : s.risk! >= base.risk! && s.priority! <= base.priority!;
      expect({ k, monotone }).toEqual({ k, monotone: true });
    }
  });

  it('null не превращается в 0: группа null, missing — ровно null-факторы в порядке списка', () => {
    const r = rng(99);
    for (let i = 0; i < N; i++) {
      const f = gen(r, 0.3);
      const s = computeScore(f);
      const nulls = REDDIT_SCORE_FACTORS.filter((k) => f[k].value === null);
      expect(s.missing).toEqual(nulls);
      const relNull = Object.keys(SCORE_WEIGHTS_V1.relevance).some((k) =>
        nulls.includes(k as RedditScoreFactor),
      );
      const riskNull = Object.keys(SCORE_WEIGHTS_V1.risk).some((k) =>
        nulls.includes(k as RedditScoreFactor),
      );
      expect(s.relevance === null).toBe(relNull);
      expect(s.risk === null).toBe(riskNull);
      expect(s.priority === null).toBe(relNull || riskNull);
    }
  });

  it('веса v1 — константы версии: суммы групп = 100', () => {
    const sum = (o: Record<string, number>) =>
      Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(SCORE_WEIGHTS_V1.relevance)).toBe(100);
    expect(sum(SCORE_WEIGHTS_V1.risk)).toBe(100);
    expect(SCORE_WEIGHTS_V1).toEqual({
      relevance: {
        topic_fit: 35,
        intent_fit: 25,
        audience_fit: 20,
        answerability: 20,
      },
      risk: {
        policy_risk: 40,
        promotionality: 25,
        evidence_gap: 20,
        context_uncertainty: 15,
      },
    });
  });
});
