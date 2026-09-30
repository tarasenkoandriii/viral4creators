import { PersonaSharesService, sharePageUrl } from './persona-shares.service';

function build(
  pages: Array<{ id: string; sessionId: string }>,
  sessions: Array<{ id: string; data: unknown }>,
) {
  const prisma = {
    sharedVideoPage: { findMany: jest.fn(async () => pages) },
    session: { findMany: jest.fn(async () => sessions) },
  };
  return { service: new PersonaSharesService(prisma as never), prisma };
}

const withPersona = { greetingBriefSnapshot: { usesPersona: true } };
const without = { greetingBriefSnapshot: { usesPersona: false } };

const ENV = process.env.LANDING_PUBLIC_URL;
afterAll(() => {
  process.env.LANDING_PUBLIC_URL = ENV;
});

describe('PersonaSharesService', () => {
  it('только страницы роликов с usesPersona, с sessionId и адресом лендинга', async () => {
    process.env.LANDING_PUBLIC_URL = 'https://site.example/';
    const { service, prisma } = build(
      [
        { id: 'a', sessionId: 's1' },
        { id: 'b', sessionId: 's2' },
        { id: 'c', sessionId: 'gone' },
        { id: 'd', sessionId: 's1' },
      ],
      [
        { id: 's1', data: withPersona },
        { id: 's2', data: without },
      ],
    );
    const r = await service.publishedSharesWithPersona('u1');
    expect(r).toEqual([
      { id: 'a', sessionId: 's1', url: 'https://site.example/video/a' },
      { id: 'd', sessionId: 's1', url: 'https://site.example/video/d' },
    ]);
    const where = (
      prisma.sharedVideoPage.findMany.mock.calls[0] as unknown as [
        { where: unknown },
      ]
    )[0].where;
    expect(where).toEqual({
      userId: 'u1',
      status: { in: ['PENDING', 'PUBLISHED'] },
    });
    // Сессии — одним запросом, без дублей.
    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2', 'gone'] } },
      select: { id: true, data: true },
    });
  });

  it('нет страниц — без запроса сессий', async () => {
    const { service, prisma } = build([], []);
    expect(await service.publishedSharesWithPersona('u1')).toEqual([]);
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('адрес без лендинга — относительный', () => {
    expect(sharePageUrl('', 'x')).toBe('/video/x');
  });
});
