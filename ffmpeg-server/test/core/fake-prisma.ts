/**
 * In-memory реализация моделей Prisma, которые трогает настоящий backend
 * `FfmpegApiService` (ffmpegRouting, ffmpegSubmission, ffmpegBreakerJob,
 * ffmpegFallbackEvent). Нужна сквозным тестам, чтобы реальный путь
 * submit/status (закрепление отправки до сети, сверка по ключу, breaker)
 * исполнялся, а не обходился.
 *
 * Подмножество API: findUnique / findMany / create / upsert / updateMany /
 * deleteMany; where — равенство, null, {gt,gte,lt,lte,in}, OR/AND;
 * data — значения и {increment}. Уникальные поля — P2002, как у Prisma.
 */
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a != null && b != null && cmp(a, b) === 0;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function matches(row: Row, where: Where = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v != null) return false;
      continue;
    }
    if (
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !Array.isArray(cond)
    ) {
      const c = cond as Record<string, unknown>;
      if ('equals' in c && !same(v, c.equals)) return false;
      if ('in' in c && !(c.in as unknown[]).some((x) => same(v, x)))
        return false;
      for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
        if (!(op in c)) continue;
        if (v == null) return false;
        const r = cmp(v, c[op]);
        if (op === 'gt' && !(r > 0)) return false;
        if (op === 'gte' && !(r >= 0)) return false;
        if (op === 'lt' && !(r < 0)) return false;
        if (op === 'lte' && !(r <= 0)) return false;
      }
      continue;
    }
    if (!same(v, cond)) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      'increment' in v
    ) {
      row[k] =
        Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
    } else row[k] = v;
  }
}

class Model {
  rows: Row[] = [];
  constructor(
    private readonly unique: string[],
    private readonly defaults: () => Row = () => ({}),
  ) {}

  private conflict(row: Row, except?: Row): boolean {
    return this.rows.some(
      (r) =>
        r !== except &&
        this.unique.some((u) => row[u] != null && same(r[u], row[u])),
    );
  }

  async findUnique({ where }: { where: Where }): Promise<Row | null> {
    const r = this.rows.find((x) => matches(x, where));
    return r ? { ...r } : null;
  }

  async findFirst({ where }: { where?: Where } = {}): Promise<Row | null> {
    return this.findUnique({ where: where ?? {} });
  }

  async findMany({ where }: { where?: Where } = {}): Promise<Row[]> {
    return this.rows.filter((x) => matches(x, where)).map((r) => ({ ...r }));
  }

  async count({ where }: { where?: Where } = {}): Promise<number> {
    return this.rows.filter((x) => matches(x, where)).length;
  }

  async create({ data }: { data: Row }): Promise<Row> {
    const row = { ...this.defaults(), ...data };
    if (this.conflict(row)) {
      throw Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
    }
    this.rows.push(row);
    return { ...row };
  }

  async upsert(a: { where: Where; create: Row; update: Row }): Promise<Row> {
    const r = this.rows.find((x) => matches(x, a.where));
    if (!r) return this.create({ data: a.create });
    apply(r, a.update);
    return { ...r };
  }

  async update(a: { where: Where; data: Row }): Promise<Row> {
    const r = this.rows.find((x) => matches(x, a.where));
    if (!r)
      throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    apply(r, a.data);
    return { ...r };
  }

  async updateMany(a: {
    where?: Where;
    data: Row;
  }): Promise<{ count: number }> {
    const hit = this.rows.filter((x) => matches(x, a.where));
    for (const r of hit) apply(r, a.data);
    return { count: hit.length };
  }

  async deleteMany(a: { where?: Where } = {}): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !matches(x, a.where));
    return { count: before - this.rows.length };
  }
}

export function fakeFfmpegPrisma(routing: Partial<Row> = {}) {
  const now = () => new Date();
  const prisma = {
    ffmpegRouting: new Model(['id']),
    ffmpegSubmission: new Model(['idempotencyKey'], () => ({
      createdAt: now(),
    })),
    ffmpegBreakerJob: new Model(['jobId'], () => ({ createdAt: now() })),
    ffmpegFallbackEvent: new Model([], () => ({ createdAt: now() })),
  };
  prisma.ffmpegRouting.rows.push({
    id: 'default',
    revision: 1,
    defaultProvider: 'selfhosted',
    canaryProducts: [],
    updatedAt: now(),
    updatedBy: null,
    breakerFailures: 0,
    breakerLastFailureAt: null,
    breakerOpenUntil: null,
    breakerProbeUntil: null,
    breakerProbeJobId: null,
    ...routing,
  });
  return prisma;
}
