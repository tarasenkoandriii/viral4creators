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
      json: async () => ({ total: { val: '12.5' } }),
    });
    (globalThis as any).fetch = fetchMock;
    await new ProviderBalancesService().list(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(XAI_MANAGEMENT_BASE);
    expect(url).not.toContain('//api.x.ai');
    expect(url).toContain('/v1/billing/teams/t1/prepaid/balance');
    expect(init.headers.Authorization).toBe('Bearer mk');
  });

  it('остаток разобран, и сырое значение сохранено рядом', async () => {
    // Единица в документации не объявлена. Сырое значение на экране —
    // способ узнать правду с первого живого ответа, а не показывать
    // остаток в сто раз неверным и не заметить.
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: { val: '12.5' } }),
    });
    const row = grok(await new ProviderBalancesService().list(true));
    expect(row.state).toBe('ok');
    expect(row.amountMicroUsd).toBe(12_500_000);
    expect(row.raw).toBe('12.5');
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
      json: async () => ({ total: { val: '1' } }),
    });
    (globalThis as any).fetch = fetchMock;
    const svc = new ProviderBalancesService();
    await svc.list(true);
    await svc.list();
    await svc.list();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('сырой ответ провайдера доезжает до экрана целиком', async () => {
    // Ровно то, ради чего он там: первый живой вызов вернул
    // `total.val = -1827` при остатке $5.77 в консоли. Разобранное
    // число оказалось не тем, и без остального ответа понять, какое
    // поле означает остаток человека, было нельзя.
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: { val: '-1827' },
        changes: [{ changeOrigin: 'usage', amount: { val: '-13' } }],
      }),
    });
    const row = grok(await new ProviderBalancesService().list(true));
    expect(row.rawBody).toContain('changes');
    expect(row.rawBody).toContain('changeOrigin');
  });

  it('сырой ответ обрезается — им нельзя завалить экран', async () => {
    restore = withEnv({ XAI_MANAGEMENT_KEY: 'mk', XAI_TEAM_ID: 't1' });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: { val: '1' },
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
