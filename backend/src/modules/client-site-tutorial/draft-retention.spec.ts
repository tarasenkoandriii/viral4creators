/* eslint-disable @typescript-eslint/no-explicit-any -- дублёры Prisma и Blob */
/**
 * Сроки хранения данных входа и кадров обучалки (Ш0.5/Ш0.6 аудита
 * 02.10.2026, риски В-1, В-2). Prisma — дублёр, который ИСПОЛНЯЕТ
 * `where` на массиве строк: проверяется не «какой запрос ушёл», а какие
 * строки после прогона остались с секретами и кадрами.
 */

import {
  ABANDONED_FRAMES_RETENTION_DAYS,
  ClientSiteDraftRetention,
  DECIDED_FRAMES_RETENTION_DAYS,
  FRAMES_PURGE_BATCH,
  PENDING_REVIEW_WARN_DAYS,
  SECRETS_RETENTION_DAYS,
} from './draft-retention';

const NOW = new Date('2026-10-02T03:50:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

interface Row {
  id: string;
  status: string;
  updatedAt: Date;
  secretsUsedAt: Date | null;
  secretsOneShot: boolean;
  credentialsEnc: string | null;
  cookiesEnc: string | null;
  framesPurgedAt: Date | null;
  roundVideoFrames: unknown;
  previewFrameCount: number | null;
  /** Э-С Ш2: запись хранилища sites-backend. */
  siteTestAccountId?: string | null;
  userSiteSessionId?: string | null;
  storeHasCredentials?: boolean;
  project?: { userId: string };
}

function row(over: Partial<Row> & { id: string }): Row {
  return {
    status: 'DRAFTING',
    updatedAt: daysAgo(1),
    secretsUsedAt: daysAgo(1),
    secretsOneShot: false,
    credentialsEnc: 'enc-creds',
    cookiesEnc: 'enc-cookies',
    framesPurgedAt: null,
    roundVideoFrames: ['https://blob/x/round-0.png'],
    previewFrameCount: 1,
    siteTestAccountId: null,
    userSiteSessionId: null,
    storeHasCredentials: false,
    project: { userId: 'u1' },
    ...over,
  };
}

/** Мини-исполнитель `where` Prisma — ровно те операторы, что в модуле. */
function matches(r: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]: [string, any]) => {
    if (k === 'AND') return cond.every((w: any) => matches(r, w));
    if (k === 'OR') return cond.some((w: any) => matches(r, w));
    const v = r[k];
    if (cond === null) return v === null;
    if (cond instanceof Date) return v?.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('not' in cond) return cond.not === null ? v !== null : v !== cond.not;
      if ('gte' in cond && !(v !== null && v >= cond.gte)) return false;
      if ('lt' in cond) return v !== null && v < cond.lt;
      if ('in' in cond) return cond.in.includes(v);
    }
    return v === cond;
  });
}

function fakePrisma(
  rows: Row[],
  assets: Array<{ clientSiteDraftId: string; assemblyStatus: string }>,
) {
  return {
    clientSiteTutorialDraft: {
      findMany: jest.fn(async ({ where, take }: any) =>
        rows.filter((r) => matches(r, where)).slice(0, take ?? Infinity),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    tutorialVideoAsset: {
      findMany: jest.fn(async ({ where }: any) =>
        assets.filter((a) => matches(a, where)),
      ),
    },
  };
}

function fakeBlob(paths: string[], failOn?: string) {
  const store = new Set(paths);
  return {
    store,
    listByPrefix: jest.fn(async (prefix: string) => {
      if (failOn && prefix.includes(failOn)) throw new Error('Blob икнул');
      return {
        blobs: [...store]
          .filter((p) => p.startsWith(prefix))
          .map((pathname) => ({ pathname })),
        cursor: null,
      };
    }),
    deleteMany: jest.fn(async (ps: string[]) => {
      for (const p of ps) store.delete(p);
      return ps.length;
    }),
  };
}

const quiet = { log: jest.fn(), warn: jest.fn() };

function retention(
  rows: Row[],
  assets: any[] = [],
  blob = fakeBlob([]),
  secrets?: any,
  notify?: { alert: jest.Mock },
) {
  const prisma = fakePrisma(rows, assets);
  return {
    r: new ClientSiteDraftRetention(
      prisma as any,
      blob as any,
      quiet,
      secrets,
      notify,
    ),
    prisma,
    blob,
  };
}

/** Дублёр хранилища Ш2: что стёрто. */
function fakeSecrets() {
  const forgotten: string[] = [];
  return {
    forgotten,
    userOf: jest.fn(async (userId: string) => ({ userId, telegramId: '1' })),
    forget: jest.fn(async (_u: any, d: any) => {
      forgotten.push(d.userSiteSessionId ?? d.siteTestAccountId);
      return {};
    }),
  };
}

describe('Ш0.5: срок хранения кредов и кук', () => {
  it(`${SECRETS_RETENTION_DAYS} дней без раундов — обе колонки стёрты; свежие — нетронуты`, async () => {
    const old = row({
      id: 'old',
      secretsUsedAt: daysAgo(SECRETS_RETENTION_DAYS + 1),
    });
    const fresh = row({
      id: 'fresh',
      secretsUsedAt: daysAgo(SECRETS_RETENTION_DAYS - 1),
    });
    const { r } = retention([old, fresh]);
    const res = await r.run(NOW);
    expect(res.secretsExpired).toBe(1);
    expect([old.credentialsEnc, old.cookiesEnc]).toEqual([null, null]);
    expect([fresh.credentialsEnc, fresh.cookiesEnc]).toEqual([
      'enc-creds',
      'enc-cookies',
    ]);
  });

  it('строка до Ш0.5 (secretsUsedAt пуст) — срок от updatedAt', async () => {
    const legacy = row({
      id: 'legacy',
      secretsUsedAt: null,
      updatedAt: daysAgo(SECRETS_RETENTION_DAYS + 5),
      roundVideoFrames: null,
      framesPurgedAt: daysAgo(1),
    });
    const { r } = retention([legacy]);
    await r.run(NOW);
    expect(legacy.credentialsEnc).toBeNull();
    expect(legacy.cookiesEnc).toBeNull();
  });

  it('«одноразово»: ролик собран — креды стёрты сразу, без ожидания срока', async () => {
    const once = row({ id: 'once', secretsOneShot: true, status: 'APPROVED' });
    const notBuilt = row({
      id: 'nb',
      secretsOneShot: true,
      status: 'APPROVED',
    });
    const keep = row({ id: 'keep', secretsOneShot: false, status: 'APPROVED' });
    const { r } = retention(
      [once, notBuilt, keep],
      [
        { clientSiteDraftId: 'once', assemblyStatus: 'complete' },
        { clientSiteDraftId: 'nb', assemblyStatus: 'failed' },
        { clientSiteDraftId: 'keep', assemblyStatus: 'complete' },
      ],
    );
    const res = await r.run(NOW);
    expect(res.secretsOneShot).toBe(1);
    expect(once.credentialsEnc).toBeNull();
    expect(notBuilt.credentialsEnc).toBe('enc-creds');
    expect(keep.credentialsEnc).toBe('enc-creds');
  });
});

describe('Ш0.6: срок жизни кадров в публичном Blob', () => {
  const decidedOld = daysAgo(DECIDED_FRAMES_RETENTION_DAYS + 1);

  it('отклонённый давно — весь префикс стёрт, ссылки обнулены, отметка поставлена', async () => {
    const rej = row({
      id: 'rej',
      status: 'REJECTED',
      updatedAt: decidedOld,
      roundVideoFrames: ['a', 'b'],
    });
    const blob = fakeBlob([
      'tutorial-video-frames/rej/KEYKEYKEYKEYKEYKEYKEYKEY/round-0.png',
      'tutorial-video-frames/rej/0.jpg',
      'tutorial-video-frames/other/0.jpg',
    ]);
    const { r } = retention([rej], [], blob);
    const res = await r.run(NOW);
    expect(res.framesPurged).toBe(1);
    expect([...blob.store]).toEqual(['tutorial-video-frames/other/0.jpg']);
    expect(rej.roundVideoFrames).toEqual([null, null]);
    expect(rej.previewFrameCount).toBeNull();
    expect(rej.framesPurgedAt).toEqual(NOW);
  });

  it('одобренный: стирается только когда ролик СОБРАН', async () => {
    const built = row({
      id: 'built',
      status: 'APPROVED',
      updatedAt: decidedOld,
    });
    const pending = row({
      id: 'pending',
      status: 'APPROVED',
      updatedAt: decidedOld,
    });
    const blob = fakeBlob([
      'tutorial-video-frames/built/0.png',
      'tutorial-video-frames/pending/0.png',
    ]);
    const { r } = retention(
      [built, pending],
      [
        { clientSiteDraftId: 'built', assemblyStatus: 'complete' },
        { clientSiteDraftId: 'pending', assemblyStatus: 'preparing' },
      ],
      blob,
    );
    await r.run(NOW);
    expect([...blob.store]).toEqual(['tutorial-video-frames/pending/0.png']);
    expect(pending.framesPurgedAt).toBeNull();
  });

  it('недавно решённый и живой черновик — не трогаются', async () => {
    const recent = row({
      id: 'recent',
      status: 'REJECTED',
      updatedAt: daysAgo(2),
    });
    const working = row({
      id: 'working',
      status: 'DRAFTING',
      updatedAt: daysAgo(20),
    });
    // На одобрении меньше срока брошенного — ещё живой.
    const review = row({
      id: 'review',
      status: 'PENDING_REVIEW',
      updatedAt: daysAgo(ABANDONED_FRAMES_RETENTION_DAYS - 1),
    });
    const blob = fakeBlob([
      'tutorial-video-frames/recent/0.png',
      'tutorial-video-frames/working/round-0.png',
      'tutorial-video-frames/review/0.png',
    ]);
    const { r } = retention([recent, working, review], [], blob);
    const res = await r.run(NOW);
    expect(res.framesPurged).toBe(0);
    expect(blob.store.size).toBe(3);
  });

  it('брошенный в работе больше 30 дней — кадры стёрты', async () => {
    const gone = row({
      id: 'gone',
      status: 'DRAFTING',
      updatedAt: daysAgo(31),
    });
    const blob = fakeBlob(['tutorial-video-frames/gone/round-0.png']);
    const { r } = retention([gone], [], blob);
    await r.run(NOW);
    expect(blob.store.size).toBe(0);
  });

  it('хранилище отказало — отметка снята, повтор завтра', async () => {
    const rej = row({ id: 'rej', status: 'REJECTED', updatedAt: decidedOld });
    const blob = fakeBlob(['tutorial-video-frames/rej/0.png'], 'rej');
    const { r } = retention([rej], [], blob);
    const res = await r.run(NOW);
    expect(res).toMatchObject({ framesPurged: 0, framesFailed: 1 });
    expect(rej.framesPurgedAt).toBeNull();
  });
});

describe('Э-С Ш2: данные входа в хранилище sites-backend', () => {
  it('срок: запись хранилища стёрта там, ссылки и колонки обнулены; свежая — нетронута', async () => {
    const old = row({
      id: 'old',
      credentialsEnc: null,
      cookiesEnc: null,
      userSiteSessionId: 'user-1',
      storeHasCredentials: true,
      secretsUsedAt: daysAgo(SECRETS_RETENTION_DAYS + 1),
    });
    const fresh = row({
      id: 'fresh',
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: 'site-2',
    });
    const secrets = fakeSecrets();
    const { r } = retention([old, fresh], [], fakeBlob([]), secrets);
    const res = await r.run(NOW);
    expect(res.secretsExpired).toBe(1);
    expect(secrets.forgotten).toEqual(['user-1']);
    expect(old).toMatchObject({
      userSiteSessionId: null,
      siteTestAccountId: null,
      storeHasCredentials: false,
    });
    expect(fresh.siteTestAccountId).toBe('site-2');
  });

  it('«одноразово»: после сборки — стёрто и в хранилище', async () => {
    const once = row({
      id: 'once',
      status: 'APPROVED',
      secretsOneShot: true,
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: 'site-7',
    });
    const secrets = fakeSecrets();
    const { r } = retention(
      [once],
      [{ clientSiteDraftId: 'once', assemblyStatus: 'complete' }],
      fakeBlob([]),
      secrets,
    );
    const res = await r.run(NOW);
    expect(res.secretsOneShot).toBe(1);
    expect(secrets.forgotten).toEqual(['site-7']);
    expect(once.siteTestAccountId).toBeNull();
  });

  it('хранилище не отвечает — колонки и ссылки всё равно обнулены (запись истечёт по сроку там)', async () => {
    const old = row({
      id: 'old',
      userSiteSessionId: 'user-1',
      secretsUsedAt: daysAgo(SECRETS_RETENTION_DAYS + 1),
    });
    const secrets = fakeSecrets();
    secrets.forget.mockRejectedValue(new Error('нет связи'));
    const { r } = retention([old], [], fakeBlob([]), secrets);
    await r.run(NOW);
    expect(old.userSiteSessionId).toBeNull();
    expect(old.credentialsEnc).toBeNull();
  });

  describe('черновик на одобрении и пачка уборки (аудит кронов 06.10.2026)', () => {
    it('на одобрении дольше срока брошенного — кадры стёрты (снимки кабинета не хранятся бессрочно)', async () => {
      const review = row({
        id: 'review',
        status: 'PENDING_REVIEW',
        updatedAt: daysAgo(ABANDONED_FRAMES_RETENTION_DAYS + 1),
      });
      const blob = fakeBlob(['tutorial-video-frames/review/0.png']);
      const { r } = retention([review], [], blob);
      const res = await r.run(NOW);
      expect(res.framesPurged).toBe(1);
      expect(blob.store.size).toBe(0);
      expect(review.framesPurgedAt).toEqual(NOW);
    });

    it('одобренные без сборки не занимают пачку — остальные убираются', async () => {
      // Раньше полсотни старейших одобренных без ролика забивали
      // `FRAMES_PURGE_BATCH` и пропускались уже в цикле — каждый день.
      const stuck = Array.from({ length: FRAMES_PURGE_BATCH }, (_, i) =>
        row({
          id: `stuck-${i}`,
          status: 'APPROVED',
          updatedAt: daysAgo(400 - i),
        }),
      );
      const rej = row({
        id: 'rej',
        status: 'REJECTED',
        updatedAt: daysAgo(DECIDED_FRAMES_RETENTION_DAYS + 1),
      });
      const blob = fakeBlob(['tutorial-video-frames/rej/0.png']);
      const { r } = retention([...stuck, rej], [], blob);
      const res = await r.run(NOW);
      expect(res.framesPurged).toBe(1);
      expect(blob.store.size).toBe(0);
      expect(stuck.every((d) => d.framesPurgedAt === null)).toBe(true);
    });

    it('за неделю до стирания — одна тревога оператору со списком', async () => {
      const warnAt = ABANDONED_FRAMES_RETENTION_DAYS - PENDING_REVIEW_WARN_DAYS;
      const due = row({
        id: 'due',
        status: 'PENDING_REVIEW',
        updatedAt: new Date(daysAgo(warnAt).getTime() - 3600_000),
      });
      (due as any).title = 'Сайт Ромашка';
      const early = row({
        id: 'early',
        status: 'PENDING_REVIEW',
        updatedAt: daysAgo(warnAt - 2),
      });
      const late = row({
        id: 'late',
        status: 'PENDING_REVIEW',
        updatedAt: daysAgo(warnAt + 2),
      });
      const notify = { alert: jest.fn().mockResolvedValue(true) };
      const { r } = retention(
        [due, early, late],
        [],
        fakeBlob([]),
        undefined,
        notify,
      );
      const res = await r.run(NOW);
      expect(res.pendingReviewWarned).toBe(1);
      expect(notify.alert).toHaveBeenCalledTimes(1);
      expect(notify.alert).toHaveBeenCalledWith(
        'client-site-retention:pending-review',
        expect.stringContaining('Сайт Ромашка'),
      );
    });
  });
});
