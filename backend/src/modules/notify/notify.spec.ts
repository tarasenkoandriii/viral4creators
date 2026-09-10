/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Служебные каналы (ТЗ §28, этап 45; переписаны на этапе 47).
 *
 * Три правила, без которых канал бесполезен или вреден, и каждое здесь
 * проверяется отдельно: дедупликация (иначе канал глушат в первый же
 * день), фильтр секретов (иначе Telegram становится местом их утечки) и
 * «отправка не роняет запрос» (иначе служебная функция ломает продукт).
 *
 * Четвёртое правило появилось на этапе 47: отправка ждёт ответа, а не
 * уходит в очередь, — потому что на Vercel очередь после ответа никто
 * не разбирает.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { redact, MAX_MESSAGE_LENGTH } from './redact';
import {
  TelegramNotifyService,
  DEFAULT_WINDOW_MS,
} from './telegram-notify.service';

describe('redact — что нельзя писать в канал', () => {
  it.each([
    ['Authorization: Bearer abcdef1234567890', 'abcdef1234567890'],
    ['{"api_key":"sk-abcdefghijklmnop12345"}', 'sk-abcdefghijklmnop12345'],
    ['token=BLOB_rw_secretvalue123', 'secretvalue123'],
    [
      'BLOB_READ_WRITE_TOKEN=vercel_blob_rw_ABCdef123',
      'vercel_blob_rw_ABCdef123',
    ],
    ['https://blob.test/f.mp4?token=abc123def456&x=1', 'abc123def456'],
    ['письмо от petr@example.com не дошло', 'petr@example.com'],
    // Этап 47 (В-3.3): имена переменных этого проекта. Раньше `\b`
    // перед `token` требовал границы слова, а подчёркивание — символ
    // слова: `TELEGRAM_BOT_TOKEN=…` проходил в канал целиком.
    ['TELEGRAM_BOT_TOKEN=8012345678:AAHdqTcvabcdefghij', 'AAHdqTcvabcdefghij'],
    ['GEMINI_API_KEY=AIzaSyC1234567890abcdefg', 'AIzaSyC1234567890abcdefg'],
    ['CRON_SECRET=abcdefgh12345678', 'abcdefgh12345678'],
    ['x-goog-api-key: AIzaSyC1234567890abcdefg', 'AIzaSyC1234567890abcdefg'],
    [
      'upstream said AIzaSyC1234567890abcdefgh is invalid',
      'AIzaSyC1234567890abcdefgh',
    ],
    [
      'https://g.api/v1?key=AIzaSyC1234567890abcdefg&x=1',
      'AIzaSyC1234567890abcdefg',
    ],
  ])('%s', (input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it('обычный текст не портится', () => {
    const text = 'Генерация не удалась: VEO_TIMEOUT. Сессия ses_01ABC';
    expect(redact(text)).toBe(text);
  });

  it('длинный текст обрезается и говорит об этом', () => {
    // Telegram режет на 4096, и обрезанный посередине стектрейс не
    // читается вообще — лучше честная пометка.
    const out = redact('x'.repeat(MAX_MESSAGE_LENGTH + 500));
    expect(out.length).toBeLessThan(MAX_MESSAGE_LENGTH + 30);
    expect(out.endsWith('(обрезано)')).toBe(true);
  });
});

describe('TelegramNotifyService — канал не ломает продукт', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  /** База, которая отвечает на дедупликацию заданным вердиктом. */
  function prismaWith(verdict: { send: boolean; reported: number }) {
    return {
      $queryRaw: jest.fn().mockResolvedValue([verdict]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
  }

  function configured() {
    process.env.TELEGRAM_BOT_TOKEN = 'bot:token';
    process.env.TELEGRAM_ALERTS_CHAT_ID = '-100123';
    process.env.TELEGRAM_STATS_CHAT_ID = '-100456';
  }

  it('без настроенных чатов не делает ничего и не бросает', async () => {
    delete process.env.TELEGRAM_ALERTS_CHAT_ID;
    delete process.env.TELEGRAM_STATS_CHAT_ID;
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    const prisma = prismaWith({ send: true, reported: 0 });
    const svc = new TelegramNotifyService(prisma as any);

    expect(await svc.alert('veo:timeout', 'что-то упало')).toBe(false);
    expect(await svc.stat('новый пользователь')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    // И в базу не ходит: решать нечего.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('без токена бота молчит, даже если чат задан', async () => {
    // Полконфигурации — это не «почти работает», а «не работает»:
    // отправлять некуда, и притворяться незачем.
    process.env.TELEGRAM_ALERTS_CHAT_ID = '-100123';
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    const svc = new TelegramNotifyService(
      prismaWith({ send: true, reported: 0 }) as any,
    );
    expect(await svc.alert('x', 'y')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('отправка ждёт ответа Telegram, а не уходит в очередь', async () => {
    // Смысл этапа 47: промис метода разрешается ПОСЛЕ ответа сети.
    // На Vercel всё, что не дождались, может не выполниться никогда.
    configured();
    let resolveFetch: (v: unknown) => void = () => undefined;
    jest
      .spyOn(global, 'fetch' as never)
      .mockImplementation(
        () => new Promise((r) => (resolveFetch = r)) as never,
      );
    const svc = new TelegramNotifyService(
      prismaWith({ send: true, reported: 0 }) as any,
    );
    let settled = false;
    const pending = svc.stat('отчёт').then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    resolveFetch({ ok: true });
    expect(await pending).toBe(true);
  });

  it('отказ Telegram не выходит наружу и читается как «не ушло»', async () => {
    configured();
    jest
      .spyOn(global, 'fetch' as never)
      .mockRejectedValue(new Error('сеть недоступна') as never);
    const svc = new TelegramNotifyService(
      prismaWith({ send: true, reported: 0 }) as any,
    );
    expect(await svc.alert('veo:timeout', 'упало')).toBe(false);
  });

  it('не-2xx от Telegram — тоже «не ушло», без исключения', async () => {
    configured();
    jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: false, status: 429 } as never);
    const svc = new TelegramNotifyService(
      prismaWith({ send: true, reported: 0 }) as any,
    );
    expect(await svc.report('отчёт')).toBe(false);
  });

  it('повтор той же тревоги в сеть не идёт — по вердикту базы', async () => {
    // Решение принимает база (один INSERT … ON CONFLICT), а не память
    // экземпляра: на Vercel экземпляров много, и у каждого была бы своя.
    configured();
    const fetchSpy = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: true } as never);
    const prisma = prismaWith({ send: false, reported: 0 });
    const svc = new TelegramNotifyService(prisma as any);

    expect(await svc.alert('veo:timeout', 'упало снова')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('первая тревога после окна несёт сводку «и ещё N раз»', async () => {
    configured();
    const fetchSpy = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: true } as never);
    const svc = new TelegramNotifyService(
      prismaWith({ send: true, reported: 42 }) as any,
    );
    await svc.alert('veo:timeout', 'упало');
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as { text: string };
    expect(body.text).toContain('и ещё 42 раз');
    expect(body.text).toContain(`${Math.round(DEFAULT_WINDOW_MS / 60000)} мин`);
  });

  it('решение — один запрос с ON CONFLICT и окном от переданного «сейчас»', async () => {
    configured();
    jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: true } as never);
    const prisma = prismaWith({ send: true, reported: 0 });
    const svc = new TelegramNotifyService(prisma as any);
    const before = Date.now();
    await svc.alert('veo:timeout', 'упало');
    const [parts, ...params] = prisma.$queryRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const sql = parts.join('?');
    expect(sql).toContain('ON CONFLICT ("fingerprint") DO UPDATE');
    expect(sql).toContain('RETURNING ("lastSentAt" = ?) AS "send", "reported"');
    expect(params[0]).toBe('veo:timeout');
    // Начало окна ровно на DEFAULT_WINDOW_MS раньше «сейчас».
    const now = params[1] as Date;
    const windowStart = params[2] as Date;
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime() - windowStart.getTime()).toBe(DEFAULT_WINDOW_MS);
  });

  it('база недоступна — тревога всё равно уходит', async () => {
    // Молчать об аварии из-за того, что не удалось проверить повтор, —
    // худший из исходов: недоступная база и есть авария.
    configured();
    const fetchSpy = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: true } as never);
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('база лежит')),
    };
    const svc = new TelegramNotifyService(prisma as any);
    expect(await svc.alert('db:down', 'база лежит')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('в тело запроса уходит очищенный текст', async () => {
    configured();
    const fetchSpy = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: true } as never);
    const svc = new TelegramNotifyService(
      prismaWith({ send: true, reported: 0 }) as any,
    );

    await svc.alert('key', 'ключ sk-abcdefghijklmnop12345 не подошёл');

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('-100123');
    expect(body.text).not.toContain('sk-abcdefghijklmnop12345');
  });

  it('сводка подавленных повторов — за сутки, по убыванию, числом (В-2.10)', async () => {
    // Сводка «и ещё N раз» уходит только с первой тревогой после окна;
    // если провайдер починился и тревог больше не было, оператор видел
    // одну строку. Суточный отчёт забирает хвосты из базы.
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ fingerprint: 'veo:TIMEOUT', suppressed: 41n }]),
    };
    const svc = new TelegramNotifyService(prisma as any);
    const now = new Date('2026-09-10T06:00:00Z');
    const rows = await svc.suppressedSummary(now);
    expect(rows).toEqual([{ fingerprint: 'veo:TIMEOUT', suppressed: 41 }]);
    const [parts, since] = prisma.$queryRaw.mock.calls[0] as [string[], Date];
    const sql = parts.join('?');
    expect(sql).toContain('"suppressed" > 0');
    expect(sql).toContain('ORDER BY "suppressed" DESC');
    expect(now.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('сводка при сбое базы — пустой список, не исключение', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('база лежит')),
    };
    expect(
      await new TelegramNotifyService(prisma as any).suppressedSummary(),
    ).toEqual([]);
  });

  it('уборка отпечатков не бросает при сбое базы', async () => {
    const prisma = {
      $executeRaw: jest.fn().mockRejectedValue(new Error('база лежит')),
    };
    const svc = new TelegramNotifyService(prisma as any);
    expect(await svc.pruneStates()).toBe(0);
  });
});
