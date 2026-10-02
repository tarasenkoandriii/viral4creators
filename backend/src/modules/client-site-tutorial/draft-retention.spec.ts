/* eslint-disable @typescript-eslint/no-explicit-any -- дублёры Prisma и Blob */
/**
 * Сроки хранения данных входа и кадров обучалки (Ш0.5/Ш0.6 аудита
 * 02.10.2026, риски В-1, В-2). Prisma — дублёр, который ИСПОЛНЯЕТ
 * `where` на массиве строк: проверяется не «какой запрос ушёл», а какие
 * строки после прогона остались с секретами и кадрами.
 */

import {
  ClientSiteDraftRetention,
  DECIDED_FRAMES_RETENTION_DAYS,
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

function retention(rows: Row[], assets: any[] = [], blob = fakeBlob([])) {
  const prisma = fakePrisma(rows, assets);
  return {
    r: new ClientSiteDraftRetention(prisma as any, blob as any, quiet),
    prisma,
    blob,
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
    const review = row({
      id: 'review',
      status: 'PENDING_REVIEW',
      updatedAt: daysAgo(90),
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
