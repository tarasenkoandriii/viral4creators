/* eslint-disable @typescript-eslint/no-explicit-any -- дублёры Prisma */
/**
 * Где живут данные входа черновика (Э-С Ш2): колонки, пока хранилище не
 * включено (фолбэк), реестр сайта в режиме A (аренда), личная запись в
 * режиме B, переезд из колонок, отказы и недоступность.
 */
import { CdpCookie, encryptCookieJar } from '../../common/cookie-jar';
import { FakeSitesCredentials } from '../../../test/fake-sites-credentials';
import { decryptCredentials, encryptCredentials } from './draft-credentials';
import {
  DraftSecretsRow,
  DraftSecretsStore,
  DraftSecretsUnavailableError,
  credentialsStoreMode,
} from './draft-secrets-store';

const KEY = Buffer.alloc(32, 9).toString('base64');
const COOKIE: CdpCookie = {
  name: 'sid',
  value: 'v1',
  domain: 'shop.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  expires: -1,
};
const FIELDS = [{ selector: '#pass', value: 'секрет' }];
const A_USER = { userId: 'u1', telegramId: '4242' };

function draft(over: Partial<DraftSecretsRow> = {}): DraftSecretsRow {
  return {
    id: 'd1',
    projectId: 'p1',
    baseUrl: 'https://shop.example.com',
    credentialsEnc: null,
    cookiesEnc: null,
    siteMode: 'B',
    siteHostId: null,
    ...over,
  };
}

function make(opts: { store?: boolean } = {}) {
  const fake = new FakeSitesCredentials();
  const logger = { log: jest.fn(), warn: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ telegramId: '4242' }) },
  } as any;
  const store = new DraftSecretsStore(prisma, fake.client(), () => KEY, logger);
  store.env =
    opts.store === false ? {} : { SITE_TUTORIAL_CREDENTIALS_STORE: 'sites' };
  return { fake, store, logger };
}

describe('переключатель хранилища', () => {
  it('только `sites` включает хранилище', () => {
    expect(credentialsStoreMode({})).toBe('columns');
    expect(
      credentialsStoreMode({ SITE_TUTORIAL_CREDENTIALS_STORE: 'Sites ' }),
    ).toBe('sites');
    expect(
      credentialsStoreMode({ SITE_TUTORIAL_CREDENTIALS_STORE: 'on' }),
    ).toBe('columns');
  });
});

describe('фолбэк: хранилище не включено — колонки, как до Ш2', () => {
  it('запись — шифротекст в колонках, в sites-backend ни одного вызова; предупреждение в лог один раз', async () => {
    const { fake, store, logger } = make({ store: false });
    const patch = await store.write(A_USER, draft(), {
      fields: FIELDS,
      cookies: [COOKIE],
    });
    expect(Object.keys(patch).sort()).toEqual(['cookiesEnc', 'credentialsEnc']);
    expect(decryptCredentials(patch.credentialsEnc!, KEY)).toEqual(FIELDS);
    expect(fake.calls).toEqual([]);
    await store.write(A_USER, draft(), { cookies: [COOKIE] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(
      'SITE_TUTORIAL_CREDENTIALS_STORE',
    );
  });

  it('чтение колонок', async () => {
    const { store } = make({ store: false });
    const got = await store.read(
      A_USER,
      draft({
        credentialsEnc: encryptCredentials(FIELDS, KEY),
        cookiesEnc: encryptCookieJar([COOKIE], KEY),
      }),
    );
    expect(got.fields).toEqual(FIELDS);
    expect(got.cookies.map((c) => c.name)).toEqual(['sid']);
    expect(got.lost).toBe(false);
  });

  it('sites-backend без ключей (CREDENTIALS_NOT_CONFIGURED) или недоступен при ПЕРВОЙ записи — колонки, не падение', async () => {
    for (const mode of ['unconfigured', 'offline'] as const) {
      const { fake, store, logger } = make();
      fake[mode] = true;
      const patch = await store.write(A_USER, draft(), { cookies: [COOKIE] });
      expect(patch.cookiesEnc).toEqual(expect.any(String));
      expect(patch.userSiteSessionId).toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    }
  });

  it('пустые куки и нет полей — ничего не пишем (как encryptCookies до Ш2)', async () => {
    const { fake, store } = make();
    await expect(
      store.write(A_USER, draft(), { cookies: [] }),
    ).resolves.toEqual({});
    expect(fake.calls).toEqual([]);
  });
});

describe('режим B: личная запись', () => {
  it('первая запись заводит личную запись по черновику, колонки обнуляются', async () => {
    const { fake, store } = make();
    const patch = await store.write(A_USER, draft(), {
      fields: FIELDS,
      cookies: [COOKIE],
    });
    expect(patch).toMatchObject({
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: null,
      userSiteSessionId: expect.stringMatching(/^user-/),
      storeHasCredentials: true,
    });
    const rec = fake.records.get(patch.userSiteSessionId!)!;
    expect(rec.owner).toBe('gen:u1');
    expect(rec.clientRef).toBe('draft:d1');
    expect(JSON.parse(rec.secrets['login-fields']!)).toEqual(FIELDS);
    const got = await store.read(A_USER, draft({ ...patch } as any));
    expect(got.fields).toEqual(FIELDS);
    expect(got.cookies[0].name).toBe('sid');
  });

  it('переезд из колонок по ходу раунда: то, чего нет в раунде, берётся из колонок', async () => {
    const { fake, store } = make();
    const patch = await store.write(
      A_USER,
      draft({ credentialsEnc: encryptCredentials(FIELDS, KEY) }),
      { cookies: [COOKIE] },
    );
    const rec = fake.records.get(patch.userSiteSessionId!)!;
    expect(JSON.parse(rec.secrets['login-fields']!)).toEqual(FIELDS);
    expect(rec.secrets['session-cookies']).toContain('sid');
    expect(patch.storeHasCredentials).toBe(true);
  });

  it('запись пропала (истекла) — заводится новая; хранилище недоступно — 503, не колонки', async () => {
    const { fake, store } = make();
    const first = await store.write(A_USER, draft(), { cookies: [COOKIE] });
    fake.records.clear();
    const d = draft({ userSiteSessionId: first.userSiteSessionId });
    const read = await store.read(A_USER, d);
    expect(read).toEqual({
      fields: [],
      cookies: [],
      loginEvidence: false,
      lost: true,
    });
    const again = await store.write(A_USER, d, { cookies: [COOKIE] });
    expect(again.userSiteSessionId).not.toBe(first.userSiteSessionId);
    fake.offline = true;
    await expect(
      store.write(
        A_USER,
        draft({ userSiteSessionId: again.userSiteSessionId }),
        {
          cookies: [COOKIE],
        },
      ),
    ).rejects.toBeInstanceOf(DraftSecretsUnavailableError);
    await expect(
      store.read(A_USER, draft({ userSiteSessionId: again.userSiteSessionId })),
    ).rejects.toBeInstanceOf(DraftSecretsUnavailableError);
  });
});

describe('режим A: реестр сайта', () => {
  const aDraft = (over: Partial<DraftSecretsRow> = {}) =>
    draft({ siteMode: 'A', siteHostId: 'host1', ...over });

  it('черновик A заводит тестовую учётку реестра на хосте черновика; чтение — арендой на раунд', async () => {
    const { fake, store } = make();
    const patch = await store.write(A_USER, aDraft(), {
      fields: FIELDS,
      cookies: [COOKIE],
    });
    expect(patch.siteTestAccountId).toMatch(/^site-/);
    expect(patch.userSiteSessionId).toBeNull();
    const rec = fake.records.get(patch.siteTestAccountId!)!;
    expect(rec.hostIds).toEqual(['host1']);
    expect(rec.owner).toBe('4242');
    const got = await store.read(A_USER, aDraft({ ...patch } as any));
    expect(got.fields).toEqual(FIELDS);
    expect(fake.calls).toContain('leaseSecrets:draft:d1');
  });

  it('кабинет не дал завести учётку (роль/хост) — личная запись B', async () => {
    const { fake, store } = make();
    fake.refuseSite = true;
    const patch = await store.write(A_USER, aDraft(), { cookies: [COOKIE] });
    expect(patch.siteTestAccountId).toBeNull();
    expect(patch.userSiteSessionId).toMatch(/^user-/);
  });

  it('нет Telegram-id — сразу личная запись', async () => {
    const { store } = make();
    const patch = await store.write(
      { userId: 'u1', telegramId: null },
      aDraft(),
      { cookies: [COOKIE] },
    );
    expect(patch.userSiteSessionId).toMatch(/^user-/);
  });

  it('аренда отказана (хост не тот / учётка удалена в кабинете) — данные потеряны, раунд без сессии', async () => {
    const { store } = make();
    const patch = await store.write(A_USER, aDraft(), { cookies: [COOKIE] });
    const got = await store.read(
      A_USER,
      aDraft({ ...patch, siteHostId: 'host-other' } as any),
    );
    expect(got.lost).toBe(true);
    expect(got.cookies).toEqual([]);
  });

  it('учётку удалили в кабинете — следующая запись уходит в новую личную запись', async () => {
    const { fake, store } = make();
    const patch = await store.write(A_USER, aDraft(), { cookies: [COOKIE] });
    fake.records.delete(patch.siteTestAccountId!);
    const next = await store.write(A_USER, aDraft({ ...patch } as any), {
      cookies: [COOKIE],
    });
    expect(next.siteTestAccountId).toBeNull();
    expect(next.userSiteSessionId).toMatch(/^user-/);
  });
});

describe('стирание и перенос', () => {
  it('forget: личная запись удаляется, у учётки A стираются секреты; ссылки обнулены', async () => {
    const { fake, store } = make();
    const b = await store.write(A_USER, draft(), { cookies: [COOKIE] });
    const pb = await store.forget(A_USER, draft({ ...b } as any));
    expect(fake.records.has(b.userSiteSessionId!)).toBe(false);
    expect(pb).toMatchObject({
      userSiteSessionId: null,
      storeHasCredentials: false,
    });
    const a = await store.write(
      A_USER,
      draft({ siteMode: 'A', siteHostId: 'host1' }),
      { fields: FIELDS },
    );
    await store.forget(A_USER, draft({ ...a } as any));
    expect(fake.records.get(a.siteTestAccountId!)!.secrets).toEqual({});
  });

  it('forget при недоступном хранилище — не бросает (истечёт по сроку)', async () => {
    const { fake, store, logger } = make();
    const b = await store.write(A_USER, draft(), { cookies: [COOKIE] });
    fake.offline = true;
    await expect(
      store.forget(A_USER, draft({ ...b } as any)),
    ).resolves.toMatchObject({
      userSiteSessionId: null,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('аудит Ш2: старая личная запись не стёрлась, новый черновик того же проекта на другом сайте — пишется в свою запись', async () => {
    const { fake, store } = make();
    const old = await store.write(A_USER, draft(), { fields: FIELDS });
    fake.offline = true;
    await store.forget(A_USER, draft({ ...old } as any));
    fake.offline = false;
    expect(fake.records.has(old.userSiteSessionId!)).toBe(true);
    const fresh = await store.write(
      A_USER,
      draft({ id: 'd2', baseUrl: 'https://other.example.org' }),
      { fields: FIELDS },
    );
    expect(fresh.userSiteSessionId).toBeTruthy();
    expect(fresh.userSiteSessionId).not.toBe(old.userSiteSessionId);
    expect(fake.records.get(fresh.userSiteSessionId!)!.origin).toBe(
      'https://other.example.org',
    );
  });

  it('moveFromColumns: «как было» — личная запись, поля и куки перенесены', async () => {
    const { fake, store } = make();
    const moved = await store.moveFromColumns(
      A_USER,
      draft({
        siteMode: 'A',
        siteHostId: 'host1',
        credentialsEnc: encryptCredentials(FIELDS, KEY),
        cookiesEnc: encryptCookieJar([COOKIE], KEY),
      }),
    );
    expect(moved).toMatchObject({
      credentialsEnc: null,
      cookiesEnc: null,
      userSiteSessionId: expect.stringMatching(/^user-/),
      storeHasCredentials: true,
      moved: { fields: true, cookies: true },
    });
    const rec = fake.records.get(moved.userSiteSessionId!)!;
    expect(rec.clientRef).toBe('draft:d1');
    expect(Object.keys(rec.secrets).sort()).toEqual([
      'login-fields',
      'session-cookies',
    ]);
  });
});

describe('аудит Э6, Д1: признак входа (липкий loginUsedAt)', () => {
  const aDraft = (over: Partial<DraftSecretsRow> = {}) =>
    draft({ siteMode: 'A', siteHostId: 'host1', ...over });

  it('колонки: куки первой стороны — не вход; поля входа — вход', async () => {
    const { store } = make({ store: false });
    const cookiesOnly = await store.read(
      A_USER,
      draft({ cookiesEnc: encryptCookieJar([COOKIE], KEY) }),
    );
    expect(cookiesOnly.loginEvidence).toBe(false);
    const withFields = await store.read(
      A_USER,
      draft({ credentialsEnc: encryptCredentials(FIELDS, KEY) }),
    );
    expect(withFields.loginEvidence).toBe(true);
  });

  it('B: личная запись только с куками раундов — не вход; с полями входа — вход', async () => {
    const { store } = make();
    const patch = await store.write(A_USER, draft(), { cookies: [COOKIE] });
    expect(patch).not.toHaveProperty('loginUsedAt');
    const d = draft({ ...patch } as any);
    expect((await store.read(A_USER, d)).loginEvidence).toBe(false);
    await store.write(A_USER, d, { fields: FIELDS });
    expect((await store.read(A_USER, d)).loginEvidence).toBe(true);
  });

  it('A: учётка с куками раундов — не вход; пароль из кабинета — вход', async () => {
    const { fake, store } = make();
    const patch = await store.write(A_USER, aDraft(), { cookies: [COOKIE] });
    expect(patch).not.toHaveProperty('loginUsedAt');
    const d = aDraft({ ...patch } as any);
    expect((await store.read(A_USER, d)).loginEvidence).toBe(false);
    fake.records.get(patch.siteTestAccountId!)!.secrets.password =
      'из-кабинета';
    expect((await store.read(A_USER, d)).loginEvidence).toBe(true);
  });

  it('привязка к записи, где уже лежали секреты (прежний черновик проекта), — вход', async () => {
    const { fake, store } = make();
    // Учётка проекта осталась от прошлого черновика (стирание не дошло).
    const old = await fake.client().upsertTestAccount('4242', {
      hostId: 'host1',
      clientRef: 'project:p1',
      account: {},
    });
    await fake
      .client()
      .putTestAccountSecret('4242', old.id, 'session-cookies', '[]');
    const patch = await store.write(A_USER, aDraft({ id: 'd2' }), {
      cookies: [COOKIE],
    });
    expect(patch.siteTestAccountId).toBe(old.id);
    expect(patch.loginUsedAt).toEqual(expect.any(Date));
  });

  it('стирание и перенос признак не снимают (в патче его нет вовсе)', async () => {
    const { store } = make();
    const patch = await store.write(A_USER, draft(), { cookies: [COOKIE] });
    const forgotten = await store.forget(A_USER, draft({ ...patch } as any));
    expect(forgotten).not.toHaveProperty('loginUsedAt');
    const moved = await make().store.moveFromColumns(
      A_USER,
      draft({ credentialsEnc: encryptCredentials(FIELDS, KEY) }),
    );
    expect(moved.loginUsedAt).toEqual(expect.any(Date));
  });
});
