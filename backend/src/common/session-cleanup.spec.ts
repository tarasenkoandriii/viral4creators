jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { SessionService } from './session.service';

/**
 * Уборка истёкших сессий вместе с их файлами (этап 26,
 * doc/STORAGE-AUDIT.md). Проверяем ровно то, что чинил этап: пути
 * собираются ДО удаления строк, удаление ограничено партией и не трогает
 * сессию, которую тронули между выборкой и удалением.
 */

const NOW = new Date('2026-09-06T12:00:00Z');

function build(rows: unknown[], deletedCount = rows.length) {
  const prisma = {
    session: {
      findMany: jest.fn().mockResolvedValue(rows),
      deleteMany: jest.fn().mockResolvedValue({ count: deletedCount }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: new SessionService(prisma as any), prisma };
}

const row = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  status: 'complete',
  createdAt: NOW,
  lastActivityAt: NOW,
  data,
  userId: null,
  projectId: null,
  productItemId: null,
});

describe('cleanupExpiredSessions', () => {
  it('ничего не нашли — ни одного запроса на удаление', async () => {
    const { svc, prisma } = build([]);
    expect(await svc.cleanupExpiredSessions()).toEqual({
      count: 0,
      blobPathnames: [],
      hasMore: false,
    });
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });

  it('собирает пути файлов удаляемых сессий и удаляет только их id, всё ещё истёкшие', async () => {
    const { svc, prisma } = build([
      row('s1', {
        generatedVideo: { pathname: 'sessions/s1/generated.mp4' },
        videoAnalysis: {
          characters: [{ id: 'c1', previewUrl: 'https://cdn/a.jpg' }],
        },
      }),
      row('s2', {
        scenes: [{ photoPathname: 'sessions/s2/scenes/sc_a/photo.png' }],
      }),
    ]);
    const r = await svc.cleanupExpiredSessions();
    expect(r.count).toBe(2);
    expect(r.blobPathnames.sort()).toEqual([
      'sessions/s1/generated.mp4',
      'sessions/s1/previews/character-c1.jpg',
      'sessions/s2/scenes/sc_a/photo.png',
    ]);
    const where = prisma.session.deleteMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: ['s1', 's2'] });
    // условие по времени повторяется — тронутую сессию удалять нельзя
    expect(where.lastActivityAt.lt).toBeInstanceOf(Date);
    // выборка идёт с ограничением партии
    expect(prisma.session.findMany.mock.calls[0][0].take).toBe(500);
  });

  it('полная партия сообщает hasMore, чтобы следующий прогон продолжил', async () => {
    const many = Array.from({ length: 3 }, (_, i) => row(`s${i}`));
    const { svc } = build(many);
    expect((await svc.cleanupExpiredSessions(3)).hasMore).toBe(true);
    expect((await svc.cleanupExpiredSessions(10)).hasMore).toBe(false);
  });

  it('этап 88.1: сессии с готовым роликом исключены из выборки и удаления по TTL', async () => {
    const { svc, prisma } = build([row('s1')]);
    await svc.cleanupExpiredSessions();
    const findWhere = prisma.session.findMany.mock.calls[0][0].where;
    expect(findWhere.generationStatus).toEqual({ not: 'complete' });
    const deleteWhere = prisma.session.deleteMany.mock.calls[0][0].where;
    expect(deleteWhere.generationStatus).toEqual({ not: 'complete' });
  });
});
