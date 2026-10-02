/* eslint-disable @typescript-eslint/no-explicit-any -- дублёр Prisma */
/**
 * Перенос данных входа из колонок в хранилище (Э-С Ш2): dry-run ничего не
 * пишет, `--apply` переносит «как было» (личная запись) и обнуляет колонки,
 * повтор ничего не трогает, нечитаемое и изменённое во время переноса —
 * пропускается с отметкой в отчёте; в отчёте нет секретов.
 */
import { encryptCookieJar } from '../../common/cookie-jar';
import { FakeSitesCredentials } from '../../../test/fake-sites-credentials';
import { moveClientSiteCredentials } from './credentials-move';
import { encryptCredentials } from './draft-credentials';
import { DraftSecretsStore } from './draft-secrets-store';

const KEY = Buffer.alloc(32, 5).toString('base64');
const OTHER = Buffer.alloc(32, 6).toString('base64');
const FIELDS = [{ selector: '#pass', value: 'старый-пароль' }];
const COOKIE = {
  name: 'sid',
  value: 'v',
  domain: 'shop.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  expires: -1,
};

function rowOf(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    projectId: `p-${id}`,
    baseUrl: 'https://shop.example.com',
    credentialsEnc: encryptCredentials(FIELDS, KEY),
    cookiesEnc: encryptCookieJar([COOKIE], KEY),
    siteMode: 'A',
    siteHostId: 'host1',
    siteTestAccountId: null,
    userSiteSessionId: null,
    storeHasCredentials: false,
    project: { userId: `u-${id}` },
    ...over,
  } as Record<string, any>;
}

function matches(r: any, where: any): boolean {
  return Object.entries(where).every(([k, c]: [string, any]) => {
    if (k === 'AND') return c.every((w: any) => matches(r, w));
    if (k === 'OR') return c.some((w: any) => matches(r, w));
    if (c && typeof c === 'object' && 'not' in c) return r[k] !== c.not;
    if (c && typeof c === 'object' && 'notIn' in c)
      return !c.notIn.includes(r[k]);
    return r[k] === c;
  });
}

function setup(rows: Array<Record<string, any>>) {
  const fake = new FakeSitesCredentials();
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ telegramId: '77' }) },
    clientSiteTutorialDraft: {
      findMany: jest.fn(async ({ where, take }: any) =>
        rows.filter((r) => matches(r, where)).slice(0, take),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
  } as any;
  const store = new DraftSecretsStore(prisma, fake.client(), () => KEY, {
    log: jest.fn(),
    warn: jest.fn(),
  });
  const run = (apply: boolean) =>
    moveClientSiteCredentials({
      prisma,
      store,
      columnKey: KEY,
      apply,
      batch: 2,
    });
  return { fake, prisma, run };
}

describe('перенос данных входа из колонок (Ш2)', () => {
  it('dry-run: ничего не пишет ни в базу, ни в хранилище', async () => {
    const rows = [rowOf('a'), rowOf('b'), rowOf('c')];
    const { fake, prisma, run } = setup(rows);
    const rep = await run(false);
    expect(rep).toMatchObject({ candidates: 3, wouldMove: 3, moved: 0 });
    expect(prisma.clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
    expect(rows[0].credentialsEnc).toEqual(expect.any(String));
  });

  it('apply: каждый черновик → личная запись «как было», колонки обнулены; повтор ничего не трогает', async () => {
    const rows = [rowOf('a'), rowOf('b', { cookiesEnc: null }), rowOf('c')];
    const { fake, run } = setup(rows);
    const rep = await run(true);
    expect(rep).toMatchObject({ candidates: 3, moved: 3, failed: [] });
    for (const r of rows) {
      expect(r.credentialsEnc).toBeNull();
      expect(r.cookiesEnc).toBeNull();
      expect(r.siteTestAccountId).toBeNull();
      expect(r.userSiteSessionId).toMatch(/^user-/);
      expect(r.storeHasCredentials).toBe(true);
      const rec = fake.records.get(r.userSiteSessionId)!;
      expect(rec.owner).toBe(`gen:${r.project.userId}`);
      expect(JSON.parse(rec.secrets['login-fields']!)).toEqual(FIELDS);
    }
    expect(
      fake.records.get(rows[1].userSiteSessionId)!.secrets['session-cookies'],
    ).toBeUndefined();
    const before = fake.calls.length;
    const again = await run(true);
    expect(again).toMatchObject({ candidates: 0, moved: 0 });
    expect(fake.calls.length).toBe(before);
    expect(JSON.stringify(rep)).not.toContain('старый-пароль');
  });

  it('обрыв после записи в хранилище: повтор переиспользует ту же запись', async () => {
    const rows = [rowOf('a')];
    const { fake, prisma, run } = setup(rows);
    prisma.clientSiteTutorialDraft.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    const first = await run(true);
    expect(first.changed).toEqual(['a']);
    expect(fake.records.size).toBe(1);
    const second = await run(true);
    expect(second.moved).toBe(1);
    expect(fake.records.size).toBe(1);
  });

  it('нечитаемые колонки (другой ключ) и конфликт со ссылкой — не трогаются, в отчёте', async () => {
    const rows = [
      rowOf('bad', { credentialsEnc: encryptCredentials(FIELDS, OTHER) }),
      rowOf('both', { userSiteSessionId: 'user-x' }),
    ];
    const { run, fake } = setup(rows);
    const rep = await run(true);
    expect(rep.unreadable).toEqual(['bad']);
    expect(rep.conflicts).toEqual(['both']);
    // Нечитаемое даже не пытаемся переносить: ни записи в хранилище, ни сбоя.
    expect(rep.failed).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(rows[0].credentialsEnc).toEqual(expect.any(String));
  });

  it('хранилище недоступно — черновик в failed, колонки целы', async () => {
    const rows = [rowOf('a')];
    const { fake, run } = setup(rows);
    fake.offline = true;
    const rep = await run(true);
    expect(rep.failed).toEqual([
      { draftId: 'a', error: 'SitesUnavailableError' },
    ]);
    expect(rows[0].credentialsEnc).toEqual(expect.any(String));
  });
});
