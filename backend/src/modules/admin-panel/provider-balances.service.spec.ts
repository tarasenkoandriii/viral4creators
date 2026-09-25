/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ProviderBalancesService } from './provider-balances.service';
import { XAI_MANAGEMENT_BASE } from '../../common/xai-balance';
import { AI_PROVIDERS } from '../../common/ai-pricing';

function withEnv(over: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const grok = (items: any[]) => items.find((i) => i.provider === 'GROK');

/**
 * Канал ошибок — двойник: сторож остатков (этап 143) живёт в том же
 * сервисе, а `list()` его не трогает вовсе.
 */
const notifyDouble = () =>
  ({ alert: jest.fn().mockResolvedValue(true) }) as never;

describe('ProviderBalancesService', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it('ключей нет — это «не настроено», а не ошибка, и названы обе переменные', async () => {
    // Разница существенная: «не настроено» чинится разовой настройкой,
    // «ошибка» требует разбирательства. Слить их значило бы получить
    // экран, по которому нельзя действовать.
    restore = withEnv({
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.state).toBe('not-configured');
    expect(row.detail).toContain('XAI_MANAGEMENT_KEY');
    expect(row.detail).toContain('XAI_TEAM_ID');
  });

  it('запрос уходит на management-хост, а не на api.x.ai', async () => {
    // Самая вероятная причина прошлой неудачи: тот же путь на знакомом
    // хосте генерации отвечает отказом, и выглядит это как «ключ плохой».
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: { val: '-1250' } }),
    });
    (globalThis as any).fetch = fetchMock;
    await new ProviderBalancesService(notifyDouble()).list(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(XAI_MANAGEMENT_BASE);
    expect(url).not.toContain('//api.x.ai');
    expect(url).toContain('/v1/billing/teams/t1/prepaid/balance');
    expect(init.headers.Authorization).toBe('Bearer mk');
  });

  it('журнальное сальдо превращается в остаток: центы и обратный знак', async () => {
    // Та самая строка, из-за которой экран показывал «$−1 827» при
    // остатке $18.27: `total.val` — центы предоплатного журнала, где
    // пополнение записано минусом. Сырое значение остаётся рядом,
    // чтобы расхождение с консолью читалось как расхождение, а не как
    // поломка разбора.
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: { val: '-1827' } }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.state).toBe('ok');
    expect(row.amountMicroUsd).toBe(18_270_000);
    expect(row.raw).toBe('-1827');
  });

  it('перерасход показывается отрицательным, а не прячется по модулю', async () => {
    // Положительное сальдо журнала — это долг. Взять модуль было бы
    // удобно и неверно: экран сказал бы «деньги есть».
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: { val: '340' } }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.amountMicroUsd).toBe(-3_400_000);
  });

  it('разбивка по журналу считается и подписывается под суммой', async () => {
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: { val: '-1827' },
        changes: [
          { changeOrigin: 'PURCHASE', amount: { val: '-2000' } },
          { changeOrigin: 'SPEND', amount: { val: '173' } },
        ],
      }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.changes.purchasedMicroUsd).toBe(20_000_000);
    expect(row.changes.spentMicroUsd).toBe(1_730_000);
    expect(row.changes.matchesTotal).toBe(true);
    expect(row.detail).toContain('$20.00');
    expect(row.detail).toContain('$1.73');
  });

  it('неполный журнал назван неполным, а не выдан за отчёт', async () => {
    // Провайдер ограничивает выдачу записей. Разбивка, которая не
    // сходится с остатком, без пояснения выглядит как наша ошибка в
    // арифметике — и её пойдут искать у нас.
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: { val: '-1827' },
        changes: [{ changeOrigin: 'PURCHASE', amount: { val: '-1000' } }],
      }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.changes.matchesTotal).toBe(false);
    expect(row.detail).toMatch(/неполн/);
  });

  it('разобранный остаток не тащит на экран сырой ответ со счетами', async () => {
    // В `changes` лежат номера счетов. Пока поле не было опознано,
    // тело показывалось всегда — это и был способ его опознать; теперь
    // повод исчерпан.
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: { val: '-1827' },
        changes: [
          { amount: { val: '-1827' }, invoiceNumber: '062-446-653-166' },
        ],
      }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.state).toBe('ok');
    expect(row.rawBody).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('062-446-653-166');
  });

  it.each([
    [401, /management-ключ/],
    [403, /прав/],
    [404, /team_id|постоплат/],
  ])(
    'код %s превращается в причину, а не в «не работает»',
    async (status, expected) => {
      restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
      (globalThis as any).fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status });
      const row = grok(
        await new ProviderBalancesService(notifyDouble()).list(true),
      );
      expect(row.state).toBe('error');
      expect(row.detail).toMatch(expected);
    },
  );

  it('ответ без остатка читается как постоплатный аккаунт, а не как поломка', async () => {
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ changes: [] }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.detail).toMatch(/постоплат/);
  });

  it('ключ не попадает ни в сообщение об ошибке, ни куда-либо ещё', async () => {
    restore = withEnv({
      XAI_MANAGEMENT_KEY: 'секретный-ключ',
      XAI_TEAM_ID: 't1',
    });
    (globalThis as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 401 });
    const items = await new ProviderBalancesService(notifyDouble()).list(true);
    expect(JSON.stringify(items)).not.toContain('секретный-ключ');
  });

  it('повторный вызов не дёргает чужой API — иначе сами доведём до 429', async () => {
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: { val: '-100' } }),
    });
    (globalThis as any).fetch = fetchMock;
    const svc = new ProviderBalancesService(notifyDouble());
    await svc.list(true);
    await svc.list();
    await svc.list();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('неразобранный ответ доезжает до экрана целиком', async () => {
    // Единственный оставшийся повод показывать тело: разобрать не
    // вышло. Без него следующий заход начнётся с догадок — как этот.
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        changes: [{ changeOrigin: 'SPEND', amount: { val: '13' } }],
      }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.state).toBe('error');
    expect(row.rawBody).toContain('changes');
    expect(row.rawBody).toContain('changeOrigin');
  });

  it('сырой ответ обрезается — им нельзя завалить экран', async () => {
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        changes: Array.from({ length: 2000 }, (_, i) => ({ i })),
      }),
    });
    const row = grok(
      await new ProviderBalancesService(notifyDouble()).list(true),
    );
    expect(row.rawBody!.length).toBeLessThan(4200);
    expect(row.rawBody).toContain('обрезано');
  });

  it('провайдеры без биллингового API названы поимённо, а не молчат', async () => {
    restore = withEnv({
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    const items = await new ProviderBalancesService(notifyDouble()).list(true);
    const unsupported = items.filter((i) => i.state === 'unsupported');
    expect(unsupported.length).toBeGreaterThan(5);
    for (const row of unsupported) expect(row.detail).toBeTruthy();
  });
});

describe('ссылка на консоль провайдера', () => {
  it('у GROK ссылка есть при ЛЮБОМ исходе — число может врать, дорога к первоисточнику нет', async () => {
    // Запрос владельца: остаток у GROK расходится с консолью (аккаунт на
    // постоплате — журнальное сальдо это не «остаток»), и пока это не
    // разобрано, экран обязан давать дорогу к первоисточнику.
    const before = process.env.XAI_MANAGEMENT_KEY;
    delete process.env.XAI_MANAGEMENT_KEY;
    try {
      const svc = new ProviderBalancesService(notifyDouble());
      const items = await svc.list(true);
      const grok = items.find((i) => i.provider === 'GROK');
      expect(grok?.state).toBe('not-configured');
      expect(grok?.dashboardUrl).toBe('https://console.x.ai/');
    } finally {
      if (before === undefined) delete process.env.XAI_MANAGEMENT_KEY;
      else process.env.XAI_MANAGEMENT_KEY = before;
    }
  });

  it('у провайдеров без API остатка ссылка тоже есть', async () => {
    // «Смотрите в кабинете» без адреса — половина ответа.
    const svc = new ProviderBalancesService(notifyDouble());
    const items = await svc.list(true);
    const openai = items.find((i) => i.provider === 'OPENAI');
    expect(openai?.state).toBe('unsupported');
    expect(openai?.dashboardUrl).toContain('openai.com');
  });

  it('у кого консоли не назвали — поля нет, а не пустая строка', async () => {
    const svc = new ProviderBalancesService(notifyDouble());
    const items = await svc.list(true);
    const ffmpeg = items.find((i) => i.provider === 'FFMPEG');
    expect(ffmpeg?.dashboardUrl).toBeUndefined();
  });
});

/**
 * Этап 142. Провайдеры, у которых остаток есть, но НЕ В ДЕНЬГАХ.
 * Раньше оба отвечали «остаток не в деньгах — отдельная задача».
 */
describe('ProviderBalancesService — остаток в единицах (этап 142)', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  /**
   * Отвечает по адресу: в одном прогоне спрашивают всех троих. Второй
   * параметр объявлен, хотя тело его не читает: без него `mock.calls`
   * типизируется кортежем из одного элемента, и чтение `call[1]` —
   * ошибка `tsc`, которую песочница увидит только на прогоне CI.
   */
  const routed = (by: Record<string, unknown>) =>
    jest.fn(async (url: string, _init?: RequestInit) => {
      const hit = Object.entries(by).find(([part]) => url.includes(part));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hit[1] };
    });

  const row = (items: any[], provider: string) =>
    items.find((i) => i.provider === provider);

  it('ElevenLabs отдаёт символы, а не доллары', async () => {
    restore = withEnv({ VOICE_API_KEY: 'vk', SERPAPI_API_KEY: undefined });
    const fetchMock = routed({
      'api.elevenlabs.io': {
        character_count: 40_000,
        character_limit: 100_000,
      },
    });
    (globalThis as any).fetch = fetchMock;

    const el = row(
      await new ProviderBalancesService(notifyDouble()).list(true),
      'ELEVENLABS',
    );

    expect(el.state).toBe('ok');
    expect(el.units).toEqual({
      left: 60_000,
      total: 100_000,
      label: 'символов',
    });
    // В деньги не переводим: цена символа зависит от тарифа.
    expect(el.amountMicroUsd).toBeUndefined();
    // Ключ уходит заголовком, как и у синтеза.
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('elevenlabs'),
    );
    expect(
      (call?.[1]?.headers as Record<string, string> | undefined)?.[
        'xi-api-key'
      ],
    ).toBe('vk');
  });

  it('SerpApi отдаёт поиски, и ключ уходит строкой запроса', async () => {
    // Заголовка их API не принимает — это их условие, не наш выбор.
    restore = withEnv({ SERPAPI_API_KEY: 'sk-1', VOICE_API_KEY: undefined });
    const fetchMock = routed({
      'serpapi.com': { plan_searches_left: 100, total_searches_left: 350 },
    });
    (globalThis as any).fetch = fetchMock;

    const serp = row(
      await new ProviderBalancesService(notifyDouble()).list(true),
      'SERPAPI',
    );

    expect(serp.state).toBe('ok');
    expect(serp.units).toEqual({ left: 350, label: 'поисков' });
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('serpapi'),
    );
    expect(String(call?.[0])).toContain('api_key=sk-1');
  });

  it('ключ провайдера не уезжает в сообщение об ошибке', async () => {
    // У SerpApi он стоит прямо в адресе, и `detail` попадает на экран и
    // в журнал: положить туда адрес целиком значило бы раздать ключ.
    restore = withEnv({
      SERPAPI_API_KEY: 'sk-secret',
      VOICE_API_KEY: undefined,
    });
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const serp = row(
      await new ProviderBalancesService(notifyDouble()).list(true),
      'SERPAPI',
    );

    expect(serp.state).toBe('error');
    expect(serp.detail).toContain('401');
    expect(JSON.stringify(serp)).not.toContain('sk-secret');
  });

  it('нет ключа — «не настроено» с именем переменной, а не ошибка', async () => {
    restore = withEnv({ VOICE_API_KEY: undefined, SERPAPI_API_KEY: undefined });
    const items = await new ProviderBalancesService(notifyDouble()).list(true);
    expect(row(items, 'ELEVENLABS').state).toBe('not-configured');
    expect(row(items, 'ELEVENLABS').detail).toContain('VOICE_API_KEY');
    expect(row(items, 'SERPAPI').detail).toContain('SERPAPI_API_KEY');
  });

  it('ответ пришёл, но остатка в нём нет — ошибка с объяснением', async () => {
    restore = withEnv({ VOICE_API_KEY: 'vk', SERPAPI_API_KEY: undefined });
    (globalThis as any).fetch = routed({
      'api.elevenlabs.io': { tier: 'pro' },
    });

    const el = row(
      await new ProviderBalancesService(notifyDouble()).list(true),
      'ELEVENLABS',
    );

    expect(el.state).toBe('error');
    expect(el.detail).toContain('character_limit');
  });

  it('оба больше не числятся среди «остаток не отдаёт»', async () => {
    restore = withEnv({ VOICE_API_KEY: undefined, SERPAPI_API_KEY: undefined });
    const items = await new ProviderBalancesService(notifyDouble()).list(true);
    expect(row(items, 'ELEVENLABS').state).not.toBe('unsupported');
    expect(row(items, 'SERPAPI').state).not.toBe('unsupported');
    // И строка у каждого ровно одна: список провайдеров без API остатка
    // и явные читатели не должны пересекаться.
    expect(items.filter((i: any) => i.provider === 'ELEVENLABS')).toHaveLength(
      1,
    );
    expect(items.filter((i: any) => i.provider === 'SERPAPI')).toHaveLength(1);
  });
});

/**
 * Аудит этапа 142.
 */
describe('ProviderBalancesService — после аудита этапа 142', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it('провайдеров спрашивают ПАРАЛЛЕЛЬНО, а не по очереди', async () => {
    // По очереди худший случай — три таймаута по десять секунд подряд,
    // и запрос не укладывается в таймаут функции. Ворота открываются
    // только когда пришли все три запроса: при последовательном ходе
    // первый ждал бы их вечно.
    restore = withEnv({
      XAI_MANAGEMENT_KEY: 'mk',
      XAI_TEAM_ID: 't1',
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: 'sk',
    });
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const seen: string[] = [];
    (globalThis as any).fetch = jest.fn(async (url: string) => {
      seen.push(String(url));
      if (seen.length === 3) open();
      await gate;
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const late = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('запросы пошли по очереди, а не параллельно')),
        2000,
      ).unref?.(),
    );
    await Promise.race([
      new ProviderBalancesService(notifyDouble()).list(true),
      late,
    ]);

    expect(seen).toHaveLength(3);
  });

  it('ключ не уезжает даже в сообщении сорвавшегося запроса', async () => {
    // Часть отказов `fetch` называет адрес в тексте, а у SerpApi ключ
    // стоит прямо в адресе. Проверка по списку «какие сообщения его
    // содержат» держалась бы в голове вечно.
    restore = withEnv({
      SERPAPI_API_KEY: 'sk-secret',
      VOICE_API_KEY: undefined,
    });
    (globalThis as any).fetch = jest.fn(async (url: string) => {
      throw new Error(`Failed to parse URL from ${url}`);
    });

    const items = await new ProviderBalancesService(notifyDouble()).list(true);
    const serp = items.find((i) => i.provider === 'SERPAPI');

    expect(serp?.state).toBe('error');
    expect(JSON.stringify(serp)).not.toContain('sk-secret');
    // И причина всё-таки названа: вычистили ключ, а не сообщение.
    expect(serp?.detail).toContain('Failed to parse URL');
  });

  it('на экране есть ВСЕ провайдеры, за которых мы платим', async () => {
    // Инвариант файла («список явный, чтобы забытый провайдер не
    // молчал») до этого не держался ничем: молчание про забытого
    // неотличимо от молчания про того, у кого API остатка нет.
    restore = withEnv({
      VOICE_API_KEY: undefined,
      SERPAPI_API_KEY: undefined,
      XAI_MANAGEMENT_KEY: undefined,
    });
    const items = await new ProviderBalancesService(notifyDouble()).list(true);
    const shown = items.map((i) => i.provider).sort();

    expect(shown).toEqual([...AI_PROVIDERS].sort());
    // И каждый ровно один раз: явный читатель и список «остаток не
    // отдаёт» пересекаться не должны.
    expect(new Set(shown).size).toBe(shown.length);
  });
});

/**
 * Этап 143. Сторож остатков: раз в сутки посмотреть и, если есть о чём,
 * написать в канал ошибок.
 */
describe('ProviderBalancesService.watch (этап 143)', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  const quiet = () => ({ alert: jest.fn().mockResolvedValue(true) });

  it('низкий остаток уходит в канал ошибок отдельным сообщением на провайдера', async () => {
    restore = withEnv({
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: 'sk',
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
      BALANCE_ALERT_ELEVENLABS_CHARACTERS: '20000',
      BALANCE_ALERT_SERPAPI_SEARCHES: '100',
    });
    (globalThis as any).fetch = jest.fn(async (url: string) =>
      String(url).includes('elevenlabs')
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              character_count: 99_000,
              character_limit: 100_000,
            }),
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({ total_searches_left: 5 }),
          },
    );
    const notify = quiet();

    const result = await new ProviderBalancesService(notify as never).watch();

    expect(result.low).toBe(2);
    expect(result.watched).toBe(2);
    expect(notify.alert).toHaveBeenCalledTimes(2);
    const fingerprints = notify.alert.mock.calls.map((c) => c[0]);
    expect(fingerprints).toContain('balance-low:ELEVENLABS');
    expect(fingerprints).toContain('balance-low:SERPAPI');
  });

  it('всё в порядке — в канал не уходит ничего', async () => {
    // Сторож, который пишет каждый день, перестаёт читаться.
    restore = withEnv({
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: undefined,
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ character_count: 0, character_limit: 1_000_000 }),
    }));
    const notify = quiet();

    const result = await new ProviderBalancesService(notify as never).watch();

    expect(result.low).toBe(0);
    expect(notify.alert).not.toHaveBeenCalled();
  });

  it('сторож смотрит СВЕЖИЕ числа, а не пятиминутный кеш', async () => {
    // Кеш заведён ради чужих ограничений частоты при живом человеке у
    // экрана; сторожу ходить раз в сутки, и старина ему ни к чему.
    restore = withEnv({
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: undefined,
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ character_count: 0, character_limit: 1_000_000 }),
    }));
    (globalThis as any).fetch = fetchMock;
    const svc = new ProviderBalancesService(quiet() as never);

    await svc.list();
    const afterFirst = fetchMock.mock.calls.length;
    await svc.watch();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('нечитаемый остаток тоже уходит в канал', async () => {
    restore = withEnv({
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: undefined,
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    const notify = quiet();

    const result = await new ProviderBalancesService(notify as never).watch();

    expect(result.unreadable).toBe(1);
    expect(notify.alert.mock.calls[0][0]).toBe('balance-unreadable:ELEVENLABS');
  });

  it('сообщения уходят ПАРАЛЛЕЛЬНО, а не по очереди', async () => {
    // У отправки в Telegram свой таймаут в пять секунд, и три подряд
    // ложатся поверх десяти секунд на сами остатки — снова мимо
    // таймаута функции (аудит этапа 143, та же поломка, что на 142).
    restore = withEnv({
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: 'sk',
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let started = 0;
    const notify = {
      alert: jest.fn(async () => {
        if (++started === 2) open();
        await gate;
        return true;
      }),
    };

    const late = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('сообщения пошли по очереди')),
        2000,
      ).unref?.(),
    );
    await Promise.race([
      new ProviderBalancesService(notify as never).watch(),
      late,
    ]);

    expect(started).toBe(2);
  });

  it('счётчик отправленных считает отправленные, а не поводы', async () => {
    // Канал может быть не настроен, и `alert` честно отвечает `false`.
    // Записать в историю крона «отправлено 2» было бы неправдой.
    restore = withEnv({
      VOICE_API_KEY: 'vk',
      SERPAPI_API_KEY: undefined,
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    const notify = { alert: jest.fn().mockResolvedValue(false) };

    const result = await new ProviderBalancesService(notify as never).watch();

    expect(result.unreadable).toBe(1);
    expect(result.notified).toBe(0);
  });
});
