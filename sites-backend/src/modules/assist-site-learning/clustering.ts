/**
 * Кластеризация очереди — L (§4-тер.3 п.2): ЧИСТАЯ функция над векторами
 * (модель не нужна — эмбеддинг вопроса уже есть). Жадно по косинусу к
 * центроиду (порог LEARNING_DEFAULTS.clusterSimilarity), в пределах сайта
 * и языка; `distinctVisitors` — разные visitorId БЕЗ suspicious (§4-тер.7,
 * §4-тер.15 п.9: 20 одинаковых вопросов одного suspicious-ipHash кластер не
 * растят). Детерминирована (порядок — createdAt, id): повторный прогон
 * даёт те же кластеры.
 *
 * Уточнения реализации (L):
 *  - элемент с `clusterId` существующего кластера остаётся в нём (решение
 *    человека по кластеру не «переезжает» молча); элемент с `clusterId`
 *    кластера, которого уже нет, считается новым;
 *  - центроид — среднее НОРМИРОВАННЫХ векторов участников (косинус не
 *    зависит от длины вектора, а среднее нормированных — от «громкости»
 *    отдельного вопроса); кластер без участников во входе сохраняет
 *    прежний центроид и в ответ не попадает;
 *  - новый элемент выбирает кластер с наибольшим косинусом (≥ порога), при
 *    равенстве — более ранний (существующие — в порядке `existing`, новые —
 *    в порядке создания); центроид пересчитывается сразу (жадно);
 *  - язык сравнивается как есть (`null` — отдельный «язык»): вопрос на
 *    русском и тот же на украинском — разные пробелы (§4-тер.10: ответ на
 *    каждом языке — свой проверенный ответ или вариант).
 */
export interface ClusterInput {
  id: string;
  embedding: number[];
  visitorId: string | null;
  suspicious: boolean;
  lang: string | null;
  createdAt: Date;
  /** Уже в кластере (из прошлых прогонов) — центроиды существующих учитываются. */
  clusterId: string | null;
}

export interface ExistingCluster {
  id: string;
  centroid: number[];
  lang: string | null;
}

export interface ClusterAssignment {
  /** id существующего кластера или `new:<n>` для нового. */
  clusterKey: string;
  itemIds: string[];
  centroid: number[];
  distinctVisitors: number;
}

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** Единичный вектор; нулевой/битый — null (такой элемент не кластеризуется). */
export function unit(v: number[]): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) return null;
  const n = norm(v);
  return n > 0 ? v.map((x) => x / n) : null;
}

/** Косинус двух векторов (разной длины или нулевые — 0). */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const n = norm(a) * norm(b);
  return n > 0 ? dot / n : 0;
}

interface Work {
  key: string;
  lang: string | null;
  /** Сумма единичных векторов участников. */
  sum: number[] | null;
  count: number;
  /** Центроид без участников (существующий кластер до первого участника). */
  prior: number[] | null;
  items: ClusterInput[];
}

function centroidOf(w: Work): number[] | null {
  if (w.sum && w.count > 0) return w.sum.map((x) => x / w.count);
  return w.prior;
}

function add(w: Work, v: number[], item: ClusterInput): void {
  if (!w.sum || w.sum.length !== v.length) {
    w.sum = v.slice();
  } else {
    for (let i = 0; i < v.length; i++) w.sum[i] += v[i];
  }
  w.count++;
  w.items.push(item);
}

function byTime(a: ClusterInput, b: ClusterInput): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function distinctVisitorsOf(
  items: Array<Pick<ClusterInput, 'visitorId' | 'suspicious'>>,
): number {
  const set = new Set<string>();
  for (const i of items) {
    if (!i.suspicious && i.visitorId) set.add(i.visitorId);
  }
  return set.size;
}

export function clusterItems(
  items: ClusterInput[],
  existing: ExistingCluster[],
  threshold: number,
): ClusterAssignment[] {
  const work: Work[] = [];
  const byId = new Map<string, Work>();
  for (const c of existing) {
    if (byId.has(c.id)) continue;
    const w: Work = {
      key: c.id,
      lang: c.lang,
      sum: null,
      count: 0,
      prior: unit(c.centroid),
      items: [],
    };
    work.push(w);
    byId.set(c.id, w);
  }

  const sorted = [...items].sort(byTime);
  const fresh: Array<{ item: ClusterInput; v: number[] }> = [];
  // Сначала — участники существующих кластеров: их центроид — точка
  // отсчёта для новых элементов этого прогона.
  for (const item of sorted) {
    const v = unit(item.embedding);
    if (!v) continue;
    const w = item.clusterId ? byId.get(item.clusterId) : undefined;
    if (w) add(w, v, item);
    else fresh.push({ item, v });
  }

  let next = 0;
  for (const { item, v } of fresh) {
    let best: Work | null = null;
    let bestSim = -Infinity;
    for (const w of work) {
      if (w.lang !== item.lang) continue;
      const c = centroidOf(w);
      if (!c || c.length !== v.length) continue;
      const sim = cosine(v, c);
      if (sim >= threshold && sim > bestSim) {
        best = w;
        bestSim = sim;
      }
    }
    if (!best) {
      best = {
        key: `new:${next++}`,
        lang: item.lang,
        sum: null,
        count: 0,
        prior: null,
        items: [],
      };
      work.push(best);
    }
    add(best, v, item);
  }

  return work
    .filter((w) => w.items.length > 0)
    .map((w) => ({
      clusterKey: w.key,
      itemIds: w.items.map((i) => i.id),
      centroid: centroidOf(w) as number[],
      distinctVisitors: distinctVisitorsOf(w.items),
    }));
}
