/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * TelegramLoginService — третий, независимый механизм личности в
 * проекте (после initData и админской cookie), и до этого файла ни одна
 * его строка не исполнялась в тестах.
 *
 * Проверяем то, что отличает его от двух остальных и что при поломке
 * незаметно: срок жизни (30 дней, а не 7), полное отсутствие прав
 * оператора и `resolveToken`, который обязан НЕ пускать по просроченной
 * сессии и при этом никогда не бросать — он вызывается из middleware на
 * каждом запросе, включая анонимные.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { TelegramLoginService } from './telegram-login.service';
import { TelegramLoginWidgetPayload } from '../admin-auth/telegram-login-widget.util';

const BOT_TOKEN = '111111:AAmain-bot';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Подпись Login Widget считается по алгоритму Telegram
 * (secret_key = SHA256(bot_token)), а не берётся готовой константой. */
function signed(fields: Record<string, unknown>): TelegramLoginWidgetPayload {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  return {
    ...fields,
    hash: createHmac('sha256', secret).update(dataCheckString).digest('hex'),
  } as unknown as TelegramLoginWidgetPayload;
}

const freshPayload = () =>
  signed({
    id: 4242,
    first_name: 'Пётр',
    username: 'petr',
    auth_date: Math.floor(Date.now() / 1000),
  });

function build() {
  const prisma = {
    user: {
      upsert: jest.fn().mockResolvedValue({ id: 'usr_1' }),
      findUnique: jest.fn().mockResolvedValue({
        telegramId: '4242',
        firstName: 'Пётр',
        username: 'petr',
      }),
    },
    userSession: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  return { service: new TelegramLoginService(prisma as any), prisma };
}

const envBackup = { ...process.env };
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.ALLOW_DEV_AUTH = 'true';
  process.env.NODE_ENV = 'test';
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...envBackup };
});

describe('TelegramLoginService.loginWithTelegram', () => {
  it('заводит сессию на 30 дней — дольше админской неделями не случайно', async () => {
    // Это чистая идентификация без привилегий, и требовать перелогина
    // каждую неделю здесь незачем; при этом перепутать константы с
    // админскими легко, а разница видна только через месяц.
    const { service, prisma } = build();
    const before = Date.now();
    const result = await service.loginWithTelegram(freshPayload());

    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(29.9 * DAY_MS);
    // Секунда допуска: `before` берётся ДО вызова, и срок считается уже
    // внутри — на границе миллисекунды строгое «≤ 30 дней» падает раз в
    // сотню прогонов. Проверяем константу, а не таймер.
    expect(ttlMs).toBeLessThanOrEqual(30 * DAY_MS + 1000);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.userSession.create).toHaveBeenCalledWith({
      data: {
        userId: 'usr_1',
        token: result.token,
        expiresAt: result.expiresAt,
      },
    });
  });

  it('вход не даёт никаких прав — isOperator здесь не появляется', async () => {
    // Кнопка «Войти через Telegram» на публичном фронте открыта всем;
    // если бы этот путь ставил флаг оператора, админка открылась бы
    // любому желающему.
    const { service, prisma } = build();
    await service.loginWithTelegram(freshPayload());

    const call = prisma.user.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty('isOperator');
    expect(call.create).not.toHaveProperty('isOperator');
    expect(call.where).toEqual({ telegramId: '4242' });
  });

  it('имя и username обновляются при каждом входе', async () => {
    // Иначе в интерфейсе годами висело бы имя, с которым человек
    // зарегистрировался.
    const { service, prisma } = build();
    await service.loginWithTelegram(freshPayload());
    expect(prisma.user.upsert.mock.calls[0][0].update).toEqual({
      firstName: 'Пётр',
      username: 'petr',
    });
  });

  it('поддельная подпись — 401 и ни одной записи в базе', async () => {
    const { service, prisma } = build();
    const payload = freshPayload();
    payload.id = 999;

    await expect(service.loginWithTelegram(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.userSession.create).not.toHaveBeenCalled();
  });

  it('незаданный TELEGRAM_BOT_TOKEN — ошибка настройки, а не отказ входа', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { service } = build();
    await expect(service.loginWithTelegram(freshPayload())).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('перед выдачей чистит только просроченные сессии', async () => {
    // Ошибка в фильтре здесь разлогинивает всех разом, а заметно это
    // становится только по жалобам.
    const { service, prisma } = build();
    await service.loginWithTelegram(freshPayload());

    const where = prisma.userSession.deleteMany.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(['expiresAt']);
    expect(where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('TelegramLoginService.devLogin', () => {
  it('вне dev отвечает 404 и ничего не пишет', async () => {
    delete process.env.ALLOW_DEV_AUTH;
    const { service, prisma } = build();
    await expect(service.devLogin('123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('на проде закрыт даже с выставленным флагом', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = build();
    await expect(service.devLogin('123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('в dev резолвится в того же «dev-123», что TMA и админка', async () => {
    // Три dev-входа обязаны давать одного пользователя, иначе локально
    // данные из мини-приложения не видны во фронте и наоборот.
    const { service, prisma } = build();
    await service.devLogin('');
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { telegramId: 'dev-123' },
      update: {},
      create: { telegramId: 'dev-123' },
    });
  });
});

describe('TelegramLoginService.resolveToken — сессия из cookie', () => {
  it('действующая сессия отдаёт userId', async () => {
    const { service, prisma } = build();
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'usr_1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.resolveToken('tok_1')).resolves.toBe('usr_1');
  });

  it('просроченная сессия личности не даёт', async () => {
    // Строки чистятся оппортунистически, то есть просроченная сессия
    // лежит в базе часами: без сравнения с `expiresAt` 30-дневная
    // cookie стала бы вечной.
    const { service, prisma } = build();
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'usr_1',
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.resolveToken('tok_1')).resolves.toBeNull();
  });

  it('сессия, истекающая ровно сейчас, уже не действует', async () => {
    const { service, prisma } = build();
    prisma.userSession.findUnique.mockResolvedValue({
      userId: 'usr_1',
      expiresAt: new Date(),
    });
    await expect(service.resolveToken('tok_1')).resolves.toBeNull();
  });

  it('неизвестный токен возвращает null, а не исключение', async () => {
    // resolveToken зовётся из middleware на КАЖДОМ запросе, включая
    // анонимные: брошенное отсюда исключение уронило бы весь публичный
    // трафик, а не только вход.
    const { service } = build();
    await expect(service.resolveToken('нет такого')).resolves.toBeNull();
  });
});

describe('TelegramLoginService.logout / me', () => {
  it('выход гасит ровно предъявленный токен', async () => {
    // Удаление по userId выкинуло бы человека со всех его устройств.
    const { service, prisma } = build();
    await expect(service.logout('tok_1')).resolves.toEqual({ ok: true });
    expect(prisma.userSession.deleteMany).toHaveBeenCalledWith({
      where: { token: 'tok_1' },
    });
  });

  it('me отдаёт только публичные поля профиля', async () => {
    // Выборка целиком утащила бы в ответ всё, что появится в модели
    // User позже — включая служебные флаги.
    const { service, prisma } = build();
    await expect(service.me('usr_1')).resolves.toEqual({
      telegramId: '4242',
      firstName: 'Пётр',
      username: 'petr',
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'usr_1' },
      select: { telegramId: true, firstName: true, username: true },
    });
  });

  it('удалённый пользователь — null, а не исключение', async () => {
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.me('usr_ghost')).resolves.toBeNull();
  });
});
