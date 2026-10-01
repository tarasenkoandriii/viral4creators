import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  NON_TENANT_MODELS,
  TENANT_COLUMNS,
  TenantScopeError,
  scopeArgs,
  tenantExtension,
} from './tenant';
import { SitesDb } from './sites-db.service';
import { PrismaService } from './prisma.service';

const A = 'acc_A';
const B = 'acc_B';

describe('scopeArgs — режим «только проверка» (guarded)', () => {
  it('запрос к таблице кабинета без кабинета бросает', () => {
    expect(() => scopeArgs('SiteHost', 'findMany', undefined, null)).toThrow(
      TenantScopeError,
    );
    expect(() =>
      scopeArgs('Site', 'findFirst', { where: { name: 'X' } }, null),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs('SiteHost', 'updateMany', { where: {}, data: {} }, null),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs(
        'SiteAccount',
        'findUnique',
        { where: { verifyToken: 't' } },
        null,
      ),
    ).toThrow(TenantScopeError);
  });

  it('пустая строка кабинета — не кабинет', () => {
    expect(() =>
      scopeArgs('Site', 'findMany', { where: { accountId: '' } }, null),
    ).toThrow(TenantScopeError);
  });

  it('создание без кабинета бросает, в том числе в пакете', () => {
    expect(() =>
      scopeArgs('Site', 'create', { data: { name: 'X' } }, null),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs(
        'Site',
        'createMany',
        { data: [{ accountId: A, name: 'X' }, { name: 'Y' }] },
        null,
      ),
    ).toThrow(TenantScopeError);
  });

  it('с явным кабинетом запрос проходит без изменений', () => {
    const args = { where: { accountId: A, id: 'h1' } };
    expect(scopeArgs('SiteHost', 'findUnique', args, null)).toEqual(args);
  });

  it('модели вне тенанта не трогаются', () => {
    const args = { where: { domain: 'x.com' } };
    expect(scopeArgs('SiteOptOutDomain', 'findUnique', args, null)).toBe(args);
  });
});

describe('scopeArgs — режим кабинета (forAccount)', () => {
  it('подставляет кабинет в where и не меняет исходный объект', () => {
    const args = { where: { status: 'verified' } };
    expect(scopeArgs('SiteHost', 'findMany', args, A)).toEqual({
      where: { status: 'verified', accountId: A },
    });
    expect(args).toEqual({ where: { status: 'verified' } });
  });

  it('у кабинета колонка тенанта — id', () => {
    expect(scopeArgs('SiteAccount', 'findUnique', { where: {} }, A)).toEqual({
      where: { id: A },
    });
  });

  it('подставляет кабинет в data при создании (и в пакете)', () => {
    expect(scopeArgs('Site', 'create', { data: { name: 'X' } }, A)).toEqual({
      data: { name: 'X', accountId: A },
    });
    expect(
      scopeArgs(
        'Site',
        'createMany',
        { data: [{ name: 'X' }, { name: 'Y' }] },
        A,
      ),
    ).toEqual({
      data: [
        { name: 'X', accountId: A },
        { name: 'Y', accountId: A },
      ],
    });
  });

  it('чужой кабинет в запросе — отказ, а не тихая перезапись', () => {
    expect(() =>
      scopeArgs('SiteHost', 'findMany', { where: { accountId: B } }, A),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs('Site', 'create', { data: { accountId: B, name: 'X' } }, A),
    ).toThrow(TenantScopeError);
  });

  it('перенос строки в другой кабинет обновлением запрещён', () => {
    expect(() =>
      scopeArgs(
        'SiteHost',
        'update',
        { where: { id: 'h1' }, data: { accountId: B } },
        A,
      ),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs(
        'SiteHost',
        'update',
        { where: { id: 'h1', accountId: A }, data: { accountId: B } },
        null,
      ),
    ).toThrow(TenantScopeError);
  });

  it('upsert: кабинет и в where, и в create; update не переносит', () => {
    expect(
      scopeArgs(
        'Site',
        'upsert',
        { where: { id: 's1' }, create: { name: 'X' }, update: { name: 'Y' } },
        A,
      ),
    ).toEqual({
      where: { id: 's1', accountId: A },
      create: { name: 'X', accountId: A },
      update: { name: 'Y' },
    });
    expect(() =>
      scopeArgs(
        'Site',
        'upsert',
        {
          where: { id: 's1' },
          create: { name: 'X' },
          update: { accountId: B },
        },
        A,
      ),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs(
        'Site',
        'upsert',
        {
          where: { id: 's1', accountId: A },
          create: { accountId: B, name: 'X' },
          update: {},
        },
        null,
      ),
    ).toThrow(TenantScopeError);
  });

  it('неизвестная операция — закрытый отказ', () => {
    expect(() => scopeArgs('Site', 'findRaw', {}, A)).toThrow(/не известна/);
  });

  it('пустой кабинет в контексте — отказ', () => {
    expect(() => scopeArgs('Site', 'findMany', {}, '')).toThrow(
      TenantScopeError,
    );
  });
});

describe('каждая модель схемы классифицирована', () => {
  it('модель либо в TENANT_COLUMNS, либо в NON_TENANT_MODELS — не в обоих', () => {
    const models = Object.values(Prisma.ModelName) as string[];
    expect(models.length).toBeGreaterThan(5);
    const unclassified = models.filter(
      (m) => !(m in TENANT_COLUMNS) && !(m in NON_TENANT_MODELS),
    );
    const both = models.filter(
      (m) => m in TENANT_COLUMNS && m in NON_TENANT_MODELS,
    );
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
    // И наоборот: в списках нет моделей, которых уже нет в схеме.
    const stale = [
      ...Object.keys(TENANT_COLUMNS),
      ...Object.keys(NON_TENANT_MODELS),
    ].filter((m) => !models.includes(m));
    expect(stale).toEqual([]);
  });
});

/**
 * Настоящий клиент Prisma с extension'ом. База недостижима (порт 9) —
 * отказ тенанта обязан случиться ДО похода в базу, то есть тест не
 * зависит от наличия Postgres.
 */
describe('extension на настоящем PrismaClient', () => {
  const UNREACHABLE = 'postgresql://u:p@127.0.0.1:9/none';

  function client() {
    return new PrismaClient({ adapter: new PrismaPg(UNREACHABLE) });
  }

  it('guarded: запрос без тенанта бросает TenantScopeError', async () => {
    const db = client().$extends(tenantExtension(null));
    await expect(db.siteHost.findMany({})).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    await expect(
      db.site.create({ data: { name: 'X' } as never }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('forAccount: в запрос уходит кабинет контекста', async () => {
    const seen: unknown[] = [];
    const stop = new Error('стоп до базы');
    // Query-extension'ы выполняются в порядке подключения: слой,
    // подключённый ПОСЛЕ тенанта, видит уже подставленный кабинет и
    // обрывает запрос, не доходя до базы.
    const db = client()
      .$extends(tenantExtension(A))
      .$extends({
        query: {
          $allModels: {
            async $allOperations({ args }) {
              seen.push(args);
              throw stop;
            },
          },
        },
      });
    await expect(
      db.siteHost.findMany({ where: { status: 'verified' } }),
    ).rejects.toBe(stop);
    expect(seen).toEqual([{ where: { status: 'verified', accountId: A } }]);
  });

  it('SitesDb: forAccount/guarded/system', async () => {
    const saved = process.env.SITES_DATABASE_URL;
    process.env.SITES_DATABASE_URL = UNREACHABLE;
    try {
      const prisma = new PrismaService();
      const sitesDb = new SitesDb(prisma);
      await expect(sitesDb.guarded.site.findMany()).rejects.toBeInstanceOf(
        TenantScopeError,
      );
      await expect(
        sitesDb.forAccount(A).site.findMany({ where: { accountId: B } }),
      ).rejects.toBeInstanceOf(TenantScopeError);
      expect(() => sitesDb.forAccount('')).toThrow(TenantScopeError);
      expect(() => sitesDb.system('')).toThrow(TenantScopeError);
      expect(sitesDb.system('крон перепроверки владения')).toBe(prisma);
    } finally {
      if (saved === undefined) delete process.env.SITES_DATABASE_URL;
      else process.env.SITES_DATABASE_URL = saved;
    }
  });
});
