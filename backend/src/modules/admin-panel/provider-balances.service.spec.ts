/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ProviderBalancesService } from './provider-balances.service';
import { XAI_MANAGEMENT_BASE } from '../../common/xai-balance';

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
    const row = grok(await new ProviderBalancesService().list(true));
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
    await new ProviderBalancesService().list(true);
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
    const row = grok(await new ProviderBalancesService().list(true));
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
    const row = grok(await new ProviderBalancesService().list(true));
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
    const row = grok(await new ProviderBalancesService().list(true));
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
    const row = grok(await new ProviderBalancesService().list(true));
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
    const row = grok(await new ProviderBalancesService().list(true));
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
      const row = grok(await new ProviderBalancesService().list(true));
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
    const row = grok(await new ProviderBalancesService().list(true));
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
    const items = await new ProviderBalancesService().list(true);
    expect(JSON.stringify(items)).not.toContain('секретный-ключ');
  });

  it('повторный вызов не дёргает чужой API — иначе сами доведём до 429', async () => {
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: { val: '-100' } }),
    });
    (globalThis as any).fetch = fetchMock;
    const svc = new ProviderBalancesService();
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
    const row = grok(await new ProviderBalancesService().list(true));
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
    const row = grok(await new ProviderBalancesService().list(true));
    expect(row.rawBody!.length).toBeLessThan(4200);
    expect(row.rawBody).toContain('обрезано');
  });

  it('провайдеры без биллингового API названы поимённо, а не молчат', async () => {
    restore = withEnv({
      XAI_MANAGEMENT_KEY: undefined,
      XAI_TEAM_ID: undefined,
    });
    const items = await new ProviderBalancesService().list(true);
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
      const svc = new ProviderBalancesService();
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
    const svc = new ProviderBalancesService();
    const items = await svc.list(true);
    const openai = items.find((i) => i.provider === 'OPENAI');
    expect(openai?.state).toBe('unsupported');
    expect(openai?.dashboardUrl).toContain('openai.com');
  });

  it('у кого консоли не назвали — поля нет, а не пустая строка', async () => {
    const svc = new ProviderBalancesService();
    const items = await svc.list(true);
    const ffmpeg = items.find((i) => i.provider === 'FFMPEG');
    expect(ffmpeg?.dashboardUrl).toBeUndefined();
  });
});
