/**
 * GoogleIndexingService — клиент Google Indexing API: сообщает Google
 * «перекрауль этот URL прямо сейчас» в момент старта и конца живого
 * эфира лота.
 *
 * Почему тонкий клиент внешнего API всё-таки стоит тестов. Весь сервис
 * best-effort: ни один вызывающий не смотрит на результат, любая ошибка
 * проглатывается в лог. Значит, сломаться он может только молча — и
 * ровно два вида поломки здесь стоят дорого:
 *
 *  1. **Вызов ушёл, когда не должен был.** Indexing API официально
 *     поддерживает только страницы с разметкой JobPosting/BroadcastEvent;
 *     вызовы для чего угодно ещё — злоупотребление, за которое домен
 *     отправляют на ручную проверку. Единственная защита в коде —
 *     `isConfigured()` и явный флаг `GOOGLE_INDEXING_ENABLED`. Если он
 *     перестанет держать, сеть увидит запросы там, где их быть не должно.
 *  2. **Вызов не ушёл, хотя должен был.** Разметка эфира дойдёт до
 *     Google часами позже, то есть когда торги уже закончились — а
 *     заметить это по логам невозможно, там всегда тихо.
 *
 * Отдельно проверяется подпись JWT: она собирается вручную, без
 * google-auth-library, и ошибка в формате даёт единственный симптом —
 * молчаливый 400 от Google.
 */

import { generateKeyPairSync } from 'crypto';
import { GoogleIndexingService } from './google-indexing.service';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBLISH_URL =
  'https://indexing.googleapis.com/v3/urlNotifications:publish';

/** Настоящая пара ключей — подпись RS256 должна реально считаться. */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: jest.fn().mockResolvedValue(body),
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

const failJson = (status: number, body = 'error') => ({
  ok: false,
  status,
  json: jest.fn().mockResolvedValue({}),
  text: jest.fn().mockResolvedValue(body),
});

let fetchMock: jest.Mock;
const envBefore = { ...process.env };

/** Разбирает вызовы fetch по адресу. */
const callsTo = (url: string) =>
  fetchMock.mock.calls.filter(([u]) => u === url);

beforeEach(() => {
  process.env.GOOGLE_INDEXING_ENABLED = 'true';
  process.env.GOOGLE_INDEXING_SA_EMAIL = 'bot@v4c.iam.gserviceaccount.com';
  // В env ключ хранится с экранированными переносами — сервис обязан их
  // разэкранировать, иначе подпись не соберётся.
  process.env.GOOGLE_INDEXING_SA_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');

  fetchMock = jest
    .fn()
    .mockImplementation((url: string) =>
      Promise.resolve(
        url === TOKEN_URL
          ? okJson({ access_token: 'ya29.token', expires_in: 3600 })
          : okJson({}),
      ),
    );
  global.fetch = fetchMock as never;
});

afterEach(() => {
  process.env = { ...envBefore };
  jest.useRealTimers();
});

describe('isConfigured', () => {
  it('требует явного флага включения, а не только наличия ключей', () => {
    // Ключи могут лежать в env «на будущее»; включение — отдельное
    // осознанное действие, иначе стенд начнёт слать запросы в прод-API.
    process.env.GOOGLE_INDEXING_ENABLED = 'false';
    expect(new GoogleIndexingService().isConfigured()).toBe(false);

    delete process.env.GOOGLE_INDEXING_ENABLED;
    expect(new GoogleIndexingService().isConfigured()).toBe(false);
  });

  it('строка «true», а не любое правдоподобное значение', () => {
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      process.env.GOOGLE_INDEXING_ENABLED = value;
      expect(new GoogleIndexingService().isConfigured()).toBe(false);
    }
    process.env.GOOGLE_INDEXING_ENABLED = 'true';
    expect(new GoogleIndexingService().isConfigured()).toBe(true);
  });

  it('без почты или ключа сервиса — не настроен', () => {
    delete process.env.GOOGLE_INDEXING_SA_EMAIL;
    expect(new GoogleIndexingService().isConfigured()).toBe(false);

    process.env.GOOGLE_INDEXING_SA_EMAIL = 'bot@v4c.iam.gserviceaccount.com';
    delete process.env.GOOGLE_INDEXING_SA_PRIVATE_KEY;
    expect(new GoogleIndexingService().isConfigured()).toBe(false);
  });
});

describe('notify — когда вызов вообще не уходит', () => {
  it('ненастроенная интеграция не делает НИ ОДНОГО сетевого вызова', async () => {
    process.env.GOOGLE_INDEXING_ENABLED = 'false';
    const service = new GoogleIndexingService();

    expect(await service.notify('https://v4c.test/auctions/l1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пустой URL не уходит в Google', async () => {
    const service = new GoogleIndexingService();
    expect(await service.notify('')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('notify — подпись и обмен токена', () => {
  it('JWT собран по требованиям Google: RS256, нужные поля, часовой срок', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00Z'));
    const service = new GoogleIndexingService();
    await service.notify('https://v4c.test/auctions/l1');

    const [, init] = callsTo(TOKEN_URL)[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );

    const assertion = body.get('assertion') as string;
    const [header, claim, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });

    const now = Math.floor(Date.now() / 1000);
    expect(JSON.parse(Buffer.from(claim, 'base64url').toString())).toEqual({
      iss: 'bot@v4c.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/indexing',
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    });

    // base64url, а не обычный base64: '+', '/' и хвостовые '=' ломают JWT.
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature.length).toBeGreaterThan(300); // подпись RSA-2048
  });

  it('экранированные переносы строк в ключе разэкранируются — иначе подписи не будет', async () => {
    // В env PEM лежит одной строкой с буквальными \n.
    const service = new GoogleIndexingService();
    expect(await service.notify('https://v4c.test/auctions/l1')).toBe(true);
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it('непригодный ключ — ни обмена токена, ни публикации, и без исключения', async () => {
    process.env.GOOGLE_INDEXING_SA_PRIVATE_KEY = 'это-не-PEM';
    const service = new GoogleIndexingService();

    await expect(service.notify('https://v4c.test/auctions/l1')).resolves.toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('токен переиспользуется — второй вызов не ходит за ним заново', async () => {
    const service = new GoogleIndexingService();
    await service.notify('https://v4c.test/auctions/l1');
    await service.notify('https://v4c.test/auctions/l2');

    expect(callsTo(TOKEN_URL)).toHaveLength(1);
    expect(callsTo(PUBLISH_URL)).toHaveLength(2);
  });

  it('токен перевыпускается заранее, не дожидаясь истечения', async () => {
    // Запас в минуту: иначе токен может протухнуть ровно в полёте.
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00Z'));
    const service = new GoogleIndexingService();
    await service.notify('https://v4c.test/auctions/l1');

    jest.setSystemTime(new Date('2026-09-21T12:58:00Z')); // 58 минут — ещё свой
    await service.notify('https://v4c.test/auctions/l2');
    expect(callsTo(TOKEN_URL)).toHaveLength(1);

    jest.setSystemTime(new Date('2026-09-21T12:59:30Z')); // до конца меньше минуты
    await service.notify('https://v4c.test/auctions/l3');
    expect(callsTo(TOKEN_URL)).toHaveLength(2);
  });

  it('отказ в обмене токена не доходит до публикации', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === TOKEN_URL ? failJson(401, 'invalid_grant') : okJson({}),
      ),
    );
    const service = new GoogleIndexingService();

    expect(await service.notify('https://v4c.test/auctions/l1')).toBe(false);
    expect(callsTo(PUBLISH_URL)).toHaveLength(0);
  });

  it('неуспешный статус обмена токена решает всё, даже если тело похоже на успешное', async () => {
    // Google на отказе нередко возвращает JSON с полями, похожими на
    // нормальный ответ. Решать должен статус, иначе в Indexing API
    // уйдёт запрос с заведомо негодным токеном.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === TOKEN_URL
          ? {
              ok: false,
              status: 401,
              json: jest.fn().mockResolvedValue({
                access_token: 'не-настоящий',
                expires_in: 3600,
              }),
              text: jest.fn().mockResolvedValue('{"error":"invalid_grant"}'),
            }
          : okJson({}),
      ),
    );
    const service = new GoogleIndexingService();

    expect(await service.notify('https://v4c.test/auctions/l1')).toBe(false);
    expect(callsTo(PUBLISH_URL)).toHaveLength(0);
  });

  it('ответ без access_token не выдаётся за успех', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === TOKEN_URL ? okJson({ expires_in: 3600 }) : okJson({}),
      ),
    );
    const service = new GoogleIndexingService();

    expect(await service.notify('https://v4c.test/auctions/l1')).toBe(false);
    expect(callsTo(PUBLISH_URL)).toHaveLength(0);
  });

  it('сетевой сбой при обмене токена не бросает исключение наружу', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === TOKEN_URL
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve(okJson({})),
    );
    const service = new GoogleIndexingService();

    await expect(service.notify('https://v4c.test/auctions/l1')).resolves.toBe(
      false,
    );
  });
});

describe('notify — сама публикация', () => {
  it('URL и тип уходят в теле, токен — в заголовке', async () => {
    const service = new GoogleIndexingService();
    await service.notify('https://v4c.test/auctions/l1', 'URL_UPDATED');

    const [url, init] = callsTo(PUBLISH_URL)[0] as [string, RequestInit];
    expect(url).toBe(PUBLISH_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ya29.token',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://v4c.test/auctions/l1',
      type: 'URL_UPDATED',
    });
  });

  it('тип по умолчанию — URL_UPDATED, а не удаление страницы', async () => {
    // Значение по умолчанию тут не косметика: URL_DELETED попросил бы
    // Google выкинуть живую страницу лота из индекса.
    const service = new GoogleIndexingService();
    await service.notify('https://v4c.test/auctions/l1');

    expect(JSON.parse(callsTo(PUBLISH_URL)[0][1].body as string).type).toBe(
      'URL_UPDATED',
    );
  });

  it('удаление страницы передаётся, когда его просят явно', async () => {
    const service = new GoogleIndexingService();
    await service.notify('https://v4c.test/auctions/l1', 'URL_DELETED');

    expect(JSON.parse(callsTo(PUBLISH_URL)[0][1].body as string).type).toBe(
      'URL_DELETED',
    );
  });

  it('успех — true, отказ Google — false, но без исключения', async () => {
    const service = new GoogleIndexingService();
    expect(await service.notify('https://v4c.test/auctions/l1')).toBe(true);

    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === TOKEN_URL
          ? okJson({ access_token: 'ya29.token', expires_in: 3600 })
          : failJson(429, 'Quota exceeded'),
      ),
    );
    const throttled = new GoogleIndexingService();
    await expect(
      throttled.notify('https://v4c.test/auctions/l1'),
    ).resolves.toBe(false);
  });

  it('обрыв сети на публикации не роняет вызывающего', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === TOKEN_URL
        ? Promise.resolve(okJson({ access_token: 't', expires_in: 3600 }))
        : Promise.reject(new Error('socket hang up')),
    );
    const service = new GoogleIndexingService();

    await expect(service.notify('https://v4c.test/auctions/l1')).resolves.toBe(
      false,
    );
  });
});
