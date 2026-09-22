/**
 * Этап 80 (TODO §III.9, doc/SOCIAL-FEED-SPEC.md) — контроллер в целом
 * тонкая обвязка над `SharedVideoService` (сама логика — в
 * `shared-video.service.spec.ts`), но `feed()` содержит небольшую
 * логику разбора query-параметров (клампинг `pageSize`, дефолт курсора),
 * которую стоит проверить отдельно от сервиса — тот же принцип, что и у
 * `admin-panel.controller.spec.ts` (не весь контроллер, а то, что нельзя
 * проверить в сервисе в изоляции).
 */

// Тот же обход песочницы, что и в admin-panel.controller.spec.ts: файл
// контроллера импортирует ЗНАЧЕНИЕ `AdminPanelService` (для
// `AdminSharedVideoController`, который в этом файле не тестируется, но
// живёт в том же модуле) — её собственный импорт `@prisma/client`
// (enum `WorkflowKind`) рушит загрузку в песочнице без сети до
// binaries.prisma.sh.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../admin-panel/admin-panel.service', () => ({
  AdminPanelService: class {},
}));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));

import {
  PublicSharedVideoController,
  SharedVideoLikeController,
} from './shared-video.controller';
import type { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import type { IdentifiedRequest } from '../telegram-auth/telegram-identity.guard';

function buildService() {
  return {
    listFeed: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listShowcase: jest
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null }),
    getPublic: jest.fn(),
    fork: jest.fn(),
    recordShare: jest.fn().mockResolvedValue(undefined),
    like: jest.fn().mockResolvedValue({ likeCount: 1, likedByViewer: true }),
    unlike: jest.fn().mockResolvedValue({ likeCount: 0, likedByViewer: false }),
  };
}

describe('PublicSharedVideoController.feed', () => {
  it('дефолт — без курсора, pageSize 20, viewerUserId null без identity', async () => {
    const service = buildService();
    const controller = new PublicSharedVideoController(service as never);
    await controller.feed({} as TelegramIdentifiedRequest);
    expect(service.listFeed).toHaveBeenCalledWith({
      cursor: null,
      pageSize: 20,
      viewerUserId: null,
    });
  });

  it('передаёt telegramUserId, когда middleware её заполнила', async () => {
    const service = buildService();
    const controller = new PublicSharedVideoController(service as never);
    await controller.feed({
      telegramUserId: 'u1',
    } as TelegramIdentifiedRequest);
    expect(service.listFeed).toHaveBeenCalledWith(
      expect.objectContaining({ viewerUserId: 'u1' }),
    );
  });

  it('pageSize клампится в [1, 50], мусор/0 → дефолт 20 (тот же `|| дефолт`, что и в AdminSharedVideoController.list)', async () => {
    const service = buildService();
    const controller = new PublicSharedVideoController(service as never);
    await controller.feed({} as TelegramIdentifiedRequest, 'c1', '500');
    expect(service.listFeed).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'c1', pageSize: 50 }),
    );
    // '0' → parseInt даёт 0, а `0 || 20` считает его отсутствующим — тот
    // же приём, что уже используется в AdminSharedVideoController.list()
    // (page/pageSize), не новая асимметрия.
    await controller.feed({} as TelegramIdentifiedRequest, undefined, '0');
    expect(service.listFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: 20 }),
    );
    await controller.feed({} as TelegramIdentifiedRequest, undefined, 'nope');
    expect(service.listFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: 20 }),
    );
  });
});

describe('PublicSharedVideoController.share', () => {
  it('делегирует recordShare, ничего не возвращает (204)', async () => {
    const service = buildService();
    const controller = new PublicSharedVideoController(service as never);
    await expect(controller.share('sv1')).resolves.toBeUndefined();
    expect(service.recordShare).toHaveBeenCalledWith('sv1');
  });
});

describe('SharedVideoLikeController', () => {
  it('like/unlike передают req.telegramUserId — требуют identity (гвард)', async () => {
    const service = buildService();
    const controller = new SharedVideoLikeController(service as never);
    const req = { telegramUserId: 'u1' } as IdentifiedRequest;

    await expect(controller.like(req, 'sv1')).resolves.toEqual({
      likeCount: 1,
      likedByViewer: true,
    });
    expect(service.like).toHaveBeenCalledWith('u1', 'sv1');

    await expect(controller.unlike(req, 'sv1')).resolves.toEqual({
      likeCount: 0,
      likedByViewer: false,
    });
    expect(service.unlike).toHaveBeenCalledWith('u1', 'sv1');
  });
});

/**
 * Витрина (этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md).
 */
describe('PublicSharedVideoController.showcase', () => {
  it('дефолт — 9 карточек, пустые фильтры уходят как null', async () => {
    const service = buildService();
    const controller = new PublicSharedVideoController(service as never);
    await controller.showcase();
    expect(service.listShowcase).toHaveBeenCalledWith({
      projectType: null,
      occasion: null,
      cursor: null,
      pageSize: 9,
    });
  });

  it('прокидывает фильтры и клампит pageSize в [1, 24]', async () => {
    const service = buildService();
    const controller = new PublicSharedVideoController(service as never);
    await controller.showcase('GREETING_VIDEO', 'WEDDING', 'cur1', '500');
    expect(service.listShowcase).toHaveBeenCalledWith({
      projectType: 'GREETING_VIDEO',
      occasion: 'WEDDING',
      cursor: 'cur1',
      pageSize: 24,
    });

    await controller.showcase(undefined, undefined, undefined, '0');
    // Тот же `|| дефолт`, что и у feed: 0 и мусор дают дефолт, не ноль
    // карточек и не отрицательный take.
    expect(service.listShowcase).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: 9 }),
    );
  });

  /**
   * Маршрут `showcase` обязан стоять ДО `:id` — иначе Nest примет слово
   * за значение параметра и витрина вернёт 404. Порядок объявления
   * методов в классе и есть порядок маршрутов, поэтому проверяем именно
   * его, а не поведение через HTTP.
   */
  it('объявлен раньше параметрического :id', () => {
    const order = Object.getOwnPropertyNames(
      PublicSharedVideoController.prototype,
    );
    expect(order.indexOf('showcase')).toBeLessThan(order.indexOf('get'));
    expect(order.indexOf('feed')).toBeLessThan(order.indexOf('get'));
  });
});
