/**
 * Узнавание ролика с персоной для аукциона — CONTRACT6 п.6: копия заявки
 * на публикацию и fail-closed у страницы поздравления без сессии.
 */
import {
  publicationIdFromVideoUrl,
  videoUsesPersona,
} from './auction-persona-guard';

const HOST = 'https://store.public.blob.vercel-storage.com';
const PERSONA = { greetingBriefSnapshot: { usesPersona: true } };
const PLAIN = { greetingBriefSnapshot: { usesPersona: false } };

function db(
  opts: {
    pages?: Array<{ sessionId: string; projectType?: string | null }>;
    publications?: Array<{ sessionId: string | null }>;
    sessions?: Array<{ id: string; data: unknown }>;
  } = {},
) {
  return {
    sharedVideoPage: {
      findMany: jest.fn().mockResolvedValue(opts.pages ?? []),
    },
    publicationRequest: {
      findMany: jest.fn().mockResolvedValue(opts.publications ?? []),
    },
    session: { findMany: jest.fn().mockResolvedValue(opts.sessions ?? []) },
  };
}

describe('publicationIdFromVideoUrl', () => {
  it('только наш путь publications/<id>/', () => {
    expect(publicationIdFromVideoUrl(`${HOST}/publications/p1/video.mp4`)).toBe(
      'p1',
    );
    expect(publicationIdFromVideoUrl(`${HOST}/sessions/s1/x.mp4`)).toBeNull();
    expect(publicationIdFromVideoUrl('https://youtu.be/x')).toBeNull();
  });
});

describe('videoUsesPersona — копия публикации (CONTRACT6 п.6)', () => {
  it('ссылка на publications/<id>/video.mp4 → сессия заявки → персона', async () => {
    const prisma = db({
      publications: [{ sessionId: 's5' }],
      sessions: [{ id: 's5', data: PERSONA }],
    });
    const url = `${HOST}/publications/p1/video.mp4`;
    await expect(videoUsesPersona(prisma, [url], true)).resolves.toBe(true);
    expect(prisma.publicationRequest.findMany).toHaveBeenCalledWith({
      where: { OR: [{ videoUrl: { in: [url] } }, { id: { in: ['p1'] } }] },
      select: { sessionId: true },
    });
    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['s5'] } },
      select: { id: true, data: true },
    });
  });

  it('заявка без персоны — можно', async () => {
    const prisma = db({
      publications: [{ sessionId: 's5' }],
      sessions: [{ id: 's5', data: PLAIN }],
    });
    await expect(
      videoUsesPersona(prisma, [`${HOST}/publications/p1/video.mp4`], true),
    ).resolves.toBe(false);
  });

  it('заявка обучающего видео (sessionId null) — не ломает проверку', async () => {
    const prisma = db({ publications: [{ sessionId: null }] });
    await expect(
      videoUsesPersona(prisma, ['https://youtu.be/x'], true),
    ).resolves.toBe(false);
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });
});

describe('videoUsesPersona — страница поздравления без сессии (fail-closed)', () => {
  it('режим включён: сессии нет → считаем, что персона есть', async () => {
    const prisma = db({
      pages: [{ sessionId: 'gone', projectType: 'GREETING_VIDEO' }],
      sessions: [],
    });
    await expect(
      videoUsesPersona(prisma, ['https://x/y.mp4'], true),
    ).resolves.toBe(true);
  });

  it('режим выключен — как до этапа G, не отказ', async () => {
    const prisma = db({
      pages: [{ sessionId: 'gone', projectType: 'GREETING_VIDEO' }],
    });
    await expect(
      videoUsesPersona(prisma, ['https://x/y.mp4'], false),
    ).resolves.toBe(false);
  });

  it('товарная страница без сессии — не отказ (персоны у товара не бывает)', async () => {
    const prisma = db({ pages: [{ sessionId: 'gone', projectType: null }] });
    await expect(
      videoUsesPersona(prisma, ['https://x/y.mp4'], true),
    ).resolves.toBe(false);
  });

  it('страница поздравления с живой сессией без персоны — можно', async () => {
    const prisma = db({
      pages: [{ sessionId: 's1', projectType: 'GREETING_VIDEO' }],
      sessions: [{ id: 's1', data: PLAIN }],
    });
    await expect(
      videoUsesPersona(prisma, ['https://x/y.mp4'], true),
    ).resolves.toBe(false);
  });
});
