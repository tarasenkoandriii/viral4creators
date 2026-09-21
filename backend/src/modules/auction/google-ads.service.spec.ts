/**
 * GoogleAdsService — REST-клиент Google Ads: одна Performance Max
 * кампания на блиц-лот, пауза при уходе лота из торгов.
 *
 * Самое дорогое здесь — не форма запроса, а инвариант возврата.
 * `createBlitzCampaign` делает шесть последовательных вызовов Google, и
 * после ВТОРОГО кампания уже существует в аккаунте и способна тратить
 * деньги. Если функция бросит исключение на любом из оставшихся
 * четырёх шагов, вызывающий (`AuctionService`) поймает его в свой
 * best-effort try/catch, залогирует — и НЕ сохранит
 * `googleAdsCampaignId`. Получится кампания-сирота: она есть в Google
 * Ads, но ни одной ссылки на неё нет ни в БД, ни в логах, а значит её
 * некому поставить на паузу, когда лот закроется. Ровно это и чинил
 * аудит-фикс, разложивший шаги 3–6 по отдельным try/catch.
 *
 * Поэтому ниже проверяется, что resource name возвращается при отказе
 * на каждом шаге по отдельности и при отказе на всех сразу.
 *
 * Второй по цене инвариант — `isConfigured()`: без него ненастроенный
 * стенд начал бы ходить в боевой рекламный кабинет.
 */

import { GoogleAdsService, imageSize } from './google-ads.service';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/**
 * Версия, на которую рассчитан клиент по умолчанию. Прежде здесь стояло
 * `v18` — отключённое Google 20 августа 2025 года, то есть тесты
 * проверяли форму запросов к версии, которая уже год как не отвечает.
 */
const DEFAULT_API_VERSION = 'v25';
const adsPrefix = (version = DEFAULT_API_VERSION) =>
  `https://googleads.googleapis.com/${version}/customers/1234567890/`;
const ADS_PREFIX = adsPrefix();

const ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
  GOOGLE_ADS_CUSTOMER_ID: '1234567890',
};

const input = (
  over: Partial<Parameters<GoogleAdsService['createBlitzCampaign']>[0]> = {},
) => ({
  listingId: 'l1',
  title: 'Ролик про кружку',
  thumbnailUrl: 'https://blob.test/thumb.jpg',
  finalUrl: 'https://v4c.test/auctions/l1',
  dailyBudgetMicros: 5_000_000,
  ...over,
});

const textRes = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: jest.fn().mockResolvedValue(body),
  arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
});

const LOGO_URL = 'https://cdn.test/logo-square.png';

/** Минимальный PNG: сигнатура + IHDR с размерами. */
const pngBytes = (width: number, height: number): Buffer => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

/**
 * JPEG с сегментом DHT перед SOF0 — как в настоящих файлах. DHT тоже
 * попадает в диапазон маркеров 0xC0–0xCF, но размеров не несёт: принять
 * его за SOF значит прочитать случайные байты как ширину и высоту.
 */
const jpegWithDhtBytes = (width: number, height: number): Buffer => {
  const dhtPayload = Buffer.alloc(20, 0x11);
  const dhtLength = Buffer.alloc(2);
  dhtLength.writeUInt16BE(2 + dhtPayload.length, 0);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc4]),
    dhtLength,
    dhtPayload,
    Buffer.from([0xff, 0xc0]),
    sof,
  ]);
};

/** JPEG с испорченной длиной сегмента, за которой идёт годный SOF0. */
const jpegCorruptSegmentBytes = (width: number, height: number): Buffer => {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]),
    Buffer.from([0x00, 0x00]), // длина 0 — так не бывает
    Buffer.alloc(8),
    Buffer.from([0xff, 0xc0]),
    sof,
  ]);
};

/** Минимальный JPEG: SOI + SOF0 с размерами. */
const jpegBytes = (width: number, height: number): Buffer => {
  const b = Buffer.alloc(24);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
};

/** Ответ с настоящими байтами картинки (не заглушкой на 8 байт). */
const imageRes = (buf: Buffer) => ({
  ok: true,
  status: 200,
  text: jest.fn().mockResolvedValue(''),
  // Копия с нулевым смещением: Buffer из пула может указывать в середину
  // общего ArrayBuffer, и тогда получатель прочитал бы чужие байты.
  arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array(buf).buffer),
});

const mutateOk = (...names: string[]) =>
  textRes(
    200,
    JSON.stringify({
      results: names.map((resourceName) => ({ resourceName })),
    }),
  );

let fetchMock: jest.Mock;
const envBefore = { ...process.env };

/** Какие ресурсы Google Ads дёргались, по порядку. */
const mutatedResources = () =>
  fetchMock.mock.calls
    .map(([url]) => url as string)
    .filter((u) => u.startsWith(ADS_PREFIX))
    .map((u) => u.slice(ADS_PREFIX.length).replace(':mutate', ''));

/** Тела всех вызовов к одному ресурсу. */
const bodiesFor = (resource: string) =>
  fetchMock.mock.calls
    .filter(([url]) => (url as string) === `${ADS_PREFIX}${resource}:mutate`)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

/** Маршрутизация по умолчанию: всё успешно. */
function defaultRouter(overrides: Record<string, () => unknown> = {}) {
  return (url: string, init?: RequestInit) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        textRes(
          200,
          JSON.stringify({ access_token: 'ya29.ads', expires_in: 3600 }),
        ),
      );
    }
    if (url.startsWith(ADS_PREFIX)) {
      const resource = url.slice(ADS_PREFIX.length).replace(':mutate', '');
      if (overrides[resource]) return Promise.resolve(overrides[resource]());
      if (resource === 'assets') {
        // Ровно столько ресурсов, сколько операций прислали: Google
        // отвечает один к одному, и на этом соответствии держится
        // разбиение ответа на заголовки и описания.
        const ops = JSON.parse((init?.body as string) ?? '{"operations":[]}')
          .operations as unknown[];
        return Promise.resolve(
          mutateOk(
            ...ops.map((_, i) => `customers/1234567890/assets/${i + 1}`),
          ),
        );
      }
      return Promise.resolve(mutateOk(`customers/1234567890/${resource}/1`));
    }
    if (url === LOGO_URL) return Promise.resolve(imageRes(pngBytes(512, 512)));
    // Скачивание превью.
    return Promise.resolve(textRes(200, 'image-bytes'));
  };
}

beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  delete process.env.GOOGLE_ADS_API_VERSION;
  delete process.env.GOOGLE_ADS_LOGO_URL;
  fetchMock = jest.fn().mockImplementation(defaultRouter());
  global.fetch = fetchMock as never;
});

afterEach(() => {
  process.env = { ...envBefore };
});

describe('isConfigured', () => {
  it('без любой из пяти обязательных переменных интеграция выключена', () => {
    for (const key of Object.keys(ENV)) {
      const saved = process.env[key];
      delete process.env[key];
      expect(new GoogleAdsService().isConfigured()).toBe(false);
      process.env[key] = saved;
    }
    expect(new GoogleAdsService().isConfigured()).toBe(true);
  });

  it('MCC-аккаунт не обязателен', () => {
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    delete process.env.GOOGLE_ADS_API_VERSION;
    delete process.env.GOOGLE_ADS_LOGO_URL;
    expect(new GoogleAdsService().isConfigured()).toBe(true);
  });
});

describe('createBlitzCampaign — ненастроенная интеграция', () => {
  it('возвращает null и не делает ни одного сетевого вызова', async () => {
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const service = new GoogleAdsService();

    expect(await service.createBlitzCampaign(input())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createBlitzCampaign — авторизация и заголовки', () => {
  it('токен получается по refresh_token и переиспользуется между вызовами', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());
    await service.createBlitzCampaign(input({ listingId: 'l2' }));

    const tokenCalls = fetchMock.mock.calls.filter(
      ([u]) => u === OAUTH_TOKEN_URL,
    );
    expect(tokenCalls).toHaveLength(1);
    const body = tokenCalls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-token');
    expect(body.get('client_id')).toBe('client-id');
  });

  it('каждый запрос несёт developer-token и Bearer', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const adsCalls = fetchMock.mock.calls.filter(([u]) =>
      (u as string).startsWith(ADS_PREFIX),
    );
    expect(adsCalls.length).toBeGreaterThan(0);
    for (const [, init] of adsCalls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['developer-token']).toBe('dev-token');
      expect(headers.Authorization).toBe('Bearer ya29.ads');
      expect(headers['login-customer-id']).toBeUndefined();
    }
  });

  it('MCC-аккаунт передаётся заголовком, только если задан', async () => {
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '9999999999';
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const [, init] = fetchMock.mock.calls.find(([u]) =>
      (u as string).startsWith(ADS_PREFIX),
    ) as [string, RequestInit];
    expect((init.headers as Record<string, string>)['login-customer-id']).toBe(
      '9999999999',
    );
  });

  it('отказ в обмене токена не создаёт ничего наполовину', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === OAUTH_TOKEN_URL
        ? Promise.resolve(textRes(400, 'invalid_grant'))
        : Promise.resolve(mutateOk('x')),
    );
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).rejects.toThrow(
      /OAuth refresh/,
    );
    expect(mutatedResources()).toHaveLength(0);
  });
});

describe('createBlitzCampaign — что именно создаётся', () => {
  it('бюджет — целое число микро в строке, не меньше единицы', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(
      input({ dailyBudgetMicros: 4_999_999.6 }),
    );

    const [budget] = bodiesFor('campaignBudgets');
    expect(budget.operations[0].create).toMatchObject({
      name: 'v4c-blitz-l1-budget',
      amountMicros: '5000000',
      deliveryMethod: 'STANDARD',
    });
  });

  it('нулевой или отрицательный бюджет не уходит в Google как есть', async () => {
    // amountMicros: 0 Google отверг бы, а отрицательный — тем более;
    // поднимаем до минимально осмысленной единицы.
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input({ dailyBudgetMicros: -100 }));

    expect(
      bodiesFor('campaignBudgets')[0].operations[0].create.amountMicros,
    ).toBe('1');
  });

  it('кампания создаётся ВЫКЛЮЧЕННОЙ и включается отдельным последним шагом', async () => {
    // Иначе деньги начнут тратиться на заведомо неполную настройку:
    // Google требует минимум 4+4 изображения, а у лота одно превью.
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const campaignBodies = bodiesFor('campaigns');
    expect(campaignBodies[0].operations[0].create).toMatchObject({
      name: 'v4c-blitz-l1',
      advertisingChannelType: 'PERFORMANCE_MAX',
      status: 'PAUSED',
      brandGuidelinesEnabled: false,
    });

    const last = campaignBodies[campaignBodies.length - 1].operations[0];
    expect(last.update).toMatchObject({ status: 'ENABLED' });
    expect(last.updateMask).toBe('status');
  });

  it('кампания привязана к только что созданному бюджету', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    expect(bodiesFor('campaigns')[0].operations[0].create.campaignBudget).toBe(
      'customers/1234567890/campaignBudgets/1',
    );
  });

  it('группа ассетов ведёт на карточку лота', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    expect(bodiesFor('assetGroups')[0].operations[0].create).toMatchObject({
      campaign: 'customers/1234567890/campaigns/1',
      finalUrls: ['https://v4c.test/auctions/l1'],
      status: 'ENABLED',
    });
  });

  /**
   * Тексты ассетов, разложенные по типу поля. Сопоставление позиционное
   * — ровно так же, как это делает сам клиент: Google отвечает на
   * `assets:mutate` один к одному с операциями запроса.
   */
  const textsByFieldType = (): Record<string, string[]> => {
    const texts = bodiesFor('assets')[0].operations.map(
      (o: { create: { textAsset?: { text: string } } }) =>
        o.create.textAsset?.text as string,
    );
    const types = bodiesFor('assetGroupAssets')[0].operations.map(
      (o: { create: { fieldType: string } }) => o.create.fieldType,
    );
    const out: Record<string, string[]> = {};
    types.forEach((t: string, i: number) => {
      (out[t] ??= []).push(texts[i]);
    });
    return out;
  };

  it('текстовые ассеты укладываются в лимиты своих типов', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(
      input({
        title: 'Очень длинное название ролика про большую стальную кружку',
      }),
    );

    const byType = textsByFieldType();
    for (const h of byType.HEADLINE) expect(h.length).toBeLessThanOrEqual(30);
    for (const d of byType.DESCRIPTION)
      expect(d.length).toBeLessThanOrEqual(90);
    expect(byType.LONG_HEADLINE[0].length).toBeLessThanOrEqual(90);
    expect(byType.BUSINESS_NAME[0].length).toBeLessThanOrEqual(25);
    expect(byType.HEADLINE.some((h) => h.endsWith('…'))).toBe(true);
  });

  // Требования asset group по документации Google Ads API: HEADLINE
  // минимум 3, LONG_HEADLINE минимум 1, DESCRIPTION минимум 2,
  // BUSINESS_NAME ровно 1 (обязателен, потому что brand guidelines
  // выключены — они не убирают ассеты бренда, а переносят их с уровня
  // кампании на уровень группы).
  it.each([
    ['короткое название', 'Ролик про кружку'],
    ['название ровно на границе обрезки', 'Обзор кружки Steel 500 мл!!!!!'],
    [
      'длинное название — прежняя сборка давала два заголовка',
      'Очень длинное название ролика про большую стальную кружку',
    ],
    ['название совпало с шаблонным заголовком', 'Аукцион видео viral4creators'],
    ['название из запасного списка', 'Эксклюзивное UGC-видео'],
    ['название из короткого набора', 'Аукцион видео'],
    ['пустое название', '   '],
  ])('%s: минимумы по каждому типу ассета соблюдены', async (_case, title) => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input({ title }));

    const byType = textsByFieldType();
    expect(byType.HEADLINE).toHaveLength(3);
    expect(new Set(byType.HEADLINE).size).toBe(3);
    expect(byType.LONG_HEADLINE).toHaveLength(1);
    expect(byType.DESCRIPTION).toHaveLength(2);
    expect(byType.BUSINESS_NAME).toHaveLength(1);

    for (const h of byType.HEADLINE) {
      expect(h.length).toBeLessThanOrEqual(30);
      expect(h.trim()).not.toBe('');
    }
    // Справка Google: хотя бы один заголовок не длиннее 15 символов.
    expect(byType.HEADLINE.some((h) => h.length <= 15)).toBe(true);
  });

  it('название лота попадает в заголовки, а не подменяется шаблоном', async () => {
    // Запасные и короткие варианты — добор до минимума, а не замена:
    // объявление без названия лота бессмысленно.
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(
      input({ title: 'Обзор термокружки Steel 500 мл с доставкой' }),
    );

    const [first, second] = textsByFieldType().HEADLINE;
    expect(first).toContain('Обзор термокружки');
    expect(second).toContain('Обзор термокружки');
    // Второй вариант отличается по смыслу, а не только обрезкой.
    expect(second).toContain('эксклюзив');
  });

  it('длинный заголовок содержит название лота', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input({ title: 'Ролик про кружку' }));

    expect(textsByFieldType().LONG_HEADLINE[0]).toContain('Ролик про кружку');
  });

  it('без названия лота длинный заголовок не превращается в пустые кавычки', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input({ title: '   ' }));

    const fallback = textsByFieldType().LONG_HEADLINE[0];
    expect(fallback.trim().length).toBeGreaterThan(20);
    expect(fallback).not.toContain('«»');
  });

  it('имя бренда отправляется — asset group без него неполна', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    expect(textsByFieldType().BUSINESS_NAME).toEqual(['viral4creators']);
  });

  it('ни один текстовый ассет не остаётся без типа поля', async () => {
    // Раньше типы восстанавливались нарезкой ответа по индексам, и
    // лишний ассет молча остался бы непривязанным.
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const created = bodiesFor('assets')[0].operations.length;
    const linked = bodiesFor('assetGroupAssets')[0].operations.length;
    expect(linked).toBe(created);
  });
});

describe('версия API', () => {
  it('по умолчанию — актуальная, а не отключённая Google v18', async () => {
    // v18 отключена 20 августа 2025 года: все запросы к ней падают.
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const adsCalls = fetchMock.mock.calls
      .map(([u]) => u as string)
      .filter((u) => u.includes('googleads.googleapis.com'));
    expect(adsCalls.length).toBeGreaterThan(0);
    for (const url of adsCalls) {
      expect(url).toContain(`/${DEFAULT_API_VERSION}/`);
      expect(url).not.toContain('/v18/');
    }
  });

  it('версия переопределяется переменной окружения — без правки кода', async () => {
    // Google снимает версии примерно раз в год; следующий сдвиг не
    // должен требовать пересборки.
    process.env.GOOGLE_ADS_API_VERSION = 'v26';
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === OAUTH_TOKEN_URL) return defaultRouter()(url, init);
      if (url.startsWith(adsPrefix('v26'))) {
        return Promise.resolve(mutateOk('customers/1234567890/campaigns/1'));
      }
      return Promise.resolve(textRes(200, 'image-bytes'));
    });
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
    const adsCalls = fetchMock.mock.calls
      .map(([u]) => u as string)
      .filter((u) => u.includes('googleads.googleapis.com'));
    for (const url of adsCalls) expect(url).toContain('/v26/');
  });

  it('пустая переменная окружения не даёт версию-пустышку в URL', async () => {
    process.env.GOOGLE_ADS_API_VERSION = '';
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const [url] = fetchMock.mock.calls
      .map(([u]) => u as string)
      .filter((u) => u.includes('googleads.googleapis.com'));
    expect(url).toContain(`/${DEFAULT_API_VERSION}/`);
    expect(url).not.toContain('//customers/');
  });
});

describe('createBlitzCampaign — изображение превью', () => {
  it('превью скачивается и уходит байтами, а не ссылкой', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    expect(fetchMock).toHaveBeenCalledWith('https://blob.test/thumb.jpg');
    const imageOp = bodiesFor('assets')
      .flatMap((b) => b.operations)
      .find((o: { create: { imageAsset?: unknown } }) => o.create.imageAsset);
    expect(imageOp.create.imageAsset.data).toBe(
      Buffer.from(new ArrayBuffer(8)).toString('base64'),
    );
  });

  it('два формата изображения привязываются РАЗНЫМИ вызовами', async () => {
    // Аудит-фикс: в одном атомарном вызове отказ Google по одному
    // соотношению сторон валил бы и вторую привязку, и уже валидные
    // заголовки вместе с ней.
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const imageLinks = bodiesFor('assetGroupAssets').filter((b) =>
      b.operations.some((o: { create: { fieldType: string } }) =>
        o.create.fieldType.includes('MARKETING_IMAGE'),
      ),
    );
    expect(imageLinks).toHaveLength(2);
    for (const body of imageLinks) expect(body.operations).toHaveLength(1);
    expect(
      imageLinks.map((b) => b.operations[0].create.fieldType as string),
    ).toEqual(['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE']);
  });

  it('отказ по квадратному формату не отменяет уже привязанный горизонтальный', async () => {
    let seen = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === `${ADS_PREFIX}assetGroupAssets:mutate`) {
        const body = JSON.parse(init.body as string);
        const isImage = body.operations.some(
          (o: { create: { fieldType: string } }) =>
            o.create.fieldType.includes('MARKETING_IMAGE'),
        );
        if (isImage) {
          seen += 1;
          if (seen === 2) return Promise.resolve(textRes(400, 'aspect ratio'));
        }
      }
      return defaultRouter()(url, init);
    });
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
    expect(seen).toBe(2);
  });

  it('лот без превью не идёт за картинкой вовсе', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input({ thumbnailUrl: null }));

    expect(fetchMock).not.toHaveBeenCalledWith('https://blob.test/thumb.jpg');
  });

  it('недоступное превью не отменяет кампанию', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === 'https://blob.test/thumb.jpg'
        ? Promise.reject(new Error('blob store 503'))
        : defaultRouter()(url, init),
    );
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
  });
});

describe('createBlitzCampaign — кампания не должна стать сиротой', () => {
  /** Сломать ровно один шаг после создания кампании. */
  const breakStep = (resource: string, nth = 1) => {
    let seen = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === `${ADS_PREFIX}${resource}:mutate`) {
        seen += 1;
        if (seen === nth) return Promise.resolve(textRes(500, 'Google is sad'));
      }
      return defaultRouter()(url, init);
    });
  };

  it.each([
    ['группа ассетов', 'assetGroups', 1],
    ['создание текстовых ассетов', 'assets', 1],
    ['привязка ассетов', 'assetGroupAssets', 1],
    ['включение кампании', 'campaigns', 2],
  ])(
    'отказ на шаге «%s» всё равно возвращает resource name кампании',
    async (_name, resource, nth) => {
      breakStep(resource as string, nth as number);
      const service = new GoogleAdsService();

      await expect(service.createBlitzCampaign(input())).resolves.toBe(
        'customers/1234567890/campaigns/1',
      );
    },
  );

  it('отказ на ВСЕХ шагах после создания кампании — тот же результат', async () => {
    let campaignCalls = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === OAUTH_TOKEN_URL) return defaultRouter()(url, init);
      if (url === `${ADS_PREFIX}campaignBudgets:mutate`) {
        return Promise.resolve(
          mutateOk('customers/1234567890/campaignBudgets/1'),
        );
      }
      if (url === `${ADS_PREFIX}campaigns:mutate`) {
        // Создание проходит, включение — нет.
        campaignCalls += 1;
        return Promise.resolve(
          campaignCalls === 1
            ? mutateOk('customers/1234567890/campaigns/1')
            : textRes(500, 'nope'),
        );
      }
      if (url.startsWith(ADS_PREFIX))
        return Promise.resolve(textRes(500, 'nope'));
      return Promise.resolve(textRes(500, 'nope'));
    });
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
  });

  it('а вот отказ ДО создания кампании исключение не глотает', async () => {
    // Здесь ещё нечего терять: ресурса в Google не появилось, и
    // вызывающий должен увидеть ошибку, а не пустой успех.
    breakStep('campaignBudgets');
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).rejects.toThrow(
      /campaignBudgets:mutate/,
    );
  });
});

describe('pauseCampaign', () => {
  it('ненастроенная интеграция молча ничего не делает', async () => {
    delete process.env.GOOGLE_ADS_CUSTOMER_ID;
    const service = new GoogleAdsService();

    await expect(
      service.pauseCampaign('customers/1/campaigns/2'),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ставит на паузу именно названную кампанию', async () => {
    const service = new GoogleAdsService();
    await service.pauseCampaign('customers/1234567890/campaigns/77');

    expect(bodiesFor('campaigns')[0].operations[0]).toEqual({
      update: {
        resourceName: 'customers/1234567890/campaigns/77',
        status: 'PAUSED',
      },
      updateMask: 'status',
    });
  });

  it('отказ Google пробрасывается — паузу обязан увидеть вызывающий', async () => {
    // §22 требует паузу ОБЯЗАТЕЛЬНО, не best-effort: AuctionService
    // считает неудачные попытки и эскалирует оператору, а для этого
    // должен о них узнать.
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === OAUTH_TOKEN_URL
        ? defaultRouter()(url, init)
        : Promise.resolve(textRes(403, 'permission denied')),
    );
    const service = new GoogleAdsService();

    await expect(
      service.pauseCampaign('customers/1234567890/campaigns/77'),
    ).rejects.toThrow(/campaigns:mutate/);
  });
});

// ── Логотип 1:1 ──────────────────────────────────────────────────────

describe('imageSize — размеры из заголовка файла', () => {
  // Единственное назначение парсера — не отправлять в Google заведомо
  // негодный логотип. Ошибётся он в одну сторону — потратим вызов и
  // получим невнятную ошибку, в другую — молча не отправим годный файл.
  it('читает размеры PNG', () => {
    expect(imageSize(pngBytes(512, 512))).toEqual({ width: 512, height: 512 });
    expect(imageSize(pngBytes(1200, 630))).toEqual({
      width: 1200,
      height: 630,
    });
  });

  it('читает размеры JPEG', () => {
    expect(imageSize(jpegBytes(256, 256))).toEqual({ width: 256, height: 256 });
    expect(imageSize(jpegBytes(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('не путает ширину с высотой', () => {
    // В JPEG они лежат в обратном порядке относительно PNG — самое
    // лёгкое место для ошибки, и прямой симптом у неё один: квадратный
    // логотип объявляется неквадратным и не уходит.
    expect(imageSize(pngBytes(800, 400))).toEqual({ width: 800, height: 400 });
    expect(imageSize(jpegBytes(800, 400))).toEqual({ width: 800, height: 400 });
  });

  it('неизвестный формат и мусор — null, решает Google', () => {
    expect(
      imageSize(Buffer.from('GIF89a и ещё немного байтов сверху')),
    ).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(
      imageSize(Buffer.from('это просто текст, а не картинка вовсе')),
    ).toBeNull();
  });

  it('обрезанный файл не роняет разбор', () => {
    expect(imageSize(pngBytes(10, 10).subarray(0, 12))).toBeNull();
    expect(imageSize(jpegBytes(10, 10).subarray(0, 6))).toBeNull();
  });

  it('сегмент DHT не принимается за носителя размеров', () => {
    // DHT (0xFFC4) попадает в тот же диапазон маркеров, что и SOF, но
    // размеров не несёт. Без исключения разбор прочитал бы таблицу
    // Хаффмана как ширину и высоту — здесь это дало бы 4369×4369
    // вместо 300×300, и годный квадратный логотип отправился бы с
    // выдуманными размерами.
    expect(imageSize(jpegWithDhtBytes(300, 300))).toEqual({
      width: 300,
      height: 300,
    });
    expect(imageSize(jpegWithDhtBytes(800, 400))).toEqual({
      width: 800,
      height: 400,
    });
  });

  it('испорченная длина сегмента обрывает разбор, а не даёт случайный ответ', () => {
    // За битым сегментом в этом файле идёт вполне годный SOF0. Разбор
    // всё равно обязан вернуть null: файл, в котором длина сегмента
    // меньше самого поля длины, испорчен целиком, и «угаданные» из
    // него размеры доверия не заслуживают.
    expect(imageSize(jpegCorruptSegmentBytes(512, 512))).toBeNull();

    const corrupt = Buffer.alloc(40);
    corrupt[0] = 0xff;
    corrupt[1] = 0xd8;
    corrupt[2] = 0xff;
    corrupt[3] = 0xe0;
    corrupt.writeUInt16BE(0, 4);
    expect(imageSize(corrupt)).toBeNull();
  });
});

describe('логотип из GOOGLE_ADS_LOGO_URL', () => {
  /** Операции привязки ассетов по типу поля, из всех вызовов. */
  const linkedFieldTypes = () =>
    bodiesFor('assetGroupAssets').flatMap((b) =>
      b.operations.map(
        (o: { create: { fieldType: string } }) => o.create.fieldType,
      ),
    );

  /** Операции создания именованных ассетов (логотип, превью). */
  const namedAssetOps = () =>
    bodiesFor('assets')
      .flatMap((b) => b.operations)
      .filter((o: { create: { name?: string } }) => o.create.name);

  it('без переменной логотип не отправляется — прежнее поведение', async () => {
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    expect(linkedFieldTypes()).not.toContain('LOGO');
    expect(fetchMock).not.toHaveBeenCalledWith(LOGO_URL);
  });

  it('без переменной кампания всё равно создаётся', async () => {
    // Реклама best-effort: неполная asset group не повод терять кампанию.
    const service = new GoogleAdsService();
    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
  });

  it('квадратный логотип скачивается и уходит байтами с типом LOGO', async () => {
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    expect(fetchMock).toHaveBeenCalledWith(LOGO_URL);
    const logoOp = namedAssetOps().find(
      (o: { create: { name: string } }) => o.create.name === 'v4c-logo',
    );
    expect(logoOp.create.imageAsset.data).toBe(
      pngBytes(512, 512).toString('base64'),
    );
    expect(linkedFieldTypes()).toContain('LOGO');
  });

  it('логотип привязывается ОТДЕЛЬНЫМ вызовом — отказ по нему не уносит превью', async () => {
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    const logoLink = bodiesFor('assetGroupAssets').find((b) =>
      b.operations.some(
        (o: { create: { fieldType: string } }) => o.create.fieldType === 'LOGO',
      ),
    );
    expect(logoLink.operations).toHaveLength(1);
  });

  it('неквадратный логотип не отправляется вовсе — Google его не примет', async () => {
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === LOGO_URL
        ? Promise.resolve(imageRes(pngBytes(1200, 630)))
        : defaultRouter()(url, init),
    );
    const service = new GoogleAdsService();

    await service.createBlitzCampaign(input());
    expect(
      namedAssetOps().some(
        (o: { create: { name: string } }) => o.create.name === 'v4c-logo',
      ),
    ).toBe(false);
    expect(linkedFieldTypes()).not.toContain('LOGO');
  });

  it('формат, который парсер не понял, отправляется как есть', async () => {
    // Решать должен Google, а не наш разбор заголовков: иначе годный
    // SVG или WebP молча не доедет.
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === LOGO_URL
        ? Promise.resolve(
            imageRes(Buffer.from('<svg viewBox="0 0 1 1"></svg>')),
          )
        : defaultRouter()(url, init),
    );
    const service = new GoogleAdsService();

    await service.createBlitzCampaign(input());
    expect(linkedFieldTypes()).toContain('LOGO');
  });

  it('недоступный логотип не отменяет кампанию', async () => {
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === LOGO_URL
        ? Promise.reject(new Error('CDN 503'))
        : defaultRouter()(url, init),
    );
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
    expect(linkedFieldTypes()).not.toContain('LOGO');
  });

  it('отказ Google на загрузке логотипа не отменяет кампанию', async () => {
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === `${ADS_PREFIX}assets:mutate`) {
        const body = JSON.parse(init.body as string);
        const isLogo = body.operations.some(
          (o: { create: { name?: string } }) => o.create.name === 'v4c-logo',
        );
        if (isLogo) return Promise.resolve(textRes(400, 'image too small'));
      }
      return defaultRouter()(url, init);
    });
    const service = new GoogleAdsService();

    await expect(service.createBlitzCampaign(input())).resolves.toBe(
      'customers/1234567890/campaigns/1',
    );
    expect(linkedFieldTypes()).not.toContain('LOGO');
  });

  it('логотип загружается ОДИН раз на процесс, а не на каждую кампанию', async () => {
    // Он один на весь аккаунт: без кеша каждая кампания заводила бы в
    // кабинете ещё одну копию той же картинки.
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());
    await service.createBlitzCampaign(input({ listingId: 'l2' }));

    const logoUploads = namedAssetOps().filter(
      (o: { create: { name: string } }) => o.create.name === 'v4c-logo',
    );
    expect(logoUploads).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => u === LOGO_URL)).toHaveLength(
      1,
    );
    // Но привязывается он к КАЖДОЙ группе ассетов.
    expect(linkedFieldTypes().filter((t) => t === 'LOGO')).toHaveLength(2);
  });

  it('смена ссылки на логотип сбрасывает кеш', async () => {
    process.env.GOOGLE_ADS_LOGO_URL = LOGO_URL;
    const other = 'https://cdn.test/logo-new.png';
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === other
        ? Promise.resolve(imageRes(pngBytes(256, 256)))
        : defaultRouter()(url, init),
    );
    const service = new GoogleAdsService();
    await service.createBlitzCampaign(input());

    process.env.GOOGLE_ADS_LOGO_URL = other;
    await service.createBlitzCampaign(input({ listingId: 'l2' }));

    expect(fetchMock.mock.calls.filter(([u]) => u === LOGO_URL)).toHaveLength(
      1,
    );
    expect(fetchMock.mock.calls.filter(([u]) => u === other)).toHaveLength(1);
  });
});
