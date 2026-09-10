/**
 * Подпись Telegram Login Widget — единственное, что отделяет вход в
 * админку от произвольного POST'а с телом `{ id: 1, auth_date: … }`.
 * Проверок в проекте две, и они РАЗНЫЕ: у Mini App initData секретный
 * ключ считается как HMAC("WebAppData", token), у виджета — как
 * SHA256(token). Перепутать их легко (одна строка), а последствие —
 * либо вход не работает вовсе, либо, при обратной ошибке, принимает
 * подпись, посчитанную по чужой схеме.
 *
 * Поэтому ни одной «магической» константы: каждая подпись в этом файле
 * считается здесь же по официальному алгоритму
 * (https://core.telegram.org/widgets/login#checking-authorization) —
 * тест ломается, если поменяется алгоритм, а не если поменяется токен.
 */

import { createHash, createHmac } from 'crypto';
import {
  validateTelegramLoginWidgetPayload,
  TelegramLoginWidgetInvalidError,
  TelegramLoginWidgetPayload,
} from './telegram-login-widget.util';

const BOT_TOKEN = '111111:AAtest-bot-token';

/** data-check-string по спецификации: `key=value`, отсортировано по
 * ключу, склеено \n, поле `hash` исключено. */
function dataCheckString(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .filter((key) => key !== 'hash')
    .filter((key) => fields[key] !== undefined && fields[key] !== null)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('\n');
}

/** Схема Login Widget: secret_key = SHA256(bot_token). */
function signAsWidget(
  fields: Record<string, unknown>,
  botToken = BOT_TOKEN,
): string {
  const secret = createHash('sha256').update(botToken).digest();
  return createHmac('sha256', secret)
    .update(dataCheckString(fields))
    .digest('hex');
}

/** Схема Mini App initData: secret_key = HMAC-SHA256("WebAppData", token).
 * Здесь она нужна ровно затем, чтобы доказать, что её подпись НЕ
 * принимается — иначе «объединение» двух валидаторов прошло бы молча. */
function signAsInitData(
  fields: Record<string, unknown>,
  botToken = BOT_TOKEN,
): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret)
    .update(dataCheckString(fields))
    .digest('hex');
}

/** Свежий payload, подписанный правильной схемой. */
function validPayload(
  overrides: Partial<Record<string, unknown>> = {},
): TelegramLoginWidgetPayload {
  const fields: Record<string, unknown> = {
    id: 4242,
    first_name: 'Пётр',
    username: 'petr',
    photo_url: 'https://t.me/i/userpic/320/petr.jpg',
    auth_date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  return {
    ...fields,
    hash: signAsWidget(fields),
  } as unknown as TelegramLoginWidgetPayload;
}

describe('validateTelegramLoginWidgetPayload — верная подпись', () => {
  it('честный payload проходит и раскладывается в поля, которыми пользуется сервис', () => {
    // Если бы разбор молча терял id, сессия завелась бы на «undefined».
    const payload = validPayload();
    const parsed = validateTelegramLoginWidgetPayload(payload, {
      botToken: BOT_TOKEN,
    });

    expect(parsed.id).toBe(4242);
    expect(parsed.firstName).toBe('Пётр');
    expect(parsed.username).toBe('petr');
    expect(parsed.photoUrl).toBe('https://t.me/i/userpic/320/petr.jpg');
    expect(parsed.authDate.getTime()).toBe(payload.auth_date * 1000);
  });

  it('необязательные поля Telegram может не прислать вовсе — это не повод отказать', () => {
    // У пользователя без username и аватара payload короче; если бы
    // отсутствующие ключи попадали в data-check-string как "username=",
    // подпись бы не сошлась и такой человек не смог бы войти никогда.
    const fields = { id: 7, auth_date: Math.floor(Date.now() / 1000) };
    const parsed = validateTelegramLoginWidgetPayload(
      { ...fields, hash: signAsWidget(fields) } as TelegramLoginWidgetPayload,
      { botToken: BOT_TOKEN },
    );
    expect(parsed.username).toBeUndefined();
    expect(parsed.photoUrl).toBeUndefined();
  });
});

describe('validateTelegramLoginWidgetPayload — схема подписи именно виджета', () => {
  it('подпись по схеме Mini App initData не принимается', () => {
    // Ровно то, что сломается при «объединении» двух валидаторов в один:
    // secret_key = HMAC("WebAppData", token) вместо SHA256(token).
    const fields = {
      id: 4242,
      auth_date: Math.floor(Date.now() / 1000),
    };
    const payload = {
      ...fields,
      hash: signAsInitData(fields),
    } as TelegramLoginWidgetPayload;

    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(TelegramLoginWidgetInvalidError);
  });

  it('подпись чужим ботом не принимается', () => {
    // Прямое следствие: у админки может быть отдельный
    // ADMIN_LOGIN_BOT_TOKEN, и вход виджетом «соседнего» бота — это вход
    // постороннего.
    const fields = { id: 4242, auth_date: Math.floor(Date.now() / 1000) };
    const payload = {
      ...fields,
      hash: signAsWidget(fields, '222222:AAother-bot'),
    } as TelegramLoginWidgetPayload;

    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(/hash mismatch/);
  });
});

describe('validateTelegramLoginWidgetPayload — испорченная подпись', () => {
  it('изменённый байт подписи ломает проверку', () => {
    const payload = validPayload();
    const first = payload.hash[0];
    payload.hash = (first === 'a' ? 'b' : 'a') + payload.hash.slice(1);

    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(/hash mismatch/);
  });

  it('подменённый после подписи id не проходит — иначе вход был бы от любого имени', () => {
    // Самая дорогая поломка из возможных: payload подписан честно, но
    // id заменён на чужой. Если бы data-check-string строилась не из
    // фактических полей, подмена прошла бы.
    const payload = validPayload();
    payload.id = 999;

    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(/hash mismatch/);
  });

  it('дописанное после подписи поле не проходит', () => {
    // Неизвестные поля обязаны участвовать в подписи: иначе к честному
    // payload'у можно было бы дописать что угодно, и оно доехало бы до
    // сервиса как «проверенное».
    const payload = validPayload() as unknown as Record<string, unknown>;
    payload.is_operator = 'true';

    expect(() =>
      validateTelegramLoginWidgetPayload(
        payload as unknown as TelegramLoginWidgetPayload,
        { botToken: BOT_TOKEN },
      ),
    ).toThrow(/hash mismatch/);
  });

  it('лишнее поле, подписанное вместе со всеми, проходит — Telegram волен добавлять поля', () => {
    // Обратная сторона той же проверки: список полей у виджета не
    // фиксирован (Telegram добавлял их не раз), и незнакомое, но честно
    // подписанное поле не должно закрывать вход всем пользователям.
    const fields = {
      id: 4242,
      auth_date: Math.floor(Date.now() / 1000),
      last_name: 'Петров',
      future_field: 'что-то новое',
    };
    const parsed = validateTelegramLoginWidgetPayload(
      { ...fields, hash: signAsWidget(fields) } as TelegramLoginWidgetPayload,
      { botToken: BOT_TOKEN },
    );
    expect(parsed.id).toBe(4242);
  });
});

describe('validateTelegramLoginWidgetPayload — отсутствующие обязательные поля', () => {
  it.each<[string, Partial<Record<string, unknown>>, RegExp]>([
    // [что доказываем, чем портим payload, текст отказа]
    ['без hash подписи нет вовсе', { hash: undefined }, /missing hash/],
    ['пустой hash — тот же случай', { hash: '' }, /missing hash/],
    ['без id непонятно, кого впускать', { id: undefined }, /missing id/],
    ['id = 0 не бывает', { id: 0 }, /missing id/],
    [
      'без auth_date подпись нельзя состарить',
      { auth_date: undefined },
      /missing id/,
    ],
  ])('%s', (_name, broken, message) => {
    const payload = { ...validPayload(), ...broken };
    expect(() =>
      validateTelegramLoginWidgetPayload(
        payload as TelegramLoginWidgetPayload,
        { botToken: BOT_TOKEN },
      ),
    ).toThrow(message);
  });

  it('пустой payload отклоняется, а не роняет процесс', () => {
    expect(() =>
      validateTelegramLoginWidgetPayload(
        undefined as unknown as TelegramLoginWidgetPayload,
        { botToken: BOT_TOKEN },
      ),
    ).toThrow(/empty payload/);
  });

  it('hash не из шестнадцатеричных цифр отклоняется отказом, а не исключением сравнения', () => {
    // timingSafeEqual бросает TypeError на буферах разной длины —
    // проверка длины до сравнения не декоративная: без неё мусорный hash
    // давал бы 500 вместо 401.
    const payload = { ...validPayload(), hash: 'не-хэш-вовсе' };
    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(TelegramLoginWidgetInvalidError);
  });
});

describe('validateTelegramLoginWidgetPayload — возраст payload', () => {
  it('просроченный auth_date не принимается', () => {
    // Подпись Telegram вечна: перехваченный один раз payload без этой
    // проверки открывал бы админку хоть через год.
    const authDate = Math.floor(Date.now() / 1000) - 86_401;
    const payload = validPayload({ auth_date: authDate });

    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(/too old/);
  });

  it('в пределах суток — ещё принимается', () => {
    const payload = validPayload({
      auth_date: Math.floor(Date.now() / 1000) - 86_000,
    });
    expect(
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }).id,
    ).toBe(4242);
  });

  it('maxAgeSeconds сужает окно — вызывающий может быть строже суток', () => {
    const payload = validPayload({
      auth_date: Math.floor(Date.now() / 1000) - 120,
    });
    expect(() =>
      validateTelegramLoginWidgetPayload(payload, {
        botToken: BOT_TOKEN,
        maxAgeSeconds: 60,
      }),
    ).toThrow(/too old/);
  });

  it('auth_date из будущего отклоняется — это не расхождение часов, а подделка', () => {
    const payload = validPayload({
      auth_date: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(() =>
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }),
    ).toThrow(/future/);
  });

  it('расхождение часов в пределах минуты входу не мешает', () => {
    // Часы клиента и сервера расходятся на секунды сплошь и рядом;
    // без этого допуска вход ломался бы «иногда и необъяснимо».
    const payload = validPayload({
      auth_date: Math.floor(Date.now() / 1000) + 30,
    });
    expect(
      validateTelegramLoginWidgetPayload(payload, { botToken: BOT_TOKEN }).id,
    ).toBe(4242);
  });
});
