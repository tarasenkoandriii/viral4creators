/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Дневные лимиты визарда обучалки по сайту заказчика (§9 ТЗ, этап 111).
 *
 * Проверяется ровно то же, что и у квот SerpApi/YouTube в
 * `product-analog/usage-quota.spec.ts`, и ровно по той же причине: фраза
 * «перерасход невозможен» в комментарии верна только пока условие
 * `WHERE ... < limit` стоит ВНУТРИ единственного запроса. Убери его — и
 * ни один тест вызывающего сервиса этого не заметит, потому что там
 * счётчик подменён целиком.
 *
 * Отдельно проверяется, что раунды и live-сессии — две НЕЗАВИСИМЫЕ
 * колонки одной строки: перепутанная колонка означала бы, что десять
 * дешёвых раундов закрывают дорогой живой вход (или наоборот).
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  ClientSiteTutorialUsageService,
  DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
  DEFAULT_GLOBAL_ROUNDS_PER_DAY,
  DEFAULT_LIVE_SESSIONS_PER_DAY,
  DEFAULT_ROUNDS_PER_DAY,
  LOGIN_FAILURES_PER_WINDOW,
  LOGIN_FAILURE_WINDOW_SEC,
  LOGIN_IDENTITIES_PER_HOST,
  LOGIN_IDENTITY_DAY_PREFIX,
  LOGIN_IDENTITY_WINDOW_DAYS,
  SITE_TUTORIAL_GLOBAL_LIVE_KEY,
  SITE_TUTORIAL_GLOBAL_ROUNDS_KEY,
  SITE_TUTORIAL_PAUSED_KEY,
  VERIFY_SITE_PER_HOUR,
} from './client-site-tutorial-usage.service';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

const TABLE = 'client_site_tutorial_usage';
const NOW = new Date('2026-09-09T23:30:00Z');
const DAY = '2026-09-09';

function build(affected: number) {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(affected) };
  return {
    svc: new ClientSiteTutorialUsageService(prisma as any),
    prisma,
  };
}

function sqlOf(prisma: { $executeRaw: jest.Mock }): string {
  return (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
}

function paramsOf(prisma: { $executeRaw: jest.Mock }): unknown[] {
  return prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
}

const CASES = [
  {
    name: 'раунды',
    column: 'rounds',
    envKey: 'SITE_TUTORIAL_ROUNDS_PER_DAY',
    fallback: DEFAULT_ROUNDS_PER_DAY,
    reserve: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.reserveRound(u, now),
    release: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.releaseRound(u, now),
  },
  {
    name: 'live-сессии',
    column: 'liveSessions',
    envKey: 'SITE_TUTORIAL_LIVE_SESSIONS_PER_DAY',
    fallback: DEFAULT_LIVE_SESSIONS_PER_DAY,
    reserve: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.reserveLiveSession(u, now),
    release: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.releaseLiveSession(u, now),
  },
];

describe.each(CASES)('$name — слот занимается одним условным запросом', (c) => {
  it('слот занят → true, лимит выбран → false, без исключений', async () => {
    const ok = build(1);
    expect(await c.reserve(ok.svc, 'u1')).toBe(true);
    const full = build(0);
    expect(await c.reserve(full.svc, 'u1')).toBe(false);
  });

  it('условие по лимиту стоит В САМОМ запросе, а не читается отдельно', async () => {
    process.env[c.envKey] = '7';
    const { svc, prisma } = build(1);
    await c.reserve(svc, 'u1', NOW);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(prisma);
    expect(sql).toContain(`INSERT INTO "${TABLE}"`);
    expect(sql).toContain('ON CONFLICT ("userId", "day") DO UPDATE');
    expect(sql).toContain(`WHERE "${TABLE}"."${c.column}" < ?`);

    const params = paramsOf(prisma);
    expect(params[params.length - 1]).toBe(7);
    expect(params).toContain('u1');
    // Ключ суток — UTC-дата строкой: 23:30 UTC остаётся тем же днём, а не
    // уезжает в следующий из-за локальной таймзоны контейнера.
    expect(params).toContain(DAY);
  });

  it('увеличивается ИМЕННО своя колонка — иначе один лимит съедал бы другой', async () => {
    const { svc, prisma } = build(1);
    await c.reserve(svc, 'u1');
    const sql = sqlOf(prisma);
    expect(sql).toContain(`SET "${c.column}" = "${TABLE}"."${c.column}" + 1`);
  });

  it('без переменной берётся умолчание, а не ноль и не бесконечность', async () => {
    delete process.env[c.envKey];
    const { svc, prisma } = build(1);
    await c.reserve(svc, 'u1');
    const params = paramsOf(prisma);
    expect(params[params.length - 1]).toBe(c.fallback);
  });

  it('мусор в переменной не вырождает условие', async () => {
    // `< 0` закрыл бы визард всем, `< NaN` — не закрыл бы никому.
    for (const bad of ['0', '-5', 'abc', '', '1.5']) {
      process.env[c.envKey] = bad;
      const { svc, prisma } = build(1);
      await c.reserve(svc, 'u1');
      expect(paramsOf(prisma)[paramsOf(prisma).length - 1]).toBe(c.fallback);
    }
  });

  it('возврат слота не опускает счётчик ниже нуля', async () => {
    // Двойной release (раунд упал, а потом упала и уборка) не должен
    // дарить пользователю квоту.
    const { svc, prisma } = build(1);
    await c.release(svc, 'u1', NOW);
    const sql = sqlOf(prisma);
    expect(sql).toContain(`UPDATE "${TABLE}"`);
    expect(sql).toContain(`GREATEST("${c.column}" - 1, 0)`);
    expect(paramsOf(prisma)).toEqual(['u1', DAY]);
  });
});

describe('остаток на экране визарда', () => {
  function withRow(row: { rounds: number; liveSessions: number } | null) {
    process.env.SITE_TUTORIAL_ROUNDS_PER_DAY = '10';
    process.env.SITE_TUTORIAL_LIVE_SESSIONS_PER_DAY = '3';
    const prisma = {
      clientSiteTutorialUsage: {
        findUnique: jest.fn().mockResolvedValue(row),
      },
    };
    return {
      svc: new ClientSiteTutorialUsageService(prisma as any),
      prisma,
    };
  }

  it('строка есть — обе колонки отдаются вместе со своими лимитами', async () => {
    const { svc } = withRow({ rounds: 7, liveSessions: 1 });
    expect(await svc.snapshot('u1')).toEqual({
      rounds: 7,
      liveSessions: 1,
      roundsLimit: 10,
      liveSessionsLimit: 3,
    });
  });

  it('строки нет — нули, а не падение', async () => {
    const { svc } = withRow(null);
    expect(await svc.snapshot('u1')).toEqual({
      rounds: 0,
      liveSessions: 0,
      roundsLimit: 10,
      liveSessionsLimit: 3,
    });
  });

  it('читается строка ровно за сегодняшние UTC-сутки этого пользователя', async () => {
    const { svc, prisma } = withRow(null);
    await svc.snapshot('u1', NOW);
    expect(prisma.clientSiteTutorialUsage.findUnique).toHaveBeenCalledWith({
      where: { userId_day: { userId: 'u1', day: DAY } },
    });
  });
});

describe('захода 7, пакет B: П-Т9, П-Т6, П-Т8, частота «Это мой сайт»', () => {
  function full(
    over: {
      settings?: Record<string, string>;
      sum?: number | Error;
      exec?: number | Error;
      rows?: Array<{ count: number; windowStart: Date }> | Error;
      rateCount?: number;
    } = {},
  ) {
    const settings = over.settings ?? {};
    const prisma: any = {
      platformSetting: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.key in settings ? { value: settings[where.key] } : null,
        ),
      },
      $queryRaw: jest.fn(async (strings: string[]) => {
        const sql = strings.join('?');
        if (sql.includes('rate_limits') && sql.includes('INSERT')) {
          return [{ count: over.rateCount ?? 1 }];
        }
        if (sql.includes('rate_limits')) {
          if (over.rows instanceof Error) throw over.rows;
          return over.rows ?? [];
        }
        if (over.sum instanceof Error) throw over.sum;
        return [{ n: over.sum ?? 0 }];
      }),
      $executeRaw: jest.fn(async () => {
        if (over.exec instanceof Error) throw over.exec;
        return over.exec ?? 1;
      }),
      // П-Т6 идёт в интерактивной транзакции (советская блокировка):
      // колбэк получает тот же объект, так что вызовы видны в тех же моках.
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };
    const svc = new ClientSiteTutorialUsageService(prisma);
    // Секрет П-Т6/П-Т8 — из ключа обучалки, не из общего rate-limit.
    svc.env = { SITE_TUTORIAL_TOKEN_KEY: 'тест-ключ' };
    return { svc, prisma };
  }
  const sqlAt = (m: jest.Mock, i = 0) =>
    (m.mock.calls[i][0] as string[]).join('?');
  /** Индекс вызова `$executeRaw` с INSERT (после советской блокировки). */
  const insertCall = (m: jest.Mock) =>
    m.mock.calls.find((c: unknown[]) =>
      (c[0] as string[]).join('?').includes('INSERT INTO'),
    ) as unknown[];

  describe('П-Т9', () => {
    it('выключатель в PlatformSetting — paused, до подсчёта', async () => {
      for (const v of ['true', '1', 'ON', ' yes ']) {
        const { svc, prisma } = full({
          settings: { [SITE_TUTORIAL_PAUSED_KEY]: v },
        });
        expect(await svc.availability('round', NOW)).toBe('paused');
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      }
      for (const v of ['false', '0', '', 'нет']) {
        const { svc } = full({ settings: { [SITE_TUTORIAL_PAUSED_KEY]: v } });
        expect(await svc.availability('round', NOW)).toBe('ok');
      }
    });

    it('сумма раундов за UTC-сутки по ВСЕМ — у потолка global_limit, ниже — ok', async () => {
      const at = full({ sum: DEFAULT_GLOBAL_ROUNDS_PER_DAY });
      expect(await at.svc.availability('round', NOW)).toBe('global_limit');
      const sql = sqlAt(at.prisma.$queryRaw);
      expect(sql).toContain('SUM("rounds")');
      expect(sql).toContain(`FROM "${TABLE}" WHERE "day" = ?`);
      expect(at.prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([DAY]);
      const below = full({ sum: DEFAULT_GLOBAL_ROUNDS_PER_DAY - 1 });
      expect(await below.svc.availability('round', NOW)).toBe('ok');
    });

    it('живые сессии — своя колонка и свой потолок', async () => {
      const { svc, prisma } = full({
        sum: DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
      });
      expect(await svc.availability('live', NOW)).toBe('global_limit');
      expect(sqlAt(prisma.$queryRaw)).toContain('SUM("liveSessions")');
    });

    it('потолок: PlatformSetting важнее env, env важнее умолчания, мусор — дальше по цепочке', async () => {
      const a = full({ settings: { [SITE_TUTORIAL_GLOBAL_ROUNDS_KEY]: '7' } });
      a.svc.env.SITE_TUTORIAL_GLOBAL_ROUNDS_PER_DAY = '9';
      expect(await a.svc.globalRoundsLimit()).toBe(7);
      const b = full({ settings: { [SITE_TUTORIAL_GLOBAL_ROUNDS_KEY]: '-1' } });
      b.svc.env.SITE_TUTORIAL_GLOBAL_ROUNDS_PER_DAY = '9';
      expect(await b.svc.globalRoundsLimit()).toBe(9);
      const c = full();
      expect(await c.svc.globalRoundsLimit()).toBe(
        DEFAULT_GLOBAL_ROUNDS_PER_DAY,
      );
      const d = full({ settings: { [SITE_TUTORIAL_GLOBAL_LIVE_KEY]: '3' } });
      expect(await d.svc.globalLiveSessionsLimit()).toBe(3);
    });

    it('настройка кэшируется: второй вызов в пределах срока базу не трогает', async () => {
      const { svc, prisma } = full();
      await svc.paused();
      await svc.paused();
      expect(prisma.platformSetting.findUnique).toHaveBeenCalledTimes(1);
    });

    it('сбой подсчёта или чтения настройки — пропускаем (тормоз, а не дверь)', async () => {
      const { svc } = full({ sum: new Error('база легла') });
      expect(await svc.availability('round', NOW)).toBe('ok');
      const broken = full();
      broken.prisma.platformSetting.findUnique.mockRejectedValue(
        new Error('нет'),
      );
      expect(await broken.svc.availability('round', NOW)).toBe('ok');
    });
  });

  describe('П-Т6', () => {
    it('один условный запрос: известный логин ИЛИ счёт в окне < порога; ни хоста, ни логина открытым текстом', async () => {
      const { svc, prisma } = full({ exec: 1 });
      expect(
        await svc.reserveLoginIdentity(
          'u1',
          'Shop.Example.com',
          'Me@x.io',
          NOW,
        ),
      ).toBe(true);
      // Советская блокировка + условный INSERT — оба в транзакции.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(
        prisma.$executeRaw.mock.calls.some((c: unknown[]) =>
          (c[0] as string[]).join('?').includes('pg_advisory_xact_lock'),
        ),
      ).toBe(true);
      const ins = insertCall(prisma.$executeRaw);
      const sql = (ins[0] as string[]).join('?');
      expect(sql).toContain(`INSERT INTO "${TABLE}"`);
      expect(sql).toContain('WHERE EXISTS');
      expect(sql).toContain('"day" LIKE ?');
      expect(sql).toContain('ON CONFLICT ("userId", "day") DO UPDATE');
      const params = ins.slice(1);
      expect(params).toContain(LOGIN_IDENTITIES_PER_HOST);
      const since = new Date(
        NOW.getTime() - LOGIN_IDENTITY_WINDOW_DAYS * 86_400_000,
      );
      expect(params).toContainEqual(since);
      const flat = JSON.stringify(params).toLowerCase();
      expect(flat).not.toContain('shop.example.com');
      expect(flat).not.toContain('me@x.io');
      const { prefix, key } = svc.loginIdentityKeys(
        'shop.example.com',
        'me@x.io',
      );
      expect(key.startsWith(prefix)).toBe(true);
      expect(prefix.startsWith(LOGIN_IDENTITY_DAY_PREFIX)).toBe(true);
      expect(params).toContain(key);
      expect(params).toContain(`${prefix}%`);
    });

    it('ключ производится от SITE_TUTORIAL_TOKEN_KEY, не от общей соли rate-limit (п.4)', () => {
      const a = full();
      a.svc.env = { SITE_TUTORIAL_TOKEN_KEY: 'key-A' };
      const b = full();
      b.svc.env = { SITE_TUTORIAL_TOKEN_KEY: 'key-B' };
      // Разный секрет обучалки → разные ключи для одного и того же логина:
      // по отметкам `li:` нельзя перебрать хост/логин без секрета.
      expect(
        a.svc.loginIdentityKeys('shop.example.com', 'me@x.io').key,
      ).not.toBe(b.svc.loginIdentityKeys('shop.example.com', 'me@x.io').key);
      // Без ключа — предупреждение (не ломаем прод), но ключ всё равно HMAC.
      const noKey = full();
      noKey.svc.env = {};
      const warn = jest
        .spyOn(
          (noKey.svc as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const k = noKey.svc.loginIdentityKeys('shop.example.com', 'me@x.io');
      expect(k.key).toMatch(/^li:[0-9a-f]+:[0-9a-f]+$/);
      expect(warn).toHaveBeenCalled();
    });

    it('ключ: регистр хоста и логина не важен; разные логины — разные ключи, один префикс хоста', () => {
      const { svc } = full();
      const a = svc.loginIdentityKeys('SHOP.example.com', ' Me@X.io ');
      const b = svc.loginIdentityKeys('shop.example.com', 'me@x.io');
      const c = svc.loginIdentityKeys('shop.example.com', 'other@x.io');
      const d = svc.loginIdentityKeys('other.example.com', 'me@x.io');
      expect(a.key).toBe(b.key);
      expect(c.key).not.toBe(b.key);
      expect(c.prefix).toBe(b.prefix);
      expect(d.prefix).not.toBe(b.prefix);
    });

    it('ноль задетых строк — отказ; сбой базы — пропуск', async () => {
      expect(
        await full({ exec: 0 }).svc.reserveLoginIdentity('u1', 'h', 'l', NOW),
      ).toBe(false);
      expect(
        await full({ exec: new Error('x') }).svc.reserveLoginIdentity(
          'u1',
          'h',
          'l',
          NOW,
        ),
      ).toBe(true);
    });
  });

  describe('П-Т8', () => {
    const windowMs = LOGIN_FAILURE_WINDOW_SEC * 1000;

    it(`${LOGIN_FAILURES_PER_WINDOW} неудачи в окне — ждать до конца окна от ПЕРВОЙ неудачи`, async () => {
      const first = new Date(NOW.getTime() - 10 * 60_000);
      const { svc } = full({
        rows: [{ count: LOGIN_FAILURES_PER_WINDOW, windowStart: first }],
      });
      expect(await svc.loginRetryAfterMs('u1', 'h', NOW)).toBe(
        first.getTime() + windowMs - NOW.getTime(),
      );
    });

    it('меньше порога, окно истекло или строки нет — можно', async () => {
      const recent = new Date(NOW.getTime() - 60_000);
      expect(
        await full({
          rows: [{ count: LOGIN_FAILURES_PER_WINDOW - 1, windowStart: recent }],
        }).svc.loginRetryAfterMs('u1', 'h', NOW),
      ).toBe(0);
      expect(
        await full({
          rows: [
            {
              count: 5,
              windowStart: new Date(NOW.getTime() - windowMs),
            },
          ],
        }).svc.loginRetryAfterMs('u1', 'h', NOW),
      ).toBe(0);
      expect(await full().svc.loginRetryAfterMs('u1', 'h', NOW)).toBe(0);
      expect(
        await full({ rows: new Error('x') }).svc.loginRetryAfterMs(
          'u1',
          'h',
          NOW,
        ),
      ).toBe(0);
    });

    it('неудача: +1 внутри окна, иначе новое окно с этой минуты; ключ без id и хоста', async () => {
      const { svc, prisma } = full();
      await svc.recordLoginFailure('u1', 'shop.example.com', NOW);
      const sql = sqlAt(prisma.$executeRaw);
      expect(sql).toContain('INSERT INTO "rate_limits"');
      expect(sql).toContain('"windowStart" > ? THEN "rate_limits"."count" + 1');
      const params = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(params).toContainEqual(new Date(NOW.getTime() - windowMs));
      const key = params[0] as string;
      expect(key.startsWith('stl-login-fail|')).toBe(true);
      expect(key).not.toContain('u1');
      expect(key).not.toContain('shop');
    });

    it('удача сбрасывает счёт тем же ключом', async () => {
      const { svc, prisma } = full();
      await svc.recordLoginFailure('u1', 'h', NOW);
      await svc.clearLoginFailures('u1', 'h');
      expect(sqlAt(prisma.$executeRaw, 1)).toContain(
        'DELETE FROM "rate_limits"',
      );
      expect(prisma.$executeRaw.mock.calls[1][1]).toBe(
        prisma.$executeRaw.mock.calls[0][1],
      );
    });
  });

  describe('частота «Это мой сайт»', () => {
    it(`до ${VERIFY_SITE_PER_HOUR} в час — 0; сверх — сколько ждать`, async () => {
      expect(
        await full({ rateCount: VERIFY_SITE_PER_HOUR }).svc.hitVerifySite(
          'u1',
          NOW,
        ),
      ).toBe(0);
      const over = await full({
        rateCount: VERIFY_SITE_PER_HOUR + 1,
      }).svc.hitVerifySite('u1', NOW);
      expect(over).toBe(30 * 60_000);
    });
  });
});
