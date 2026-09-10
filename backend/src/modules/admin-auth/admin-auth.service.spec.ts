/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * AdminAuthService — единственное место, которое выдаёт cookie админки.
 * До этого файла ни одна его строка не исполнялась в тестах: и dev-вход
 * с полными правами оператора, и разбор payload'а Telegram держались
 * только на чтении диффа.
 *
 * Проверяем то, что при поломке стоит дорого: dev-вход не открывается
 * вне dev и обязан выдавать isOperator (иначе он бесполезен), вход через
 * Telegram прав НЕ раздаёт, поддельный payload не заводит пользователя,
 * а `me` читает флаг из базы, а не из сессии.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { AdminAuthService } from './admin-auth.service';
import { TelegramLoginWidgetPayload } from './telegram-login-widget.util';

const BOT_TOKEN = '111111:AAmain-bot';
const ADMIN_BOT_TOKEN = '222222:AAadmin-bot';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Подпись Login Widget считается здесь же по официальному алгоритму
 * (secret_key = SHA256(bot_token)) — никаких заранее вычисленных
 * констант, иначе тест перестал бы ловить смену схемы. */
function signedPayload(
  fields: Record<string, unknown>,
  botToken = BOT_TOKEN,
): TelegramLoginWidgetPayload {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');
  return { ...fields, hash } as unknown as TelegramLoginWidgetPayload;
}

function freshPayload(botToken = BOT_TOKEN): TelegramLoginWidgetPayload {
  return signedPayload(
    { id: 4242, auth_date: Math.floor(Date.now() / 1000) },
    botToken,
  );
}

function build() {
  const prisma = {
    user: {
      upsert: jest.fn().mockResolvedValue({ id: 'usr_1', isOperator: true }),
      findUnique: jest.fn().mockResolvedValue({ isOperator: false }),
    },
    adminSession: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return { service: new AdminAuthService(prisma as any), prisma };
}

const envBackup = { ...process.env };
beforeEach(() => {
  process.env.ALLOW_DEV_AUTH = 'true';
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  delete process.env.ADMIN_LOGIN_BOT_TOKEN;
  // Предупреждение о выданной без Telegram сессии — часть поведения, но
  // в выводе тестов оно только шум.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...envBackup };
});

describe('AdminAuthService.devLogin — предохранитель', () => {
  it('вне dev отвечает 404, а не 403 — эндпоинта как будто нет', async () => {
    // 403 подтвердил бы существование маршрута, который выдаёт права
    // оператора без единой проверки. 404 не подтверждает ничего.
    delete process.env.ALLOW_DEV_AUTH;
    const { service } = build();
    await expect(service.devLogin('123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('на проде закрыт, даже если ALLOW_DEV_AUTH уехал в окружение', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = build();
    await expect(service.devLogin('123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('отказ происходит ДО записи в базу — ни пользователя, ни сессии', async () => {
    // Иначе закрытый маршрут всё равно оставлял бы следы и заводил
    // пользователей по чужому запросу.
    delete process.env.ALLOW_DEV_AUTH;
    const { service, prisma } = build();
    await expect(service.devLogin('123')).rejects.toThrow();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.adminSession.create).not.toHaveBeenCalled();
  });
});

describe('AdminAuthService.devLogin — что именно он выдаёт', () => {
  it('принудительно ставит isOperator: true и существующему пользователю тоже', async () => {
    // Без этого dev-вход бесполезен: единственная защищённая часть
    // админки (сессии, телеметрия) требует флаг, и локальная админка
    // отвечала бы 403 на каждый экран. Важно, что флаг стоит и в
    // `update` — пользователь мог быть заведён раньше через TMA.
    const { service, prisma } = build();
    await service.devLogin('123');

    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { telegramId: 'dev-123' },
      update: { isOperator: true },
      create: { telegramId: 'dev-123', isOperator: true },
    });
  });

  it('пустой devUserId превращается в общий дефолт «dev-123»', async () => {
    // Тот же дефолт, что у TMA-заголовка X-Dev-User-Id: иначе админка и
    // мини-приложение на локальном стенде открывались бы под разными
    // пользователями, и данные одного не были бы видны в другом.
    const { service, prisma } = build();
    await service.devLogin('   ');
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telegramId: 'dev-123' } }),
    );
  });

  it('токен непредсказуем и не повторяется между входами', async () => {
    // Токен — это и есть вся cookie: угадываемый токен равнозначен
    // открытой админке.
    const { service, prisma } = build();
    await service.devLogin('123');
    await service.devLogin('123');

    const [first, second] = prisma.adminSession.create.mock.calls.map(
      (call: any[]) => call[0].data.token,
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it('сессия живёт неделю и привязана к User.id, а не к telegramId', async () => {
    const { service, prisma } = build();
    const before = Date.now();
    const result = await service.devLogin('123');

    const data = prisma.adminSession.create.mock.calls[0][0].data;
    expect(data.userId).toBe('usr_1');
    expect(data.expiresAt).toEqual(result.expiresAt);
    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(6.9 * DAY_MS);
    // Секунда допуска: `before` берётся ДО вызова, срок считается внутри
    // — на границе миллисекунды строгое «≤ 7 дней» падает раз в сотню
    // прогонов. Проверяем константу, а не таймер.
    expect(ttlMs).toBeLessThanOrEqual(7 * DAY_MS + 1000);
  });

  it('перед выдачей чистит только просроченные сессии', async () => {
    // Уборка оппортунистическая (отдельного крона на неё нет), и цена
    // ошибки в фильтре — разлогин всех живых сессий сразу.
    const { service, prisma } = build();
    await service.devLogin('123');

    const where = prisma.adminSession.deleteMany.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(['expiresAt']);
    expect(Object.keys(where.expiresAt)).toEqual(['lt']);
    expect(where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('AdminAuthService.loginWithTelegram', () => {
  it('честный payload заводит сессию в общем telegramId-неймспейсе', async () => {
    // Не «admin-4242»: вход через админку и вход через TMA обязаны
    // давать ОДНОГО пользователя, иначе у человека появляются два
    // аккаунта с разными данными.
    const { service, prisma } = build();
    const result = await service.loginWithTelegram(freshPayload());

    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { telegramId: '4242' },
      update: {},
      create: { telegramId: '4242' },
    });
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('вход через Telegram НЕ раздаёт прав оператора', async () => {
    // Аутентификация и авторизация здесь разделены сознательно: пройти
    // /admin/auth/* может любой Telegram-пользователь, а данные админки
    // отдельно проверяют isOperator. Если бы флаг ставился тут, админка
    // открылась бы каждому, у кого есть Telegram.
    const { service, prisma } = build();
    await service.loginWithTelegram(freshPayload());

    const call = prisma.user.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty('isOperator');
    expect(call.create).not.toHaveProperty('isOperator');
  });

  it('поддельная подпись — 401 и ни одной записи в базе', async () => {
    // «Завести пользователя, а потом отказать» — тихий способ засорить
    // таблицу users чужими telegramId и подтвердить их существование.
    const { service, prisma } = build();
    const payload = freshPayload();
    payload.id = 999;

    await expect(service.loginWithTelegram(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.adminSession.create).not.toHaveBeenCalled();
  });

  it('просроченный payload тоже 401, а не «немного устаревший вход»', async () => {
    const { service } = build();
    const stale = signedPayload({
      id: 4242,
      auth_date: Math.floor(Date.now() / 1000) - 90_000,
    });
    await expect(service.loginWithTelegram(stale)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('ADMIN_LOGIN_BOT_TOKEN имеет приоритет над общим токеном', async () => {
    // У бота один домен на /setdomain, поэтому админке может достаться
    // отдельный бот. Если приоритет перепутать, вход в админку начнёт
    // принимать подписи бота мини-приложения (и наоборот — перестанет
    // принимать свои).
    process.env.ADMIN_LOGIN_BOT_TOKEN = ADMIN_BOT_TOKEN;
    const { service } = build();

    await expect(
      service.loginWithTelegram(freshPayload(ADMIN_BOT_TOKEN)),
    ).resolves.toEqual(expect.objectContaining({ token: expect.any(String) }));
    await expect(
      service.loginWithTelegram(freshPayload(BOT_TOKEN)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ни одного токена в окружении — это ошибка настройки, а не отказ входа', async () => {
    // 401 в этом случае увёл бы отладку в сторону «Telegram шлёт что-то
    // не то», хотя виновата незаполненная переменная деплоя.
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { service } = build();
    const promise = service.loginWithTelegram(freshPayload());
    await expect(promise).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
    await expect(promise).rejects.not.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminAuthService.logout', () => {
  it('гасит ровно предъявленный токен', async () => {
    // Удаление по userId разлогинило бы человека на всех устройствах —
    // не то, что обещает кнопка «Выйти».
    const { service, prisma } = build();
    await expect(service.logout('tok_1')).resolves.toEqual({ ok: true });
    expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({
      where: { token: 'tok_1' },
    });
  });

  it('неизвестный токен не считается ошибкой', async () => {
    // Выход по уже просроченной или чужой cookie — обычное дело; 500
    // здесь оставил бы человека с непогашенной cookie в браузере.
    const { service, prisma } = build();
    prisma.adminSession.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.logout('нет такого')).resolves.toEqual({ ok: true });
  });
});

describe('AdminAuthService.me', () => {
  it('отдаёт isOperator из базы — снятие прав действует немедленно', async () => {
    // Если бы флаг брался из сессии, снятый оператор ходил бы с правами
    // до истечения cookie, то есть до недели.
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ isOperator: true });

    await expect(service.me('usr_1')).resolves.toEqual({
      userId: 'usr_1',
      isOperator: true,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'usr_1' },
      select: { isOperator: true },
    });
  });

  it('обычный пользователь виден как не-оператор, а не как ошибка', async () => {
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ isOperator: false });
    await expect(service.me('usr_1')).resolves.toEqual({
      userId: 'usr_1',
      isOperator: false,
    });
  });

  it('сессия пережила удаление пользователя — 401', async () => {
    // Молчаливый ответ «не оператор» был бы хуже: клиент админки
    // остался бы с живой, но ни к чему не привязанной cookie.
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.me('usr_ghost')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
