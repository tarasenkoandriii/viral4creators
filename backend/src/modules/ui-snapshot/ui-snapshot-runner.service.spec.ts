/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../notify/telegram-notify.service', () => ({
  TelegramNotifyService: class {},
}));

const launchHeadlessBrowserMock = jest.fn();
jest.mock('../../common/headless-chromium', () => ({
  launchHeadlessBrowser: (...args: unknown[]) =>
    launchHeadlessBrowserMock(...args),
  withTimeout: (p: Promise<unknown>) => p,
}));

// Скриншоты в тестах — не настоящий PNG (см. buildFakePage ниже), а
// перцептивный хэш (perceptual-hash.ts) уже отдельно покрыт своими
// тестами (perceptual-hash.spec.ts) — здесь мокается, чтобы проверять
// логику сравнения/записи независимо от реального декодирования PNG.
const computeDHashMock = jest.fn();
const hasChangedMock = jest.fn();
const diffScoreMock = jest.fn();
jest.mock('./perceptual-hash', () => ({
  computeDHash: (...args: unknown[]) => computeDHashMock(...args),
  hasChanged: (...args: unknown[]) => hasChangedMock(...args),
  diffScore: (...args: unknown[]) => diffScoreMock(...args),
}));

import { UiSnapshotRunnerService } from './ui-snapshot-runner.service';

const ENV_KEYS = [
  'FIXTURE_TELEGRAM_ID',
  'FIXTURE_USER_TOKEN',
  'TMA_PUBLIC_URL',
];
const envBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) envBefore[key] = process.env[key];
  process.env.FIXTURE_TELEGRAM_ID = 'fixture-1';
  process.env.FIXTURE_USER_TOKEN = 'sekret';
  process.env.TMA_PUBLIC_URL = 'https://app.example.com';
  computeDHashMock.mockReturnValue('abc123');
  hasChangedMock.mockReturnValue(false);
  diffScoreMock.mockReturnValue(0);
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
  jest.clearAllMocks();
});

function buildFakePage() {
  return {
    setViewport: jest.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function build() {
  const notify = { alert: jest.fn().mockResolvedValue(true) };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'usr_fixture' }) },
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'proj-1' }) },
    productItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }) },
    brandManifest: {
      findFirst: jest.fn().mockResolvedValue({ id: 'manifest-1' }),
    },
    session: { findFirst: jest.fn().mockResolvedValue({ id: 'session-1' }) },
    uiSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.example.com/snap.png' }),
  };
  const service = new UiSnapshotRunnerService(
    prisma as any,
    notify as any,
    blob as any,
  );
  return { service, prisma, notify, blob };
}

describe('UiSnapshotRunnerService — пропуски (фикстура не настроена)', () => {
  it('без FIXTURE_USER_TOKEN/FIXTURE_TELEGRAM_ID — пропуск, ни одного запроса к БД', async () => {
    delete process.env.FIXTURE_USER_TOKEN;
    const { service, prisma } = build();
    const result = await service.run();
    expect(result.skipped).toBeTruthy();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('без TMA_PUBLIC_URL — пропуск', async () => {
    delete process.env.TMA_PUBLIC_URL;
    const { service, prisma } = build();
    const result = await service.run();
    expect(result.skipped).toContain('TMA_PUBLIC_URL');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('фикстурный пользователь не заведён в БД — пропуск с понятной причиной', async () => {
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await service.run();
    expect(result.skipped).toContain('не заведён');
  });
});

describe('UiSnapshotRunnerService — браузер недоступен', () => {
  it('браузер не поднялся — все 5 маршрутов помечены ошибкой одной тревогой', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const { service, notify } = build();

    const result = await service.run();

    expect(result.total).toBe(5);
    expect(result.failed).toBe(5);
    expect(result.outcomes.every((o) => o.error === 'нет памяти')).toBe(true);
    expect(notify.alert).toHaveBeenCalledTimes(1);
    expect(notify.alert).toHaveBeenCalledWith(
      'ui-snapshot-run:browser',
      expect.stringContaining('нет памяти'),
    );
  });
});

describe('UiSnapshotRunnerService — успешный обход', () => {
  it('первый снимок каждого маршрута — changed:false, comparedToUrl:null, без тревоги', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify, blob } = build();

    const result = await service.run();

    expect(result.total).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.changed).toBe(0);
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({
      'X-Fixture-Token': 'sekret',
    });
    expect(blob.uploadBuffer).toHaveBeenCalledTimes(5);
    expect(prisma.uiSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          comparedToUrl: null,
          changed: false,
          diffHash: 'abc123',
        }),
      }),
    );
    expect(notify.alert).not.toHaveBeenCalled();
  });

  it('локаль и тема ВЫСТАВЛЯЮТСЯ в браузере, а не только записываются в строку', async () => {
    // До этапа H `locale`/`theme` были ярлыками: прогон писал их в
    // `UiSnapshot` и нигде не применял, а совпадение с реальностью
    // держалось на том, что `defaultLocale` фронтенда тоже `ru`, а
    // headless-Chromium по умолчанию светлый. Ключи ниже — те же, что
    // пишет сам продукт (`frontend/src/lib/i18n.ts`, `lib/theme.ts`).
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build();

    await service.run({ locale: 'uk', theme: 'dark', routeKeys: ['projects'] });

    const initArgs = (page.evaluateOnNewDocument as jest.Mock).mock.calls.map(
      (c: unknown[]) => c.slice(1),
    );
    expect(initArgs).toContainEqual(['uk', 'dark']);
    // И то же самое попало в строку — ярлык и настройка больше не могут
    // разойтись.
    expect(prisma.uiSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ locale: 'uk', theme: 'dark' }),
      }),
    );
  });

  it('routeKeys сужает обход, total считается по переданным', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, blob } = build();

    const result = await service.run({ routeKeys: ['projects', 'manifests'] });

    expect(result.total).toBe(2);
    expect(blob.uploadBuffer).toHaveBeenCalledTimes(2);
  });

  it('unmasked: не маскирует, не пишет строку, не сравнивает — и отдаёт адрес файла', async () => {
    // Смысл флага: маркетинговому снимку кадр чужого сайта нужен
    // видимым, а крону он шум. Если бы такой снимок лёг в ту же
    // историю, он подменил бы базовый отпечаток, и следующий тик крона
    // честно закричал бы «изменилось» на собственную же картинку.
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify, blob } = build();

    const result = await service.run({
      routeKeys: ['projects'],
      unmasked: true,
      theme: 'dark',
    });

    expect(page.evaluate).not.toHaveBeenCalled();
    expect(prisma.uiSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.uiSnapshot.findFirst).not.toHaveBeenCalled();
    expect(notify.alert).not.toHaveBeenCalled();
    // Отдельный префикс: снимок «на показ» нельзя спутать с базовым ни
    // глазами в консоли хранилища, ни скриптом.
    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^qa-shots\/projects\/ru\/dark\//),
      expect.anything(),
      'image/png',
    );
    expect(result.outcomes[0].blobUrl).toBe(
      'https://blob.example.com/snap.png',
    );
  });

  it('unmasked: сбой маршрута строку тоже не пишет, но сообщить о нём обязан', async () => {
    const page = buildFakePage();
    page.goto.mockRejectedValue(new Error('таймаут навигации'));
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify } = build();

    const result = await service.run({
      routeKeys: ['projects'],
      unmasked: true,
    });

    expect(result.failed).toBe(1);
    expect(prisma.uiSnapshot.create).not.toHaveBeenCalled();
    // Прогон запускает человек и ждёт результата: молчание — худший
    // ответ из возможных.
    expect(notify.alert).toHaveBeenCalledWith(
      'ui-snapshot-run:projects:error',
      expect.stringContaining('таймаут навигации'),
    );
  });

  it('alerts:false — ни одной тревоги в канал, даже когда маршрут упал', async () => {
    // Правка аудита: ручной прогон отдаёт весь результат вызывающему
    // синхронно. Тревога в общий канал о сбое, который человек уже
    // видит перед собой, — засорение, а не забота.
    const page = buildFakePage();
    page.goto.mockRejectedValue(new Error('таймаут навигации'));
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, notify } = build();

    const result = await service.run({
      routeKeys: ['projects'],
      alerts: false,
    });

    expect(result.failed).toBe(1);
    expect(result.outcomes[0].error).toContain('таймаут навигации');
    expect(notify.alert).not.toHaveBeenCalled();
  });

  it('alerts:false — молчит и когда браузер вовсе не поднялся', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const { service, notify } = build();

    const result = await service.run({ alerts: false });

    expect(result.failed).toBe(5);
    expect(notify.alert).not.toHaveBeenCalled();
  });

  it('служебная сессия заводится ТОЛЬКО когда в прогоне есть мастер', async () => {
    // Иначе разовый снимок одного экрана оставлял бы пользователю
    // строку в `Session` ни за чем.
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build();

    // `session.findFirst` зовётся и разрешением фикстурного контекста
    // (ему нужен ГОТОВЫЙ ролик для `postprod-video`), поэтому считаем
    // не вызовы вообще, а именно запрос служебной сессии — он узнаётся
    // по метке `qaFixture`.
    const qaLookups = () =>
      (prisma.session.findFirst as jest.Mock).mock.calls.filter((c: any[]) =>
        JSON.stringify(c[0]).includes('qaFixture'),
      ).length;

    await service.run({ routeKeys: ['projects'] });
    expect(qaLookups()).toBe(0);

    (prisma.session.findFirst as jest.Mock).mockClear();
    await service.run({ routeKeys: ['generate'] });
    expect(qaLookups()).toBe(1);
  });

  it('бюджет времени кончился — сколько маршрутов отложено, видно в результате', async () => {
    // Без `deferred` обрезка была молчаливой: `total` говорил одно,
    // длина `outcomes` другое, и разбираться приходилось глазами.
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service } = build();

    // Часы прыгают за дедлайн после первого снятого маршрута.
    const realNow = Date.now.bind(Date);
    let shots = 0;
    page.screenshot.mockImplementation(async () => {
      shots += 1;
      return new Uint8Array([1]);
    });
    const spy = jest
      .spyOn(Date, 'now')
      .mockImplementation(() =>
        shots >= 1 ? realNow() + 10 * 60 * 1000 : realNow(),
      );

    const result = await service.run();

    spy.mockRestore();
    expect(result.total).toBe(5);
    expect(result.outcomes.length).toBe(1);
    expect(result.deferred).toBe(4);
  });

  it('обычный прогон deferred не выставляет вовсе', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service } = build();

    const result = await service.run();

    expect(result.deferred).toBeUndefined();
  });

  it('маскирование переменных зон вызывается ДО скриншота ([data-qa-mask])', async () => {
    const page = buildFakePage();
    const calls: string[] = [];
    page.evaluate.mockImplementation(async () => {
      calls.push('evaluate');
    });
    page.screenshot.mockImplementation(async () => {
      calls.push('screenshot');
      return new Uint8Array([1]);
    });
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service } = build();

    await service.run();

    expect(calls.slice(0, 2)).toEqual(['evaluate', 'screenshot']);
  });

  it('есть предыдущий снимок, hasChanged=false — changed:false, без тревоги', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify } = build();
    prisma.uiSnapshot.findFirst.mockResolvedValue({
      blobUrl: 'https://blob.example.com/prev.png',
      diffHash: 'prevhash',
    });
    hasChangedMock.mockReturnValue(false);

    const result = await service.run();

    expect(result.changed).toBe(0);
    expect(prisma.uiSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          comparedToUrl: 'https://blob.example.com/prev.png',
          changed: false,
        }),
      }),
    );
    expect(notify.alert).not.toHaveBeenCalled();
  });

  it('есть предыдущий снимок, hasChanged=true — changed:true, тревога с fingerprint по маршруту', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify } = build();
    prisma.uiSnapshot.findFirst.mockResolvedValue({
      blobUrl: 'https://blob.example.com/prev.png',
      diffHash: 'prevhash',
    });
    hasChangedMock.mockReturnValue(true);

    const result = await service.run();

    expect(result.changed).toBe(5);
    expect(notify.alert).toHaveBeenCalledTimes(5);
    expect(notify.alert).toHaveBeenCalledWith(
      'ui-snapshot-run:generate:changed',
      expect.stringContaining('generate'),
    );
  });

  it('маршрут postprod-video без sessionId у фикстуры — ошибка маршрута, не падает весь батч', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify } = build();
    prisma.session.findFirst.mockResolvedValue(null);

    const result = await service.run();

    expect(result.total).toBe(5);
    expect(result.failed).toBe(1);
    const failed = result.outcomes.find((o) => o.routeKey === 'postprod-video');
    expect(failed?.error).toContain('sessionId');
    expect(notify.alert).toHaveBeenCalledWith(
      'ui-snapshot-run:postprod-video:error',
      expect.stringContaining('postprod-video'),
    );
    // Остальные 4 маршрута всё равно обработаны успешно.
    expect(result.outcomes.filter((o) => !o.error)).toHaveLength(4);
  });

  it('сбой скриншота ОДНОГО маршрута пишет error, не прерывает остальные', async () => {
    let call = 0;
    const browser = {
      newPage: jest.fn().mockImplementation(async () => {
        call++;
        const page = buildFakePage();
        if (call === 1) {
          page.screenshot.mockRejectedValue(new Error('таймаут навигации'));
        }
        return page;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build();

    const result = await service.run();

    expect(result.total).toBe(5);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0].error).toContain('таймаут навигации');
    // Провалившийся маршрут всё равно пишет строку с error в БД.
    expect(prisma.uiSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.stringContaining('таймаут'),
        }),
      }),
    );
  });

  it('подкладывает служебную сессию в localStorage до загрузки SPA — мастер не создаёт новую на каждом тике', async () => {
    const { service, prisma } = build();
    const page = buildFakePage();
    launchHeadlessBrowserMock.mockResolvedValue({
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      },
    });
    prisma.session.findFirst.mockImplementation(async (args: any) =>
      args?.where?.data ? { id: 'qa-session' } : { id: 'done-session' },
    );

    await service.run();

    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith(
      expect.any(Function),
      'qa-session',
    );
    // postprod-video смотрит готовый ролик, а не служебную пустую сессию
    expect(page.goto).toHaveBeenCalledWith(
      'https://app.example.com/#/postprod/done-session',
      expect.anything(),
    );
    const contextCall = prisma.session.findFirst.mock.calls.find(
      ([a]: any[]) => !a?.where?.data,
    );
    expect(contextCall[0].where.status).toBe('video_complete');
  });

  it('служебной сессии нет — заводит одну с пометкой qaFixture', async () => {
    const { service, prisma } = build();
    const page = buildFakePage();
    launchHeadlessBrowserMock.mockResolvedValue({
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      },
    });
    prisma.session.findFirst.mockImplementation(async (args: any) =>
      args?.where?.data ? null : { id: 'done-session' },
    );
    (prisma.session as any).create = jest
      .fn()
      .mockResolvedValue({ id: 'new-qa' });

    await service.run();

    expect((prisma.session as any).create).toHaveBeenCalledTimes(1);
    expect(
      (prisma.session as any).create.mock.calls[0][0].data.data.qaFixture,
    ).toBe(true);
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith(
      expect.any(Function),
      'new-qa',
    );
  });
});
