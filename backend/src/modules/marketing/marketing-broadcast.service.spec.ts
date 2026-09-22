/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const configState = {
  frequencyDays: 7,
  pageCount: 5,
  cronBatch: 200,
  maxAttempts: 5,
  landingUrl: 'https://landing.test',
};
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ marketing: configState }),
}));

import {
  buildMessage,
  MarketingBroadcastService,
} from './marketing-broadcast.service';

const realFetch = global.fetch;
let fetchMock: jest.Mock;

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page1',
    title: 'Крутой ролик',
    productName: 'Товар',
    ...overrides,
  };
}

function deliverableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    userId: 'u1',
    attempts: 0,
    broadcast: { sharedVideoPageIds: ['page1'] },
    ...overrides,
  };
}

/** Prisma-мок с разумными дефолтами; переопределяется per-test. */
function build(
  opts: {
    lastBroadcast?: unknown;
    pages?: unknown[];
    subscribers?: unknown[];
    deliverableRows?: unknown[];
    user?: unknown;
  } = {},
) {
  const prisma = {
    marketingBroadcast: {
      findFirst: jest.fn().mockResolvedValue(opts.lastBroadcast ?? null),
      create: jest.fn().mockResolvedValue({ id: 'b1' }),
    },
    sharedVideoPage: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(opts.pages ?? [])
        .mockResolvedValue([page()]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue(opts.subscribers ?? []),
      findUnique: jest.fn().mockResolvedValue(
        opts.user ?? {
          telegramId: '123456',
          marketingConsentRevokedAt: null,
        },
      ),
      update: jest.fn().mockResolvedValue(undefined),
    },
    marketingDelivery: {
      findMany: jest.fn().mockResolvedValue(opts.deliverableRows ?? []),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const service = new MarketingBroadcastService(prisma as any);
  return { service, prisma };
}

const envBefore = { botToken: process.env.TELEGRAM_BOT_TOKEN };

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

afterAll(() => {
  global.fetch = realFetch;
  // Не оставлять TELEGRAM_BOT_TOKEN='bot-token' в process.env — Jest
  // переиспользует один и тот же процесс-воркер для нескольких файлов
  // спеков подряд, и без восстановления значение утекало бы в
  // env-settings.spec.ts (проверяет именно эту переменную).
  if (envBefore.botToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = envBefore.botToken;
});

describe('MarketingBroadcastService.runDaily — сборка выпуска (этап 63, ТЗ §42)', () => {
  it('выпуска ещё не было — собирает первый же прогон, если есть страницы', async () => {
    const { service, prisma } = build({
      lastBroadcast: null,
      pages: [page()],
      subscribers: [{ id: 'sub1' }, { id: 'sub2' }],
    });
    const result = await service.runDaily();
    expect(result.composed).toBe(true);
    expect(result.featured).toBe(1);
    expect(result.recipients).toBe(2);
    expect(prisma.marketingBroadcast.create).toHaveBeenCalledWith({
      data: { sharedVideoPageIds: ['page1'] },
      select: { id: true },
    });
    expect(prisma.sharedVideoPage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['page1'] } },
      data: { featuredInBroadcastAt: expect.any(Date) },
    });
    expect(prisma.marketingDelivery.createMany).toHaveBeenCalledWith({
      data: [
        { broadcastId: 'b1', userId: 'sub1' },
        { broadcastId: 'b1', userId: 'sub2' },
      ],
      skipDuplicates: true,
    });
  });

  it('потолок частоты: последний выпуск моложе frequencyDays — не собирает новый', async () => {
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
    });
    const result = await service.runDaily();
    expect(result.composed).toBe(false);
    expect(prisma.marketingBroadcast.create).not.toHaveBeenCalled();
  });

  it('последний выпуск старше frequencyDays — снова пора', async () => {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const { service, prisma } = build({
      lastBroadcast: { createdAt: old },
      pages: [page()],
    });
    const result = await service.runDaily();
    expect(result.composed).toBe(true);
    expect(prisma.marketingBroadcast.create).toHaveBeenCalledTimes(1);
  });

  it('пора, но нет ни одной ещё не показанной PUBLISHED-страницы — пропускает выпуск', async () => {
    const { service, prisma } = build({ lastBroadcast: null, pages: [] });
    const result = await service.runDaily();
    expect(result.composed).toBe(false);
    expect(result.featured).toBe(0);
    expect(prisma.marketingBroadcast.create).not.toHaveBeenCalled();
  });

  it('нет подписчиков — выпуск всё равно собирается, но без доставок', async () => {
    const { service, prisma } = build({
      lastBroadcast: null,
      pages: [page()],
      subscribers: [],
    });
    const result = await service.runDaily();
    expect(result.composed).toBe(true);
    expect(result.recipients).toBe(0);
    expect(prisma.marketingDelivery.createMany).not.toHaveBeenCalled();
  });
});

describe('MarketingBroadcastService.runDaily — доставка партии', () => {
  it('нет TELEGRAM_BOT_TOKEN — честные нули, без обращения к findMany доставок', async () => {
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
    });
    const result = await service.runDaily();
    expect(result).toMatchObject({
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      stillPending: 0,
    });
    expect(prisma.marketingDelivery.findMany).not.toHaveBeenCalled();
  });

  it('успешная отправка — SENT, sentAt проставлен', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
      deliverableRows: [deliverableRow()],
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await service.runDaily();
    expect(result.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://api.telegram.org/botbot-token/sendMessage',
      ),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(prisma.marketingDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { status: 'SENT', sentAt: expect.any(Date) },
    });
  });

  it('пользователь уже отписался между сборкой и доставкой (гонка) — SKIPPED, не шлёт', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
      deliverableRows: [deliverableRow()],
      user: { telegramId: '123456', marketingConsentRevokedAt: new Date() },
    });
    const result = await service.runDaily();
    expect(result.skipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.marketingDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { status: 'SKIPPED' },
    });
  });

  it('Telegram отвечает 403 "bot was blocked by the user" — SKIPPED + авто-отписка одной транзакцией', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
      deliverableRows: [deliverableRow()],
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        description: 'Forbidden: bot was blocked by the user',
      }),
    });
    const result = await service.runDaily();
    expect(result.skipped).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.marketingDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: {
        status: 'SKIPPED',
        error: 'Forbidden: bot was blocked by the user',
      },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { marketingConsentRevokedAt: expect.any(Date) },
    });
  });

  it('прочая ошибка Telegram — уходит в бэкофф, попытка растёт', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
      deliverableRows: [deliverableRow({ attempts: 0 })],
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ description: 'internal error' }),
    });
    const result = await service.runDaily();
    expect(result.failed).toBe(1);
    expect(prisma.marketingDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: {
        attempts: 1,
        error: expect.stringContaining('internal error'),
        status: 'FAILED',
        nextAttemptAt: expect.any(Date),
      },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('исчерпаны попытки — FAILED терминально, nextAttemptAt: null', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
      deliverableRows: [
        deliverableRow({ attempts: configState.maxAttempts - 1 }),
      ],
    });
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const result = await service.runDaily();
    expect(result.failed).toBe(1);
    expect(prisma.marketingDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: {
        attempts: configState.maxAttempts,
        error: 'timeout',
        status: 'FAILED',
        nextAttemptAt: null,
      },
    });
  });

  it('одна упавшая доставка не мешает следующей в том же тике', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service } = build({
      lastBroadcast: { createdAt: new Date() },
      deliverableRows: [
        deliverableRow({ id: 'a', userId: 'ua' }),
        deliverableRow({ id: 'b', userId: 'ub' }),
      ],
    });
    fetchMock
      .mockRejectedValueOnce(new Error('boom on a'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await service.runDaily();
    expect(result).toMatchObject({ processed: 2, sent: 1, failed: 1 });
  });

  it('берёт не больше cronBatch доставок за прогон', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const { service, prisma } = build({
      lastBroadcast: { createdAt: new Date() },
    });
    await service.runDaily();
    expect(prisma.marketingDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: configState.cronBatch }),
    );
  });
});

describe('buildMessage', () => {
  it('собирает заголовок, карточки со ссылками и отписку', () => {
    const text = buildMessage(
      [page({ id: 'p1' }), page({ id: 'p2', title: 'Второй' })],
      'https://landing.test',
    );
    expect(text).toContain('Подборка удачных рекламных роликов');
    expect(text).toContain('https://landing.test/video/p1');
    expect(text).toContain('https://landing.test/video/p2');
    expect(text).toContain('Крутой ролик (Товар)');
    expect(text).toContain('Отписаться можно в любой момент в приложении.');
  });

  it('без landingUrl — карточки без ссылок, а не с пустым хвостом', () => {
    const text = buildMessage([page()], '');
    expect(text).toContain('• Крутой ролик (Товар)');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('/video/');
  });
});

/**
 * Этап 1 витрины (миграция 20261207090000): поздравления стало возможно
 * публиковать публичной страницей, и без явного фильтра они начали бы
 * попадать в рекламную рассылку сами собой — «подборка удачных
 * РЕКЛАМНЫХ роликов недели» всем подписчикам канала. Прежнее поведение
 * (их там нет) закреплено тестом, чтобы оно не изменилось молча.
 */
describe('MarketingBroadcastService — поздравления вне рассылки', () => {
  it('выборка выпуска исключает GREETING_VIDEO, не теряя товарные ролики', async () => {
    // Через публичный runDaily(), а не приватный composeIfDue: тест
    // проверяет поведение сервиса, а не его внутреннее устройство.
    const { service, prisma } = build({ pages: [] });
    await service.runDaily();
    const where = prisma.sharedVideoPage.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('PUBLISHED');
    expect(where.featuredInBroadcastAt).toBeNull();
    // NULL в projectType — это товарный ролик, и он обязан остаться в
    // выборке: простое отрицание в SQL отбросило бы его вместе с
    // поздравлениями.
    expect(where.OR).toEqual([
      { projectType: null },
      { projectType: { notIn: ['GREETING_VIDEO'] } },
    ]);
  });
});

describe('buildMessage — запись без товара', () => {
  it('подписью становится один заголовок, а не «Заголовок (null)»', () => {
    const text = buildMessage(
      [{ id: 'sv9', title: 'С днём рождения', productName: null }],
      'https://welcome.viral4creators.app',
    );
    expect(text).toContain('• С днём рождения');
    expect(text).not.toContain('(');
    expect(text).not.toContain('null');
  });
});
