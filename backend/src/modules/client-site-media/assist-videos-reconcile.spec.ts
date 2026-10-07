/**
 * W7 (Э6-хвост): ночная сверка наборов роликов сайтов помощника — шлёт
 * только изменившиеся и не дошедшие наборы, держит потолки прогона, не
 * трогает сайт лендинга, забывает пустой принятый набор сайта без привязок.
 */
import type { SitesVideoInput } from '../sites-internal/sites-internal.client';
import {
  ASSIST_VIDEOS_HASH_PREFIX,
  RECONCILE_GIVE_UP_AFTER,
  RECONCILE_RESEND_AFTER_MS,
  parseStoredVideoSet,
  reconcileAssistVideoSets,
  rememberSyncFailure,
  rememberVideoSet,
  videoSetHash,
} from './assist-videos-reconcile';

const NOW = 1_790_000_000_000;

const video = (id: string): SitesVideoInput => ({
  externalId: id,
  draftId: `d-${id}`,
  ownerTelegramId: '1001',
  title: `Ролик ${id}`,
  locale: 'uk',
  durationMs: 20_000,
  url: `https://blob.example/${id}.mp4`,
  requiresLogin: false,
  stepHosts: ['shop.example.com'],
});

function harness(opts: {
  linked: string[];
  sets: Record<string, SitesVideoInput[]>;
  stored?: Record<string, string>;
  syncOk?: (siteId: string) => boolean | 'gone';
  clock?: () => number;
}) {
  const clock = opts.clock ?? (() => NOW);
  const settings = new Map<string, string>(
    Object.entries(opts.stored ?? {}).map(([k, v]) => [
      `${ASSIST_VIDEOS_HASH_PREFIX}${k}`,
      v,
    ]),
  );
  const prisma = {
    clientSiteTutorialDraft: {
      findMany: jest.fn(async () =>
        opts.linked.map((clientSiteId) => ({ clientSiteId })),
      ),
    },
    platformSetting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { value: settings.get(where.key)! } : null,
      ),
      findMany: jest.fn(async () =>
        [...settings].map(([key, value]) => ({ key, value })),
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { key: string };
          create: { value: string };
        }) => {
          settings.set(where.key, create.value);
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: { key: string } }) => {
        settings.delete(where.key);
        return { count: 1 };
      }),
    },
  };
  const synced: string[] = [];
  const media = {
    collectVideos: jest.fn(async (siteId: string) => opts.sets[siteId] ?? []),
    // Как настоящий `syncSite`: успех — отпечаток, неудача — время попытки
    // ('gone' — sites-backend ответил «сайт не найден / не ваш»).
    syncSite: jest.fn(async (siteId: string) => {
      synced.push(siteId);
      const ok = opts.syncOk ? opts.syncOk(siteId) : true;
      if (ok === true) {
        await rememberVideoSet(
          prisma as never,
          siteId,
          opts.sets[siteId] ?? [],
          clock(),
        );
        return true;
      }
      await rememberSyncFailure(
        prisma as never,
        siteId,
        clock(),
        ok === 'gone',
      );
      return false;
    }),
  };
  return { prisma, media, synced, settings };
}

const stamp = (videos: SitesVideoInput[], at = NOW - 1000) =>
  `${videoSetHash(videos)}|${at}`;

describe('ночная сверка наборов роликов сайтов помощника (W7)', () => {
  it('шлёт только изменившиеся наборы; неизменный — пропуск', async () => {
    const h = harness({
      linked: ['A', 'B'],
      sets: { A: [video('1')], B: [video('2')] },
      stored: { A: stamp([video('1')]), B: stamp([video('old')]) },
    });
    const r = await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW,
    });
    expect(h.synced).toEqual(['B']);
    expect(r).toMatchObject({ sites: 2, unchanged: 1, sent: 1, failed: 0 });
    expect(
      parseStoredVideoSet(h.settings.get(`${ASSIST_VIDEOS_HASH_PREFIX}B`)),
    ).toEqual({
      hash: videoSetHash([video('2')]),
      at: NOW,
      fails: 0,
    });
  });

  it('сайт без отпечатка (событие не дошло) — шлёт; сбой — в failed, отпечатка нет (только время попытки)', async () => {
    const h = harness({
      linked: ['A'],
      sets: { A: [video('1')] },
      syncOk: () => false,
    });
    const r = await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW,
    });
    expect(h.synced).toEqual(['A']);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(
      parseStoredVideoSet(h.settings.get(`${ASSIST_VIDEOS_HASH_PREFIX}A`)),
    ).toEqual({ hash: null, at: NOW, fails: 0 });
  });

  it('аудит [P3]: вечно падающие сайты не морят голодом остальных — после неудачи они в конце очереди', async () => {
    const failing = Array.from(
      { length: 35 },
      (_, i) => `F${String(i).padStart(2, '0')}`,
    );
    const healthy = ['G1', 'G2'];
    let t = NOW;
    const h = harness({
      linked: [...failing, ...healthy],
      sets: Object.fromEntries(
        [...failing, ...healthy].map((id) => [id, [video(id)]]),
      ),
      syncOk: (id) => !id.startsWith('F'),
      clock: () => t,
    });
    const night = () =>
      reconcileAssistVideoSets({
        prisma: h.prisma as never,
        media: h.media,
        configured: true,
        landingSiteId: null,
        now: () => t,
      });
    // Ночь 1: все без записи — по алфавиту F* съедают потолок.
    const r1 = await night();
    expect(r1).toMatchObject({ failed: 30, deferred: 7 });
    expect(h.synced.some((id) => id.startsWith('G'))).toBe(false);
    // Ночь 2: у упавших — время попытки, они в конце; не дошедшие до
    // очереди F30–F34 и G — впереди, G отправлены.
    t += 24 * 3600_000;
    h.synced.length = 0;
    const r2 = await night();
    expect(h.synced.slice(0, 7)).toEqual([
      'F30',
      'F31',
      'F32',
      'F33',
      'F34',
      'G1',
      'G2',
    ]);
    expect(r2.sent).toBe(2);
  });

  it('«сайт не найден / не ваш» N раз подряд: без привязок — забыт, с привязками — раз в неделю', async () => {
    const gone = `0|${NOW - 1000}|${RECONCILE_GIVE_UP_AFTER}`;
    const h = harness({
      linked: ['L'],
      sets: { L: [video('l')], U: [] },
      stored: { U: gone, L: gone },
    });
    const r = await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW,
    });
    expect(h.synced).toEqual([]);
    expect(r).toMatchObject({ forgotten: 1, gaveUp: 1 });
    expect(h.settings.has(`${ASSIST_VIDEOS_HASH_PREFIX}U`)).toBe(false);
    expect(h.settings.has(`${ASSIST_VIDEOS_HASH_PREFIX}L`)).toBe(true);

    // Через неделю — снова попытка; ещё отказ — счётчик растёт.
    const later = NOW + RECONCILE_RESEND_AFTER_MS;
    const h2 = harness({
      linked: ['L'],
      sets: { L: [video('l')] },
      stored: { L: gone },
      syncOk: () => 'gone',
      clock: () => later,
    });
    await reconcileAssistVideoSets({
      prisma: h2.prisma as never,
      media: h2.media,
      configured: true,
      landingSiteId: null,
      now: () => later,
    });
    expect(h2.synced).toEqual(['L']);
    expect(
      parseStoredVideoSet(h2.settings.get(`${ASSIST_VIDEOS_HASH_PREFIX}L`)),
    ).toEqual({ hash: null, at: later, fails: RECONCILE_GIVE_UP_AFTER + 1 });
  });

  it('отказов меньше N — шлём как обычно; сбой сети счётчик не растит, успех его сбрасывает', async () => {
    const h = harness({
      linked: ['A'],
      sets: { A: [video('a')] },
      stored: { A: `0|${NOW - 1000}|${RECONCILE_GIVE_UP_AFTER - 1}` },
      syncOk: () => false,
    });
    const run = () =>
      reconcileAssistVideoSets({
        prisma: h.prisma as never,
        media: h.media,
        configured: true,
        landingSiteId: null,
        now: () => NOW,
      });
    await run();
    expect(h.synced).toEqual(['A']);
    expect(
      parseStoredVideoSet(h.settings.get(`${ASSIST_VIDEOS_HASH_PREFIX}A`))
        ?.fails,
    ).toBe(RECONCILE_GIVE_UP_AFTER - 1);
    h.media.syncSite.mockImplementationOnce(async (siteId: string) => {
      await rememberVideoSet(h.prisma as never, siteId, [video('a')], NOW);
      return true;
    });
    await run();
    expect(
      parseStoredVideoSet(h.settings.get(`${ASSIST_VIDEOS_HASH_PREFIX}A`)),
    ).toEqual({ hash: videoSetHash([video('a')]), at: NOW, fails: 0 });
  });

  it('удалён проект целиком: привязок нет, набор по отпечатку — пустой набор уходит', async () => {
    const h = harness({
      linked: [],
      sets: {},
      stored: { A: stamp([video('1')]) },
    });
    await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW,
    });
    expect(h.synced).toEqual(['A']);
    expect(h.settings.get(`${ASSIST_VIDEOS_HASH_PREFIX}A`)).toBe(
      `${videoSetHash([])}|${NOW}`,
    );
    // Следующей ночью пустой принятый набор сайта без привязок забывается.
    const r = await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW + 1000,
    });
    expect(r).toMatchObject({ forgotten: 1, sent: 0 });
    expect(h.settings.size).toBe(0);
    expect(h.synced).toEqual(['A']);
  });

  it('неизменный набор переотправляется раз в неделю', async () => {
    const h = harness({
      linked: ['A'],
      sets: { A: [video('1')] },
      stored: { A: stamp([video('1')], NOW - RECONCILE_RESEND_AFTER_MS - 1) },
    });
    await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW,
    });
    expect(h.synced).toEqual(['A']);
  });

  it('сайт лендинга — никогда; кабинет не подключён — ничего', async () => {
    const h = harness({
      linked: ['LAND', 'A'],
      sets: { A: [video('1')], LAND: [video('2')] },
    });
    await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: 'LAND',
      now: () => NOW,
    });
    expect(h.synced).toEqual(['A']);

    const off = harness({ linked: ['A'], sets: { A: [video('1')] } });
    const r = await reconcileAssistVideoSets({
      prisma: off.prisma as never,
      media: off.media,
      configured: false,
      landingSiteId: null,
    });
    expect(r.skipped).toBe('not-configured');
    expect(off.media.collectVideos).not.toHaveBeenCalled();
  });

  it('потолок отправок: остальные — следующей ночью; сначала давно не сверенные', async () => {
    const h = harness({
      linked: ['A', 'B', 'C'],
      sets: { A: [video('a')], B: [video('b')], C: [video('c')] },
      stored: {
        A: stamp([video('x')], NOW - 10),
        B: stamp([video('y')], NOW - 5000),
      },
    });
    const r = await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => NOW,
      maxSends: 2,
    });
    // C без отпечатка, затем B (старше), A — в следующий раз.
    expect(h.synced).toEqual(['C', 'B']);
    expect(r).toMatchObject({ sent: 2, deferred: 1 });
  });

  it('бюджет времени исчерпан — оставшиеся откладываются', async () => {
    let t = NOW;
    const h = harness({
      linked: ['A', 'B'],
      sets: { A: [video('a')], B: [video('b')] },
    });
    h.media.syncSite.mockImplementation(async (siteId: string) => {
      h.synced.push(siteId);
      t += 10_000;
      return true;
    });
    const r = await reconcileAssistVideoSets({
      prisma: h.prisma as never,
      media: h.media,
      configured: true,
      landingSiteId: null,
      now: () => t,
      budgetMs: 5_000,
    });
    expect(h.synced).toEqual(['A']);
    expect(r.deferred).toBe(1);
  });

  it('отпечаток: кривое значение не читается', () => {
    expect(parseStoredVideoSet('мусор')).toBeNull();
    expect(parseStoredVideoSet(null)).toBeNull();
    expect(parseStoredVideoSet(`${'a'.repeat(64)}|12`)).toEqual({
      hash: 'a'.repeat(64),
      at: 12,
      fails: 0,
    });
    expect(parseStoredVideoSet('0|12|3')).toEqual({
      hash: null,
      at: 12,
      fails: 3,
    });
    expect(parseStoredVideoSet('1|12')).toBeNull();
  });
});
