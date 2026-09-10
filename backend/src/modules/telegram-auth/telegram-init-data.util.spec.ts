/**
 * HMAC-проверка `initData` — единственный барьер между «я Telegram-
 * пользователь №777» и чужим аккаунтом. Ни личность, ни владение
 * сессией дальше по стеку заново не проверяются: всё, что предъявил
 * клиент, признаётся здесь или нигде.
 *
 * Подпись в тестах считается тем же алгоритмом Telegram, а не берётся
 * готовой константой: константа доказывала бы лишь, что функция не
 * изменилась с того дня, когда её вписали, — а нужно доказать, что она
 * реализует именно алгоритм.
 */

import { createHmac } from 'crypto';
import {
  TelegramInitDataInvalidError,
  validateTelegramInitData,
} from './telegram-init-data.util';

const BOT_TOKEN = '123456:AA-фиктивный-токен-бота';

/** data-check-string = пары key=value без hash, отсортированные, через '\n'. */
function sign(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

/** Свежий initData: auth_date «сейчас», иначе сработает защита от replay. */
function initData(
  overrides: Record<string, string> = {},
  botToken = BOT_TOKEN,
): { fields: Record<string, string>; raw: string; hash: string } {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF-test',
    user: JSON.stringify({ id: 777, first_name: 'Аня', username: 'anya' }),
    ...overrides,
  };
  const hash = sign(fields, botToken);
  const params = new URLSearchParams({ ...fields, hash });
  return { fields, raw: params.toString(), hash };
}

describe('validateTelegramInitData — подпись Telegram', () => {
  it('верная подпись пропускает и отдаёт того пользователя, который в ней подписан', () => {
    const { raw } = initData();
    const parsed = validateTelegramInitData(raw, { botToken: BOT_TOKEN });

    expect(parsed.user.id).toBe(777);
    expect(parsed.user.username).toBe('anya');
    // `raw` отдаётся целиком: по нему middleware отличает источники
    // identity, и терять поля нельзя.
    expect(parsed.raw.query_id).toBe('AAF-test');
    expect(parsed.authDate.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('изменённый байт данных ломает подпись — подставить чужой id нельзя', () => {
    // Самая дешёвая атака: взять свой настоящий initData и поправить в
    // нём id. Подпись считается по ВСЕМ полям, поэтому такая правка
    // обязана разойтись с hash.
    const { fields, hash } = initData();
    const forged = new URLSearchParams({
      ...fields,
      user: JSON.stringify({ id: 1, first_name: 'Аня', username: 'anya' }),
      hash,
    }).toString();

    expect(() =>
      validateTelegramInitData(forged, { botToken: BOT_TOKEN }),
    ).toThrow(TelegramInitDataInvalidError);
  });

  it('изменённый байт самого hash тоже не проходит', () => {
    const { fields, hash } = initData();
    // Ровно один шестнадцатеричный символ на другой — длина сохраняется,
    // чтобы проверка спотыкалась именно о значение, а не о размер.
    const flipped = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
    const raw = new URLSearchParams({ ...fields, hash: flipped }).toString();

    expect(() =>
      validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
    ).toThrow(/hash mismatch/);
  });

  it('пустой hash отвергается, а не считается «подписи не требуется»', () => {
    // Пустая строка — это то, что придёт от клиента, который поле просто
    // не заполнил. Принять её значило бы пустить кого угодно.
    const { fields } = initData();
    for (const hash of ['', ' ']) {
      const raw = new URLSearchParams({ ...fields, hash }).toString();
      expect(() =>
        validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
      ).toThrow(TelegramInitDataInvalidError);
    }
    // И поля нет вовсе.
    const withoutHash = new URLSearchParams(fields).toString();
    expect(() =>
      validateTelegramInitData(withoutHash, { botToken: BOT_TOKEN }),
    ).toThrow(/missing hash/);
  });

  it('подпись чужим токеном бота не признаётся', () => {
    // Проверка привязана к нашему боту: initData из другого приложения —
    // корректно подписанный, но не наш — не даёт доступа сюда.
    const { raw } = initData({}, '999999:AA-чужой-бот');
    expect(() =>
      validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
    ).toThrow(/hash mismatch/);
  });

  it('поле signature не обязано участвовать в подписи — принимаются оба варианта', () => {
    // Клиенты Telegram расходятся в том, входит ли `signature` в
    // data-check-string. Жёсткий выбор одного варианта отрезал бы часть
    // пользователей от входа — поэтому сверяем с обоими.
    const withoutSignature = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 777, first_name: 'Аня' }),
    };
    const base = {
      ...withoutSignature,
      signature: 'ed25519-подпись-другой-схемы',
    };
    for (const hash of [sign(base), sign(withoutSignature)]) {
      const raw = new URLSearchParams({ ...base, hash }).toString();
      expect(
        validateTelegramInitData(raw, { botToken: BOT_TOKEN }).user.id,
      ).toBe(777);
    }
  });

  it('пустой initData отвергается до любых вычислений', () => {
    for (const raw of ['', '   ']) {
      expect(() =>
        validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
      ).toThrow(/empty initData/);
    }
  });
});

describe('validateTelegramInitData — свежесть и содержимое', () => {
  it('старый initData не пускает: перехваченный однажды не работает вечно', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3 * 86400);
    const { raw } = initData({ auth_date: stale });
    expect(() =>
      validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
    ).toThrow(/too old/);
    // Тот же самый initData с более длинным окном — принимается: срок
    // жизни задаётся вызывающим, а не зашит.
    expect(
      validateTelegramInitData(raw, {
        botToken: BOT_TOKEN,
        maxAgeSeconds: 4 * 86400,
      }).user.id,
    ).toBe(777);
  });

  it('auth_date из будущего отвергается — часы клиента не аргумент', () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const { raw } = initData({ auth_date: future });
    expect(() =>
      validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
    ).toThrow(/future/);
  });

  it('подписанный, но бессодержательный initData не даёт личности', () => {
    // Подпись верна — а пользователя в ней нет. Пропустить такое значило
    // бы завести сессию без владельца.
    const noUser = initData();
    delete noUser.fields.user;
    const rawNoUser = new URLSearchParams({
      ...noUser.fields,
      hash: sign(noUser.fields),
    }).toString();
    expect(() =>
      validateTelegramInitData(rawNoUser, { botToken: BOT_TOKEN }),
    ).toThrow(/missing user/);

    for (const [user, message] of [
      ['не json', /not valid JSON/],
      [JSON.stringify({ first_name: 'Аня' }), /user\.id missing/],
    ] as const) {
      const fields = { ...noUser.fields, user };
      const raw = new URLSearchParams({
        ...fields,
        hash: sign(fields),
      }).toString();
      expect(() =>
        validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
      ).toThrow(message);
    }
  });

  it('без auth_date подпись верна, но защиты от повтора нет — отказ', () => {
    const fields = {
      user: JSON.stringify({ id: 777, first_name: 'Аня' }),
    };
    const raw = new URLSearchParams({
      ...fields,
      hash: sign(fields),
    }).toString();
    expect(() =>
      validateTelegramInitData(raw, { botToken: BOT_TOKEN }),
    ).toThrow(/missing auth_date/);
  });
});
