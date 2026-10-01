/**
 * Слияние выдач (Reciprocal Rank Fusion) — K2. Чистая функция: её
 * используют и поиск режимов (KnowledgeStore.search), и песочница (K3,
 * своя таблица assist_sandbox_chunks).
 *   score(d) = Σ 1 / (k + rank_i(d)) + бонус FAQ; k = KNOWLEDGE_DEFAULTS.search.rrfK.
 *
 * Почему RRF, а не сумма «сырых» баллов: косинус вектора и ранг
 * полнотекста — несравнимые шкалы; ранги сравнимы всегда. Порядок при
 * равенстве — детерминированный (лучший ранг, затем id): одна и та же
 * база и вопрос дают одну и ту же выдачу (кэш, eval, тесты).
 */

export interface RankedId {
  id: string;
  /** 1 = лучший. */
  rank: number;
}

export function rrfMerge(
  lists: RankedId[][],
  opts: { k: number; bonus?: (id: string) => number; limit: number },
): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  const best = new Map<string, number>();
  for (const list of lists) {
    // Один id дважды в одном списке — считается лучший ранг, не сумма.
    const seen = new Set<string>();
    for (const { id, rank } of [...list].sort((a, b) => a.rank - b.rank)) {
      if (seen.has(id) || !(rank >= 1)) continue;
      seen.add(id);
      score.set(id, (score.get(id) ?? 0) + 1 / (opts.k + rank));
      best.set(id, Math.min(best.get(id) ?? Infinity, rank));
    }
  }
  const out = [...score.entries()].map(([id, s]) => ({
    id,
    score: s + (opts.bonus ? opts.bonus(id) : 0),
  }));
  out.sort(
    (a, b) =>
      b.score - a.score ||
      (best.get(a.id) ?? Infinity) - (best.get(b.id) ?? Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out.slice(0, Math.max(0, opts.limit));
}
