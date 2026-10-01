/**
 * Поддельная база для тестов site-core: таблицы в памяти + НАСТОЯЩАЯ
 * проверка тенанта (`scopeArgs` из prisma/tenant.ts). Сервисы получают
 * то же `forAccount/guarded/system`, что в проде, и забытый кабинет здесь
 * бросает так же, как на настоящем Prisma.
 *
 * Поддержано ровно то, чем пользуются сервисы ядра: равенство, `in`,
 * `not`, `lt/lte/gt/gte`, сортировка по одному полю, `take`, `select`;
 * уникальные индексы и составные внешние ключи схемы — как в миграциях.
 * Не для прода и не для других модулей «как есть».
 */

import { scopeArgs } from '../../../prisma/tenant';
import type { SitesDb } from '../../../prisma/sites-db.service';

type Row = Record<string, unknown>;
export type Mode = 'system' | 'guarded' | `account:${string}`;

export interface CallLog {
  mode: Mode;
  model: string;
  op: string;
  reason?: string;
}

const MODELS: Record<string, string> = {
  siteAccount: 'SiteAccount',
  siteAccountMember: 'SiteAccountMember',
  siteAccountInvite: 'SiteAccountInvite',
  site: 'Site',
  siteHost: 'SiteHost',
  siteOwnershipChallenge: 'SiteOwnershipChallenge',
  siteOptOutDomain: 'SiteOptOutDomain',
};

const UNIQUES: Record<string, string[][]> = {
  SiteAccount: [['verifyToken']],
  SiteAccountMember: [['accountId', 'telegramId']],
  SiteAccountInvite: [['tokenHash']],
  Site: [['id', 'accountId']],
  SiteHost: [['accountId', 'scheme', 'host', 'port']],
  SiteOwnershipChallenge: [],
  SiteOptOutDomain: [['domain']],
};

function defaults(model: string): Row {
  switch (model) {
    case 'SiteAccount':
      return { type: 'owner', region: 'other', verifyTokenRotatedAt: null };
    case 'Site':
      return { endClientId: null };
    case 'SiteHost':
      return {
        scheme: 'https',
        port: 443,
        publicPlatform: false,
        status: 'pending',
        method: null,
        verifiedAt: null,
        expiresAt: null,
        lastRecheckAt: null,
        revokedAt: null,
        lastCheck: null,
        reverifyBlockedAt: null,
        reverifyBlockedByAccountId: null,
      };
    case 'SiteOwnershipChallenge':
      return {
        status: 'pending',
        checkedAt: null,
        lastRecheckAt: null,
        expiresAt: null,
        revokedAt: null,
      };
    case 'SiteAccountInvite':
      return { usedAt: null, usedByTelegramId: null };
    case 'SiteOptOutDomain':
      return { confirmedAt: null };
    default:
      return {};
  }
}

export class PrismaLikeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

function isOps(v: unknown): v is Row {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Date) &&
    !Array.isArray(v)
  );
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (!isOps(cond)) return eq(actual, cond);
  for (const [op, v] of Object.entries(cond)) {
    switch (op) {
      case 'in':
        if (!(v as unknown[]).some((x) => eq(actual, x))) return false;
        break;
      case 'not':
        if (isOps(v) ? matchValue(actual, v) : eq(actual, v)) return false;
        break;
      case 'lt':
        if (actual == null || cmp(actual, v) >= 0) return false;
        break;
      case 'lte':
        if (actual == null || cmp(actual, v) > 0) return false;
        break;
      case 'gt':
        if (actual == null || cmp(actual, v) <= 0) return false;
        break;
      case 'gte':
        if (actual == null || cmp(actual, v) < 0) return false;
        break;
      case 'startsWith':
        if (typeof actual !== 'string' || !actual.startsWith(v as string))
          return false;
        break;
      default:
        throw new Error(`fake db: оператор ${op} не поддержан`);
    }
  }
  return true;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => matchValue(row[k], v));
}

const OPS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'count',
  'create',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

let seq = 0;

export class FakeStore {
  readonly tables: Record<string, Row[]> = Object.fromEntries(
    Object.values(MODELS).map((m) => [m, []]),
  );
  readonly calls: CallLog[] = [];
  readonly rawCalls: string[] = [];
  now = () => new Date();

  private checkUnique(model: string, row: Row, except?: Row): void {
    for (const cols of UNIQUES[model] ?? []) {
      const clash = this.tables[model].find(
        (r) => r !== except && cols.every((c) => eq(r[c], row[c])),
      );
      if (clash) throw new PrismaLikeError('P2002');
    }
  }

  private checkFk(model: string, row: Row): void {
    const has = (m: string, w: Row) =>
      this.tables[m].some((r) => matches(r, w));
    const need: Array<[string, Row]> = [];
    if (model === 'SiteHost') {
      need.push(['SiteAccount', { id: row.accountId }]);
      need.push(['Site', { id: row.siteId, accountId: row.accountId }]);
    }
    if (
      model === 'Site' ||
      model === 'SiteAccountMember' ||
      model === 'SiteAccountInvite'
    ) {
      need.push(['SiteAccount', { id: row.accountId }]);
    }
    if (model === 'SiteOwnershipChallenge') {
      need.push(['SiteHost', { id: row.hostId, accountId: row.accountId }]);
    }
    for (const [m, w] of need) {
      if (!has(m, w)) throw new PrismaLikeError('P2003');
    }
  }

  private cascade(model: string, row: Row): void {
    const children: Record<string, Array<[string, (r: Row) => boolean]>> = {
      SiteAccount: [
        ['SiteAccountMember', (r) => r.accountId === row.id],
        ['SiteAccountInvite', (r) => r.accountId === row.id],
        ['Site', (r) => r.accountId === row.id],
      ],
      Site: [['SiteHost', (r) => r.siteId === row.id]],
      SiteHost: [['SiteOwnershipChallenge', (r) => r.hostId === row.id]],
    };
    for (const [m, pred] of children[model] ?? []) {
      for (const r of this.tables[m].filter(pred)) {
        this.tables[m] = this.tables[m].filter((x) => x !== r);
        this.cascade(m, r);
      }
    }
  }

  insert(model: string, data: Row): Row {
    const now = this.now();
    const row: Row = {
      id: `${model.toLowerCase()}_${++seq}`,
      ...defaults(model),
      createdAt: now,
      ...(model === 'SiteAccountInvite' ||
      model === 'SiteOwnershipChallenge' ||
      model === 'SiteOptOutDomain'
        ? {}
        : { updatedAt: now }),
      ...data,
    };
    this.checkUnique(model, row);
    this.checkFk(model, row);
    this.tables[model].push(row);
    return { ...row };
  }

  private select(row: Row, select?: Row): Row {
    if (!select) return { ...row };
    return Object.fromEntries(
      Object.keys(select)
        .filter((k) => select[k])
        .map((k) => [k, row[k]]),
    );
  }

  private sorted(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const [field, dir] = Object.entries(orderBy as Row)[0];
    const sort = typeof dir === 'string' ? dir : (dir as Row).sort;
    const nulls = typeof dir === 'string' ? 'last' : (dir as Row).nulls;
    return [...rows].sort((a, b) => {
      const x = a[field];
      const y = b[field];
      if (x == null || y == null) {
        if (x == null && y == null) return 0;
        return (x == null) === (nulls === 'first') ? -1 : 1;
      }
      const c = cmp(x, y);
      return sort === 'desc' ? -c : c;
    });
  }

  exec(model: string, op: string, args: Row): unknown {
    const t = this.tables[model];
    const where = args.where as Row | undefined;
    switch (op) {
      case 'findMany': {
        let rows = this.sorted(
          t.filter((r) => matches(r, where)),
          args.orderBy,
        );
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        return rows.map((r) => this.select(r, args.select as Row));
      }
      case 'findFirst':
      case 'findUnique': {
        const rows = this.sorted(
          t.filter((r) => matches(r, where)),
          args.orderBy,
        );
        return rows[0] ? this.select(rows[0], args.select as Row) : null;
      }
      case 'count':
        return t.filter((r) => matches(r, where)).length;
      case 'create':
        return this.insert(model, args.data as Row);
      case 'update': {
        const row = t.find((r) => matches(r, where));
        if (!row) throw new PrismaLikeError('P2025');
        const next = { ...row, ...(args.data as Row), updatedAt: this.now() };
        this.checkUnique(model, next, row);
        Object.assign(row, next);
        return { ...row };
      }
      case 'updateMany': {
        const rows = t.filter((r) => matches(r, where));
        for (const r of rows) Object.assign(r, args.data as Row);
        return { count: rows.length };
      }
      case 'delete': {
        const row = t.find((r) => matches(r, where));
        if (!row) throw new PrismaLikeError('P2025');
        this.tables[model] = t.filter((r) => r !== row);
        this.cascade(model, row);
        return { ...row };
      }
      case 'deleteMany': {
        const rows = t.filter((r) => matches(r, where));
        this.tables[model] = t.filter((r) => !rows.includes(r));
        rows.forEach((r) => this.cascade(model, r));
        return { count: rows.length };
      }
      default:
        throw new Error(`fake db: операция ${op} не поддержана`);
    }
  }

  client(mode: Mode, reason?: string): Row {
    const tenant =
      mode === 'system' ? undefined : mode === 'guarded' ? null : mode.slice(8);
    const c: Row = {};
    for (const [prop, model] of Object.entries(MODELS)) {
      c[prop] = new Proxy(
        {},
        {
          get: (_t, op: string | symbol) =>
            typeof op !== 'string' || !OPS.has(op)
              ? undefined
              : async (args: Row = {}) => {
                  this.calls.push({ mode, model, op, reason });
                  const scoped =
                    tenant === undefined
                      ? args
                      : (scopeArgs(model, op, args, tenant) as Row);
                  return this.exec(model, op, scoped ?? {});
                },
        },
      );
    }
    c.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(c);
    c.$executeRaw = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      this.rawCalls.push(
        strings.join('?') + ' ' + values.map(String).join(','),
      );
      return 0;
    };
    return c;
  }

  sitesDb(): SitesDb {
    const reasons: string[] = [];
    const db = {
      guarded: this.client('guarded'),
      forAccount: (accountId: string) => {
        if (!accountId) throw new Error('forAccount: пустой accountId');
        return this.client(`account:${accountId}`);
      },
      system: (reason: string) => {
        if (!reason || reason.trim().length < 3)
          throw new Error('system(): причина');
        reasons.push(reason);
        return this.client('system', reason);
      },
    };
    return db as unknown as SitesDb;
  }

  rows<T = Row>(model: string): T[] {
    return this.tables[model] as T[];
  }
}
