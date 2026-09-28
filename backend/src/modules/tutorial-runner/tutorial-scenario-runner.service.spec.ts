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

import { TutorialScenarioRunnerService } from './tutorial-scenario-runner.service';
import * as assembly from './tutorial-video-assembly';

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
});
const fetchBefore = global.fetch;
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
  // Было `clearAllMocks`: он стирает ВЫЗОВЫ, но не реализации, и
  // подмена, выставленная одним тестом, продолжала действовать во
  // всех следующих. Эта мина уже выстрелила на этапе A (спай на
  // `planSlideshow` уронил чужой тест), поэтому чиним причину, а не
  // очередное следствие. Нужны все три строки, они про разное:
  // `restoreAllMocks` возвращает настоящие реализации объектам,
  // подменённым через `jest.spyOn`; `resetAllMocks` сбрасывает
  // реализации у самостоятельных `jest.fn()` (их `restoreAllMocks`
  // не трогает — восстанавливать нечего); `global.fetch` тесты
  // присваивают напрямую, и о нём не знает ни то, ни другое.
  jest.restoreAllMocks();
  jest.resetAllMocks();
  global.fetch = fetchBefore;
});

const SCENARIO_OK = {
  id: 'ts-1',
  subjectKey: '1',
  locale: 'ru',
  steps: [{ kind: 'goto', route: 'generate' }],
};
const SCENARIO_FAIL = {
  id: 'ts-2',
  subjectKey: '2',
  locale: 'ru',
  steps: [{ kind: 'click', selector: '[data-testid="missing"]' }],
};

function buildFakePage(
  opts: { failClick?: boolean; screenshot?: boolean } = {},
) {
  const locator = {
    click: opts.failClick
      ? jest.fn().mockRejectedValue(new Error('элемент не найден'))
      : jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
  };
  return {
    setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    // Локаль интерфейса выставляется до загрузки SPA (этап C).
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockReturnValue(locator),
    $eval: jest.fn().mockResolvedValue('ok'),
    close: jest.fn().mockResolvedValue(undefined),
    ...(opts.screenshot
      ? { screenshot: jest.fn().mockResolvedValue(new Uint8Array([1])) }
      : {}),
  };
}

function build(scenarios: unknown[]) {
  const notify = { alert: jest.fn().mockResolvedValue(true) };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'usr_fixture' }) },
    tutorialScenario: {
      findMany: jest.fn().mockResolvedValue(scenarios),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue(undefined),
    },
    tutorialVideoAsset: {
      findMany: jest.fn().mockResolvedValue([]),
      // Строка заводится ПЕРВОЙ и отдаёт `id`: по нему строится
      // префикс кадров (правка аудита 27.09.2026).
      create: jest.fn().mockResolvedValue({ id: 'tva-new' }),
      // Предпроверка отпечатка входов (§7.2 ТЗ): «последний
      // собранный ролик этой пары». По умолчанию его нет — обычный
      // первый прогон, сборка нужна.
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      // Подметальщик устаревших роликов (`sweepOldAssets`).
      delete: jest.fn().mockResolvedValue(undefined),
    },
    // Заявки публикации: их ролики подметальщик не трогает — файл у
    // заявки не свой, а этот самый.
    publicationRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      // Точечная перепроверка прямо перед удалением: пакетный
      // вопрос выше задан один раз на всю партию.
      count: jest.fn().mockResolvedValue(0),
    },
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'proj-1' }) },
    productItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }) },
    brandManifest: { findFirst: jest.fn().mockResolvedValue(null) },
    session: { findFirst: jest.fn().mockResolvedValue(null) },
    // Откат черновика обучалки при провале сборки (аудит 27.09.2026).
    clientSiteTutorialDraft: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Замок опроса сборок живёт внутри `pollAssemblies()` (правка
    // аудита 27.09.2026): его берёт и суточный прогон тоже.
    cronJobLock: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.example.com/frame.jpg' }),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
    // Кеш озвучки по умолчанию ПУСТ: `head` не бросает, а отдаёт
    // `null`, когда файла нет.
    head: jest.fn().mockResolvedValue(null),
    // Попадание в кеш читается листингом слота: имя файла несёт
    // длину дорожки, и знать его заранее спрашивающий не может.
    getPublicUrl: jest
      .fn()
      .mockImplementation(async (p: string) => `https://blob.example.com/${p}`),
    downloadBuffer: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
    // Уборка кадров идёт по префиксу, а не по счётчику.
    listByPrefix: jest.fn().mockResolvedValue({ blobs: [], cursor: null }),
    deleteMany: jest.fn().mockResolvedValue(undefined),
  };
  const ffmpeg = {
    // По умолчанию не настроен — большинство тестов о regression-
    // прогоне, не о сборке видео, и не должны требовать ffmpeg-моков.
    configured: jest.fn().mockReturnValue(false),
    submit: jest.fn(),
    status: jest.fn(),
  };
  // Озвучка (этап B). По умолчанию настройка ВЫКЛЮЧЕНА — как в
  // проде: большинство тестов о прогоне и о сборке, а не о голосе, и
  // они не должны требовать TTS-моков.
  const settings = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const ttsProvider = {
    providerKey: 'elevenlabs',
    configured: jest.fn().mockReturnValue(true),
    synthesize: jest.fn().mockResolvedValue({
      ok: true,
      audio: Buffer.from([1, 2, 3]),
      mimeType: 'audio/mpeg',
      characters: 42,
      durationSeconds: 9,
      voiceId: 'v',
      model: 'm',
    }),
    voices: jest.fn(),
  };
  const tts = { resolve: jest.fn().mockResolvedValue(ttsProvider) };
  const aiUsage = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new TutorialScenarioRunnerService(
    prisma as any,
    notify as any,
    blob as any,
    ffmpeg as any,
    settings as any,
    tts as any,
    aiUsage as any,
  );
  return {
    service,
    prisma,
    notify,
    blob,
    ffmpeg,
    settings,
    tts,
    ttsProvider,
    aiUsage,
  };
}

/**
 * Подменяет строки активов так, как их видит КАЖДЫЙ запрос сервиса, а
 * не один.
 *
 * `findMany` зовут два разных места с разным `where`: опрос сборок
 * (`assemblyStatus: 'pending'`) и подметание зависших
 * (`'preparing'`). Плоский `mockResolvedValue` отдавал одни и те же
 * строки обоим, и подметальщик сносил чужие, ещё живые сборки —
 * тест падал не своей причиной (найдено при реализации правки аудита
 * этапа B). Двойник обязан различать запросы так же, как их
 * различает база.
 */
function stubAssets(
  prisma: { tutorialVideoAsset: { findMany: jest.Mock } },
  rows: Record<string, unknown>[],
) {
  prisma.tutorialVideoAsset.findMany.mockImplementation(
    async (args: {
      where?: {
        assemblyStatus?: string | { in?: string[] };
        createdAt?: { lt?: Date };
        clientSiteDraftId?: string | null;
      };
      take?: number;
    }) => {
      const matched = rows.filter((r) => {
        const status = (r.assemblyStatus ?? 'pending') as string;
        // Две формы условия по статусу: `preparing` спрашивают
        // равенством, подметальщик — через `in`. Двойник обязан
        // понимать обе, иначе выборка подметальщика возвращает
        // пустоту при любом наборе строк, и его тесты проверяют
        // ничего.
        const want = args?.where?.assemblyStatus;
        if (typeof want === 'string') {
          if (status !== want) return false;
        } else if (want && Array.isArray(want.in)) {
          if (!want.in.includes(status)) return false;
        } else if (want !== undefined) {
          return false;
        }
        // Фильтр «только штатная обучалка»: `clientSiteDraftId: null`
        // в Prisma — это IS NULL, а не «поле не задано».
        if (args?.where?.clientSiteDraftId === null) {
          if ((r.clientSiteDraftId ?? null) !== null) return false;
        }
        // Выдержку двойник обязан соблюдать: без неё «свежую строку
        // не трогаем» проверить нечем — двойник отдавал бы её так же,
        // как просроченную, и тест прошёл бы при снятой выдержке.
        const before = args?.where?.createdAt?.lt;
        if (!before) return true;
        return (r.createdAt as Date | undefined) !== undefined
          ? (r.createdAt as Date) < before
          : true;
      });
      // `take` двойник тоже соблюдает: потолок просмотра — часть
      // поведения подметальщика, а не украшение запроса.
      return args?.take === undefined ? matched : matched.slice(0, args.take);
    },
  );
}

describe('TutorialScenarioRunnerService', () => {
  it('без FIXTURE_USER_TOKEN/FIXTURE_TELEGRAM_ID — пропуск, ни одного запроса к БД', async () => {
    delete process.env.FIXTURE_USER_TOKEN;
    const { service, prisma } = build([]);
    const result = await service.run();
    expect(result.skipped).toBeTruthy();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('фикстурный пользователь не заведён в БД — пропуск с понятной причиной', async () => {
    const { service, prisma } = build([]);
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await service.run();
    expect(result.skipped).toContain('не заведён');
  });

  it('нет сценариев, подходящих под фильтр (бесплатные или одобренные) — total:0', async () => {
    const { service } = build([]);
    const result = await service.run();
    expect(result).toEqual({ total: 0, passed: 0, failed: 0, outcomes: [] });
  });

  it('браузер не поднялся — все сценарии помечены failed одним UPDATE, одна тревога', async () => {
    launchHeadlessBrowserMock.mockResolvedValue({ error: 'нет памяти' });
    const { service, prisma, notify } = build([SCENARIO_OK, SCENARIO_FAIL]);

    const result = await service.run();

    expect(result.failed).toBe(2);
    expect(prisma.tutorialScenario.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastRunStatus: 'failed' }),
      }),
    );
    expect(notify.alert).toHaveBeenCalledTimes(1);
    expect(notify.alert).toHaveBeenCalledWith(
      'tutorial-scenario-run:browser',
      expect.stringContaining('нет памяти'),
    );
    // Локаль обязана быть и здесь — это ветка, где не исполнился НИ
    // ОДИН сценарий, и без языка пять локалей в журнале крона
    // сливаются в неразличимые строки. Песочный `tsc` пропускал её
    // потерю (типы Prisma подменены заглушкой), боевая сборка — нет
    // (находка сквозного аудита A+B+C).
    expect(result.outcomes).toEqual([
      expect.objectContaining({ subjectKey: '1', locale: 'ru', ok: false }),
      expect.objectContaining({ subjectKey: '2', locale: 'ru', ok: false }),
    ]);
  });

  it('успешный сценарий пишет lastRunStatus:ok и не шлёт тревогу', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify } = build([SCENARIO_OK]);

    const result = await service.run();

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({
      'X-Fixture-Token': 'sekret',
    });
    expect(prisma.tutorialScenario.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ts-1' },
        data: expect.objectContaining({
          lastRunStatus: 'ok',
          lastRunError: null,
        }),
      }),
    );
    expect(notify.alert).not.toHaveBeenCalled();
  });

  it('локаль интерфейса выставляется ДО загрузки SPA (этап C)', async () => {
    // Без этого локаль-параметр выглядела бы работающей и не
    // работала: сценарий сгенерировался бы по-испански, прогон
    // прошёл бы по селекторам (они одинаковы во всех языках) и упал
    // бы на первом `assertText` — с виду непонятно почему.
    const page = buildFakePage();
    launchHeadlessBrowserMock.mockResolvedValue({
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      },
    });
    const { service, settings } = build([{ ...SCENARIO_OK, locale: 'es' }]);
    // Испанский должен быть в списке локалей, иначе исполнитель
    // законно его не возьмёт (правка аудита этапа C).
    settings.get.mockResolvedValue('["ru","es"]');

    await service.run();

    // Колбэк ИСПОЛНЯЕТСЯ на поддельном хранилище, а не только
    // проверяются его аргументы: проверка аргументов пропускала
    // опечатку в самом имени ключа (`v4c_lang` вместо `v4c_locale`)
    // — мутация выживала, а это ровно тот тихий отказ, против
    // которого этап C и написан (находка его аудита).
    const stored: Record<string, string> = {};
    const g = globalThis as unknown as { window?: unknown };
    const windowBefore = g.window;
    g.window = {
      localStorage: {
        setItem: (k: string, v: string) => {
          stored[k] = v;
        },
      },
    };
    try {
      for (const call of page.evaluateOnNewDocument.mock.calls) {
        const [fn, ...args] = call as [(...a: unknown[]) => void, ...unknown[]];
        fn(...args);
      }
    } finally {
      if (windowBefore === undefined) delete g.window;
      else g.window = windowBefore;
    }
    // Тема задана ЯВНО: кадр не должен зависеть от системной темы
    // машины, где случился прогон.
    expect(stored).toEqual({ v4c_locale: 'es', v4c_theme: 'light' });
  });

  it('локали вне tutorial.scenarioLocales не исполняются (пятый уровень отката)', async () => {
    // Сузили список — испанские сценарии остаются в базе, но новых
    // роликов по ним не снимается и алертов по ним не шлётся. Без
    // фильтра откат, объявленный «без деплоя», не останавливал
    // ничего (находка аудита этапа C).
    const { service, prisma, settings } = build([]);
    settings.get.mockResolvedValue('["ru"]');

    await service.run();

    expect(prisma.tutorialScenario.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ locale: { in: ['ru'] } }),
      }),
    );
  });

  it('первыми идут сценарии, которые дольше всех не исполнялись', async () => {
    // По `createdAt asc` порядок был стабилен навсегда: при пяти
    // локалях пятьдесят строк против потолка в тридцать означали,
    // что двадцать не исполнятся НИКОГДА (находка аудита этапа C).
    const { service, prisma } = build([]);

    await service.run();

    expect(prisma.tutorialScenario.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { lastRunAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
      }),
    );
  });

  it('локаль выставляется РАНЬШЕ, чем открывается страница', async () => {
    // `evaluateOnNewDocument` после `goto` не подействует на уже
    // загруженный документ — порядок здесь и есть вся суть.
    const order: string[] = [];
    const page = buildFakePage();
    page.evaluateOnNewDocument.mockImplementation(async () => {
      order.push('locale');
    });
    page.goto.mockImplementation(async () => {
      order.push('goto');
    });
    launchHeadlessBrowserMock.mockResolvedValue({
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      },
    });
    const { service } = build([SCENARIO_OK]);

    await service.run();

    expect(order[0]).toBe('locale');
    expect(order).toContain('goto');
  });

  it('провалившийся шаг пишет lastRunStatus:failed с описанием шага и шлёт тревогу по fingerprint сценария', async () => {
    const page = buildFakePage({ failClick: true });
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma, notify } = build([SCENARIO_FAIL]);

    const result = await service.run();

    expect(result.failed).toBe(1);
    expect(prisma.tutorialScenario.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ts-2' },
        data: expect.objectContaining({ lastRunStatus: 'failed' }),
      }),
    );
    expect(notify.alert).toHaveBeenCalledWith(
      // Локаль в fingerprint: без неё пять локалей схлопывались в
      // одно сообщение (окно дедупликации 10 минут против прогона в
      // 4) — находка аудита этапа C.
      'tutorial-scenario-run:2:ru',
      expect.stringContaining('провалился'),
    );
  });

  it('массовый провал — три поимённых сообщения и одно итоговое', async () => {
    // При пяти локалях и общей причине (упал стенд, сломался
    // фикстурный вход) оператор получал до тридцати одинаковых
    // красных сообщений за ночь (находка сквозного аудита A+B+C).
    const page = buildFakePage({ failClick: true });
    launchHeadlessBrowserMock.mockResolvedValue({
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      },
    });
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...SCENARIO_FAIL,
      id: `ts-${i}`,
      subjectKey: String(i + 1),
    }));
    const { service, notify } = build(many);

    const result = await service.run();

    expect(result.failed).toBe(6);
    const fingerprints = notify.alert.mock.calls.map(([f]: [string]) => f);
    expect(
      fingerprints.filter((f) => f !== 'tutorial-scenario-run:many'),
    ).toHaveLength(3);
    expect(fingerprints).toContain('tutorial-scenario-run:many');
    // В итоговом перечислены ВСЕ, включая те, о которых поимённо не
    // писали: иначе они исчезли бы совсем.
    const summary = notify.alert.mock.calls.find(
      ([f]: [string]) => f === 'tutorial-scenario-run:many',
    );
    expect(summary![1]).toContain('6/ru');
  });

  it('единичный провал приходит поимённо, без итогового', async () => {
    const page = buildFakePage({ failClick: true });
    launchHeadlessBrowserMock.mockResolvedValue({
      browser: {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      },
    });
    const { service, notify } = build([SCENARIO_FAIL]);

    await service.run();

    expect(notify.alert).toHaveBeenCalledTimes(1);
    expect(notify.alert.mock.calls[0][0]).not.toBe(
      'tutorial-scenario-run:many',
    );
  });

  it('goto на маршрут без фикстурных данных проваливает сценарий с понятной причиной, а не падает молча', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build([
      {
        id: 'ts-3',
        subjectKey: '3',
        steps: [{ kind: 'goto', route: 'manifest' }],
      },
    ]);
    // manifest не заведён у фикстуры в этом тесте (brandManifest.findFirst → null)

    const result = await service.run();

    expect(result.failed).toBe(1);
    expect(prisma.tutorialScenario.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastRunError: expect.stringContaining('manifestId'),
        }),
      }),
    );
  });

  it('проект обучалки и рекламный проект — РАЗНЫЕ строки, а не «самая свежая»', async () => {
    // Этап G ТЗ `docs-tz/TZ-Enterprise-Tutorial-Landing.md`. До него
    // контекст брал «самый свежий проект пользователя» без типа. Как
    // только фикстура завела второй проект (`CLIENT_SITE`), он стал
    // самым свежим — и рекламные маршруты начали бы строить путь к
    // товару внутри проекта, у которого товаров нет по построению.
    //
    // Мок отвечает ПО ТИПУ в `where`: если фильтр убрать, обе ветки
    // получат одну и ту же строку, и оба ожидания ниже упадут.
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build([
      {
        id: 'ts-cs',
        subjectKey: 'cs',
        steps: [
          { kind: 'goto', route: 'project' },
          { kind: 'goto', route: 'site-tutorial' },
        ],
      },
    ]);
    prisma.project.findFirst = jest.fn().mockImplementation((args: any) => {
      const type = args?.where?.type;
      if (type === 'CLIENT_SITE') return Promise.resolve({ id: 'proj-cs' });
      if (type?.in) return Promise.resolve({ id: 'proj-ad' });
      // Запрос без фильтра по типу — та самая прежняя форма. Возвращаем
      // заведомо негодный id, чтобы тест упал громко, а не «почти
      // прошёл».
      return Promise.resolve({ id: 'proj-UNFILTERED' });
    });

    const result = await service.run();

    expect(result.failed).toBe(0);
    const urls = (page.goto as jest.Mock).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(urls.some((u) => u.endsWith('#/projects/proj-ad'))).toBe(true);
    expect(
      urls.some((u) => u.endsWith('#/projects/proj-cs/site-tutorial')),
    ).toBe(true);
    expect(urls.some((u) => u.includes('proj-UNFILTERED'))).toBe(false);
  });

  describe('видео (этап 98) — сборка слайд-шоу через внешний ffmpeg-api', () => {
    it('FFMPEG_API_KEY не настроен — успешный сценарий не пытается грузить кадры/сабмитить сборку', async () => {
      const page = buildFakePage({ screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, blob, ffmpeg } = build([SCENARIO_OK]);
      ffmpeg.configured.mockReturnValue(false);

      const result = await service.run();

      expect(result.passed).toBe(1);
      expect(blob.uploadBuffer).not.toHaveBeenCalled();
      expect(ffmpeg.submit).not.toHaveBeenCalled();
    });

    it('успешный сценарий с кадрами и настроенным ffmpeg — грузит кадры, сабмитит сборку, создаёт TutorialVideoAsset pending', async () => {
      const page = buildFakePage({ screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, prisma, blob, ffmpeg } = build([SCENARIO_OK]);
      ffmpeg.configured.mockReturnValue(true);
      ffmpeg.submit.mockResolvedValue({ jobId: 'job-1', status: 'queued' });

      const result = await service.run();

      expect(result.passed).toBe(1);
      expect(blob.uploadBuffer).toHaveBeenCalledWith(
        // Префикс по id АКТИВА, а не по scenarioId: иначе повторный
        // прогон затирал кадры предыдущего (аудит 27.09.2026).
        'tutorial-video-frames/tva-new/0.png',
        expect.any(Buffer),
        // Puppeteer без аргументов снимает PNG. Раньше кадры звались
        // .jpg с image/jpeg: ffmpeg разбирался по содержимому, а Blob
        // отдавал неверный content-type (находка аудита 27.09.2026).
        'image/png',
      );
      expect(ffmpeg.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: { frame0: 'https://blob.example.com/frame.jpg' },
        }),
      );
      expect(prisma.tutorialVideoAsset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subjectKey: '1',
            locale: 'ru',
            title: expect.any(String),
            scenarioId: 'ts-1',
            frameCount: 1,
            // Строка заводится ДО заливки кадров и потому ещё не
            // `pending`: опрос выбирает только `pending` и
            // полусобранную строку не тронет.
            assemblyStatus: 'preparing',
          }),
        }),
      );
    });

    it('пропавший кадр не сдвигает нумерацию остальных (этап A)', async () => {
      // Скриншот снимается best-effort и может пропасть молча. По
      // позиции в массиве уцелевший кадр второго шага залился бы как
      // `0.png` — и на этапе B реплика второго шага легла бы на
      // первый экран. Номер шага не сдвигается никогда; дыра в
      // нумерации честнее.
      const page = buildFakePage({ screenshot: true });
      page.screenshot!.mockRejectedValueOnce(new Error('CDP занят'));
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, blob, ffmpeg } = build([
        {
          ...SCENARIO_OK,
          steps: [
            { kind: 'goto', route: 'generate' },
            { kind: 'goto', route: 'generate' },
          ],
        },
      ]);
      ffmpeg.configured.mockReturnValue(true);
      ffmpeg.submit.mockResolvedValue({ jobId: 'job-1', status: 'queued' });

      await service.run();

      const frameNames = blob.uploadBuffer.mock.calls
        .map(([pathname]: [string]) => pathname)
        .filter((n: string) => n.startsWith('tutorial-video-frames/'));
      expect(frameNames).toEqual(['tutorial-video-frames/tva-new/1.png']);
      // И, главное, номер доезжает до ПЛАНА, а не теряется на
      // границе (правка аудита этапа A): ключ входа ffmpeg — `frame1`,
      // не `frame0`. На этапе B по этому же номеру к кадру
      // привяжется реплика, и привязывать её больше не к чему.
      expect(ffmpeg.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: { frame1: 'https://blob.example.com/frame.jpg' },
        }),
      );
    });

    describe('озвучка (этап B)', () => {
      /** Список операций, за которые записали расход, в порядке
       *  записи. Именно список, а не «звали/не звали»: с тех пор как
       *  сборка ffmpeg тоже платная, `not.toHaveBeenCalled()` больше
       *  не отвечает на вопрос «заплатили ли за синтез». */
      function operationsRecorded(aiUsage: { record: jest.Mock }): string[] {
        return aiUsage.record.mock.calls.map(
          (call: [{ operation: string }]) => call[0].operation,
        );
      }

      function voicedRun(over: { setting?: string | null } = {}) {
        const page = buildFakePage({ screenshot: true });
        const browser = {
          newPage: jest.fn().mockResolvedValue(page),
          close: jest.fn().mockResolvedValue(undefined),
        };
        launchHeadlessBrowserMock.mockResolvedValue({ browser });
        const built = build([SCENARIO_OK]);
        built.ffmpeg.configured.mockReturnValue(true);
        built.ffmpeg.submit.mockResolvedValue({
          jobId: 'job-1',
          status: 'queued',
        });
        // `'setting' in over`, а не `?? 'on'`: значение `null` —
        // это «настройки нет», самый важный случай, и `??` подменял
        // бы его умолчанием «включено».
        built.settings.get.mockResolvedValue(
          'setting' in over ? over.setting : 'on',
        );
        return built;
      }

      it('настройка выключена — синтеза нет вовсе, ролик немой', async () => {
        // Ночной крон идёт по всем сценариям; включаться озвучка
        // обязана решением человека, а не фактом деплоя.
        const { service, ffmpeg, tts } = voicedRun({ setting: null });

        await service.run();

        expect(tts.resolve).not.toHaveBeenCalled();
        const submitted = ffmpeg.submit.mock.calls[0][0];
        expect(Object.keys(submitted.inputs)).not.toContain('voiceover');
        expect(submitted.commands[0]).not.toContain('-c:a');
      });

      it('включена — mp3 ложится в кеш и попадает в план', async () => {
        // В кеш, а не под префикс актива: дорожка обязана пережить
        // сборку, иначе следующей ночью за неё заплатят заново.
        const { service, blob, ffmpeg, ttsProvider } = voicedRun();

        await service.run();

        expect(ttsProvider.synthesize).toHaveBeenCalledWith(
          expect.objectContaining({ language: 'ru', voiceId: null }),
        );
        expect(blob.uploadBuffer).toHaveBeenCalledWith(
          // Слот `all` — вариант А, одна дорожка на весь ролик.
          // Уровень слота появился этапом D: с покадровыми репликами
          // файлов под сценарием до тридцати, и промах по одной не
          // должен сносить остальные двадцать девять.
          expect.stringMatching(
            // Хвост `-9000` — длина дорожки в миллисекундах: попадание
            // в кеш читает её из имени, а не скачивает файл.
            /^tutorial-voiceovers\/ru\/1\/all\/[0-9a-f]{16}-9000\.mp3$/,
          ),
          expect.any(Buffer),
          'audio/mpeg',
        );
        const submitted = ffmpeg.submit.mock.calls[0][0];
        expect(submitted.inputs.voiceover).toBeDefined();
        expect(submitted.commands[0]).toContain('-map "[outa]"');
      });

      it('расход за озвучку — НА ФИКСТУРУ, а не в общий анонимный потолок', async () => {
        // Строка без владельца считается анонимной (`anonymous:
        // userId === null` в `AiUsageService.record`) и выбирает
        // ОБЩИЙ суточный потолок анонимных посетителей (≈$5). Один
        // ночной прогон озвучки его и выбирал — то есть закрывал
        // мастер настоящим гостям до полуночи (находка сквозного
        // аудита A+B+C).
        const { service, aiUsage } = voicedRun();

        await service.run();

        expect(aiUsage.record).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'voiceover',
            userId: 'usr_fixture',
          }),
        );
      });

      it('за сборку ffmpeg тоже платят — и запись есть, с владельцем', async () => {
        // До сквозного аудита A+B+C расход за сборку не писался
        // ВООБЩЕ: при пяти локалях это до тридцати неучтённых
        // платных вызовов за ночь, каждую ночь.
        const { service, aiUsage } = voicedRun();

        await service.run();

        expect(aiUsage.record).toHaveBeenCalledWith({
          operation: 'tutorial-video-assembly',
          model: 'ffmpeg-api',
          userId: 'usr_fixture',
        });
      });

      it('сборка не отправлена — за неё и не платят', async () => {
        // Запись идёт ПОСЛЕ `submit`, а не до: иначе отказ ffmpeg
        // оставлял бы в отчёте расход, которого не было.
        const { service, ffmpeg, aiUsage } = voicedRun();
        ffmpeg.submit.mockRejectedValue(new Error('ffmpeg-api недоступен'));

        await service.run();

        expect(operationsRecorded(aiUsage)).not.toContain(
          'tutorial-video-assembly',
        );
      });

      it('ничего не изменилось с прошлой ночи — сборку не заказываем', async () => {
        // §7.2 ТЗ: «ролики пересобираются, когда меняется интерфейс
        // или текст шага, а не по расписанию». Ночной прогон идёт по
        // всем сценариям КАЖДУЮ ночь, и без этой проверки он платил
        // ffmpeg за побайтово тот же mp4, а подметальщик той же
        // ночью выносил вчерашний (находка повторного сквозного
        // аудита A+B+C).
        const { service, prisma, ffmpeg, blob, aiUsage } = voicedRun();
        // Первая ночь: узнаём отпечаток, который посчитал прогон.
        await service.run();
        const hash = prisma.tutorialVideoAsset.create.mock.calls[0][0].data
          .contentHash as string;
        expect(hash).toEqual(expect.any(String));

        // Вторая ночь: те же кадры, та же дорожка, тот же отпечаток.
        const second = voicedRun();
        second.prisma.tutorialVideoAsset.findFirst.mockResolvedValue({
          id: 'tva-yesterday',
          contentHash: hash,
        });

        await second.service.run();

        expect(second.ffmpeg.submit).not.toHaveBeenCalled();
        expect(second.prisma.tutorialVideoAsset.create).not.toHaveBeenCalled();
        expect(operationsRecorded(second.aiUsage)).not.toContain(
          'tutorial-video-assembly',
        );
        // И кадры в Blob не уехали: платим не только ffmpeg.
        expect(
          second.blob.uploadBuffer.mock.calls.filter((c: string[]) =>
            c[0].startsWith('tutorial-video-frames/'),
          ),
        ).toHaveLength(0);
        // Первая ночь при этом собирала — иначе тест прошёл бы и на
        // сломанной съёмке.
        expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
        expect(blob.uploadBuffer).toHaveBeenCalled();
        expect(operationsRecorded(aiUsage)).toContain(
          'tutorial-video-assembly',
        );
      });

      it('отпечаток другой — собираем, как обычно', async () => {
        const { service, ffmpeg, prisma } = voicedRun();
        prisma.tutorialVideoAsset.findFirst.mockResolvedValue({
          id: 'tva-yesterday',
          contentHash: 'совсем-другой-отпечаток',
        });

        await service.run();

        expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
      });

      it('у прошлого ролика отпечатка нет — собираем (строки до этой колонки)', async () => {
        // NULL значит «неизвестно», а не «совпало». Иначе первая же
        // ночь после выката перестала бы обновлять все старые
        // ролики — навсегда: строк с отпечатком у них нет и не
        // появится, пока не пересоберём.
        const { service, ffmpeg, prisma } = voicedRun();
        prisma.tutorialVideoAsset.findFirst.mockResolvedValue({
          id: 'tva-old',
          contentHash: null,
        });

        await service.run();

        expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
        // И отпечаток у НОВОЙ строки появился — иначе следующая ночь
        // снова не с чем будет сравнивать.
        expect(
          prisma.tutorialVideoAsset.create.mock.calls[0][0].data.contentHash,
        ).toEqual(expect.any(String));
      });

      describe('покадровые реплики (этап D)', () => {
        /** Сценарий из двух шагов, у обоих реплики. Оба кадра
         *  снимаются: `buildFakePage` отдаёт скриншот на каждый шаг. */
        const NARRATED = {
          id: 'ts-n',
          subjectKey: '1',
          locale: 'ru',
          steps: [
            { kind: 'goto', route: 'generate', narration: 'Открываем мастер.' },
            {
              kind: 'click',
              selector: '#next',
              narration: 'Нажимаем «Далее».',
            },
          ],
        };

        function narratedRun(
          over: {
            scenario?: Record<string, unknown>;
            settings?: Record<string, string | null>;
          } = {},
        ) {
          const page = buildFakePage({ screenshot: true });
          const browser = {
            newPage: jest.fn().mockResolvedValue(page),
            close: jest.fn().mockResolvedValue(undefined),
          };
          launchHeadlessBrowserMock.mockResolvedValue({ browser });
          const built = build([{ ...NARRATED, ...(over.scenario ?? {}) }]);
          built.ffmpeg.configured.mockReturnValue(true);
          built.ffmpeg.submit.mockResolvedValue({
            jobId: 'job-1',
            status: 'queued',
          });
          const settings: Record<string, string | null> = {
            'postprod.tutorialVoice': 'on',
            ...(over.settings ?? {}),
          };
          built.settings.get.mockImplementation(
            async (key: string) => settings[key] ?? null,
          );
          return built;
        }

        it('у каждого шага своя дорожка, а не одна на весь ролик', async () => {
          // Ради этого этап D и делался: вариант Б (§3-бис) вместо
          // варианта А. Общей дорожки в плане быть не должно —
          // `planSlideshow` отвергает команду, где есть и то и
          // другое.
          const { service, ffmpeg, ttsProvider } = narratedRun();

          await service.run();

          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(2);
          expect(ttsProvider.synthesize).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Открываем мастер.' }),
          );
          expect(ttsProvider.synthesize).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Нажимаем «Далее».' }),
          );
          const submitted = ffmpeg.submit.mock.calls[0][0];
          expect(Object.keys(submitted.inputs)).not.toContain('voiceover');
          expect(Object.keys(submitted.inputs)).toEqual(
            expect.arrayContaining(['voice0', 'voice1']),
          );
        });

        it('слоты кеша по номеру шага, а не один файл на сценарий', async () => {
          // Без уровня слота промах по одной реплике сносил бы весь
          // префикс: оператор, поправивший одно слово, платил бы за
          // весь сценарий.
          const { service, blob } = narratedRun();

          await service.run();

          const mp3 = blob.uploadBuffer.mock.calls
            .map((c: string[]) => c[0])
            .filter((p: string) => p.endsWith('.mp3'));
          expect(mp3).toHaveLength(2);
          expect(mp3[0]).toMatch(
            /^tutorial-voiceovers\/ru\/1\/0\/[0-9a-f]{16}-9000\.mp3$/,
          );
          expect(mp3[1]).toMatch(
            /^tutorial-voiceovers\/ru\/1\/1\/[0-9a-f]{16}-9000\.mp3$/,
          );
        });

        it('кадр без реплики остаётся, но молчит', async () => {
          // «Реплики нет» и «кадра нет» — разные вещи (§3-бис.2,
          // врезка). Спутав их, мы сдвинули бы весь ролик.
          const { service, ffmpeg, ttsProvider } = narratedRun({
            scenario: {
              steps: [
                { kind: 'goto', route: 'generate', narration: 'Открываем.' },
                { kind: 'click', selector: '#next' },
              ],
            },
          });

          await service.run();

          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
          const submitted = ffmpeg.submit.mock.calls[0][0];
          expect(Object.keys(submitted.inputs)).toContain('voice0');
          expect(Object.keys(submitted.inputs)).not.toContain('voice1');
          // И тишина именно СОЗДАЁТСЯ фильтром, а не подаётся входом:
          // у `FfmpegApiService.submit` входы это словарь ссылок.
          expect(submitted.commands[0]).toContain('anullsrc');
        });

        it('реплик нет вовсе — работает запасной путь, вариант А', async () => {
          // Обязательная часть этапа: у сценариев, сгенерированных до
          // него, реплик нет и не появится, немыми они остаться не
          // должны.
          const { service, ffmpeg, ttsProvider } = narratedRun({
            scenario: { steps: [{ kind: 'goto', route: 'generate' }] },
          });

          await service.run();

          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
          expect(ttsProvider.synthesize).toHaveBeenCalledWith(
            // Текст варианта А — из карточки шага обучалки, не из
            // сценария.
            expect.objectContaining({ text: expect.stringContaining('.') }),
          );
          expect(Object.keys(ffmpeg.submit.mock.calls[0][0].inputs)).toContain(
            'voiceover',
          );
        });

        it('длительность кадра — по ЕГО реплике, а не по средней', async () => {
          // Вариант А делит речь поровну; на покадровых репликах это
          // дало бы кадр, который меняется посреди фразы.
          const { service, ffmpeg, ttsProvider } = narratedRun();
          ttsProvider.synthesize
            .mockResolvedValueOnce({
              ok: true,
              audio: Buffer.from([1]),
              mimeType: 'audio/mpeg',
              characters: 10,
              durationSeconds: 3,
            })
            .mockResolvedValueOnce({
              ok: true,
              audio: Buffer.from([2]),
              mimeType: 'audio/mpeg',
              characters: 10,
              durationSeconds: 9,
            });

          await service.run();

          const cmd = ffmpeg.submit.mock.calls[0][0].commands[0] as string;
          // 3 + 0.6 и 9 + 0.6 — своя длина у каждого кадра. Средняя
          // (вариант А) дала бы обоим (3 + 9 + 0.6) / 2 = 6.3 и
          // сменила бы кадр посреди второй фразы.
          expect(cmd).toContain('-t 3.6 ');
          expect(cmd).toContain('-t 9.6 ');
          expect(cmd).not.toContain('-t 6.3 ');
        });

        it('вычитка требуется, отметки нет — немой ролик', async () => {
          // Не «пропустить сценарий» и не «подставить вариант А»:
          // регрессионный прогон важнее озвучки и от неё не зависит,
          // а подмена выглядела бы как «всё работает» и обесценила бы
          // выключатель ровно тогда, когда его включили.
          const { service, ffmpeg, ttsProvider } = narratedRun({
            settings: { 'tutorial.requireNarrationReview': 'on' },
          });

          await service.run();

          expect(ttsProvider.synthesize).not.toHaveBeenCalled();
          expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
          const inputs = Object.keys(ffmpeg.submit.mock.calls[0][0].inputs);
          expect(inputs).not.toContain('voiceover');
          expect(inputs).not.toContain('voice0');
        });

        it('вычитка требуется и отметка есть — озвучиваем', async () => {
          const { service, ttsProvider } = narratedRun({
            settings: { 'tutorial.requireNarrationReview': 'on' },
            scenario: { narrationReviewedAt: new Date('2026-09-20') },
          });

          await service.run();

          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(2);
        });

        it('вычитка НЕ требуется — отметка ничего не значит', async () => {
          // Умолчание обратное умолчанию самой озвучки, и это
          // осознанно: реплика — подпись к кадру, а не платёжное
          // поручение (§3-бис.5).
          const { service, ttsProvider } = narratedRun();

          await service.run();

          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(2);
        });

        it('сценарий без реплик выключатель вычитки не глушит', async () => {
          // Вычитывать нечего: текст варианта А — карточка шага
          // обучалки, её писал человек. Заглушив и её, выключатель
          // оставил бы немыми ВСЕ сценарии до этапа D — навсегда.
          const { service, ttsProvider } = narratedRun({
            settings: { 'tutorial.requireNarrationReview': 'on' },
            scenario: { steps: [{ kind: 'goto', route: 'generate' }] },
          });

          await service.run();

          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
        });

        it('реплика осталась у меньшинства кадров — берём вариант А', async () => {
          // §11 п.12: модель «разошлась» и написала слишком длинные
          // реплики — а делает она это пачкой. Без порога одна
          // уцелевшая реплика из трёх включала бы вариант Б: два
          // кадра молчат, один говорит фразу. Вариант А озвучит весь
          // ролик текстом карточки шага (находка аудита этапа D).
          const { service, ffmpeg, ttsProvider } = narratedRun({
            scenario: {
              steps: [
                { kind: 'goto', route: 'generate', narration: 'Одна.' },
                { kind: 'click', selector: '#b' },
                { kind: 'click', selector: '#c' },
              ],
            },
          });

          await service.run();

          const inputs = Object.keys(ffmpeg.submit.mock.calls[0][0].inputs);
          expect(inputs).toContain('voiceover');
          expect(inputs).not.toContain('voice0');
          expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
        });

        it('ровно половина кадров с репликой — этого достаточно для варианта Б', async () => {
          const { service, ffmpeg } = narratedRun({
            scenario: {
              steps: [
                { kind: 'goto', route: 'generate', narration: 'Одна.' },
                { kind: 'click', selector: '#b' },
              ],
            },
          });

          await service.run();

          expect(Object.keys(ffmpeg.submit.mock.calls[0][0].inputs)).toContain(
            'voice0',
          );
        });

        it('сбой Blob на одной дорожке не глушит весь ролик', async () => {
          // До этапа D заливка была одна на сценарий, теперь их до
          // тридцати. Исключение из одной улетало в общий catch и
          // делало немым ВЕСЬ ролик — при том, что предыдущие
          // дорожки уже синтезированы и оплачены (находка аудита
          // этапа D).
          const { service, ffmpeg, blob } = narratedRun();
          let mp3 = 0;
          blob.uploadBuffer.mockImplementation(async (pathname: string) => {
            if (pathname.endsWith('.mp3') && ++mp3 === 2) {
              throw new Error('Blob недоступен');
            }
            return { url: `https://blob.example.com/${pathname}` };
          });

          await service.run();

          const inputs = Object.keys(ffmpeg.submit.mock.calls[0][0].inputs);
          expect(inputs).toContain('voice0');
          expect(inputs).not.toContain('voice1');
        });

        it('кадр не снялся — дорожку его шага из кеша не выметаем', async () => {
          // Скриншот снимается best-effort и пропадает молча. Сложив
          // `keep` из снятых кадров, мы стирали бы готовую дорожку
          // пропавшего шага и платили за неё заново ближайшей ночью
          // (находка аудита этапа D).
          // Что лежит в кеше — узнаём у прогона, где оба кадра снялись.
          const both = narratedRun();
          await both.service.run();
          const cached = both.blob.uploadBuffer.mock.calls
            .map((c: string[]) => c[0])
            .filter((path: string) => path.endsWith('.mp3'));
          expect(cached).toHaveLength(2);

          // Тот же сценарий из двух шагов, но скриншот второго шага
          // не удался — best-effort, кадр пропадает молча.
          const page = buildFakePage({ screenshot: true });
          let shots = 0;
          page.screenshot = jest.fn(async () => {
            if (++shots === 2) throw new Error('CDP икнул');
            return new Uint8Array([1]);
          });
          const browser = {
            newPage: jest.fn().mockResolvedValue(page),
            close: jest.fn().mockResolvedValue(undefined),
          };
          launchHeadlessBrowserMock.mockResolvedValue({ browser });
          const { service, blob } = narratedRun();
          blob.listByPrefix.mockResolvedValue({
            blobs: cached.map((pathname: string) => ({ pathname })),
            cursor: null,
          });

          await service.run();

          const deleted = blob.deleteMany.mock.calls.flatMap(
            (c: string[][]) => c[0],
          );
          // Дорожка шага 1 в кеше осталась, хотя его кадр сегодня не
          // снимался.
          expect(deleted).not.toContain(cached[1]);
        });

        it('подписи прожигаются и лежат под префиксом актива (этап E)', async () => {
          // Ролик смотрят без звука чаще, чем со звуком, и подпись —
          // единственное, что в этом случае объясняет кадр (§5 ТЗ).
          const { service, ffmpeg, blob } = narratedRun();

          await service.run();

          const ass = blob.uploadBuffer.mock.calls.find((c: string[]) =>
            c[0].endsWith('.ass'),
          );
          expect(ass[0]).toBe('tutorial-video-frames/tva-new/captions.ass');
          // Текст реплики — дословно тот же, что ушёл в синтез.
          expect(String(ass[1])).toContain('Открываем мастер.');
          const submitted = ffmpeg.submit.mock.calls[0][0];
          expect(submitted.inputs.captions).toBeDefined();
          // Фильтр над готовой склейкой, не отдельный `-i`: иначе
          // `.ass` стал бы ещё одним потоком и сломал бы нумерацию
          // дорожек.
          expect(submitted.commands[0]).toContain(
            '[outv]subtitles={{captions}}[outc]',
          );
          expect(submitted.commands[0]).toContain('-map "[outc]"');
        });

        it('подписи есть и без озвучки — они от неё не зависят', async () => {
          // §9 п.4 требует уметь выключить подписи независимо от
          // звука, §5 объясняет зачем: ролик смотрят без звука чаще,
          // чем со звуком. Первая редакция этапа E брала текст
          // подписи у СИНТЕЗИРОВАННОЙ дорожки — и подписей не было,
          // пока озвучка выключена, то есть по умолчанию не было
          // никогда (находка аудита этапа E).
          const { service, ffmpeg, blob, ttsProvider } = narratedRun({
            settings: { 'postprod.tutorialVoice': null },
          });

          await service.run();

          expect(ttsProvider.synthesize).not.toHaveBeenCalled();
          const ass = blob.uploadBuffer.mock.calls.find((c: string[]) =>
            c[0].endsWith('.ass'),
          );
          expect(String(ass?.[1])).toContain('Открываем мастер.');
          const submitted = ffmpeg.submit.mock.calls[0][0];
          expect(submitted.inputs.captions).toBeDefined();
          // Ролик при этом немой — и это рабочий исход, а не
          // недоразумение.
          expect(submitted.commands[0]).not.toContain('-map "[outa]"');
        });

        it('дорожка шага не синтезировалась — подпись у кадра всё равно есть', async () => {
          // Текст-то цел, не доехал звук.
          const { service, blob, ttsProvider } = narratedRun();
          ttsProvider.synthesize
            .mockResolvedValueOnce({
              ok: true,
              audio: Buffer.from([1]),
              mimeType: 'audio/mpeg',
              characters: 10,
              durationSeconds: 3,
            })
            .mockResolvedValue({ ok: false, skipped: false, reason: 'лимит' });

          await service.run();

          const ass = String(
            blob.uploadBuffer.mock.calls.find((c: string[]) =>
              c[0].endsWith('.ass'),
            )?.[1],
          );
          expect(ass).toContain('Открываем мастер.');
          expect(ass).toContain('Нажимаем «Далее».');
        });

        it('вычитка требуется и не сделана — ни звука, НИ подписей', async () => {
          // Непрочитанный текст не должен попасть зрителю ни в уши,
          // ни на экран.
          const { service, ffmpeg, blob } = narratedRun({
            settings: { 'tutorial.requireNarrationReview': 'on' },
          });

          await service.run();

          expect(
            blob.uploadBuffer.mock.calls.filter((c: string[]) =>
              c[0].endsWith('.ass'),
            ),
          ).toHaveLength(0);
          expect(
            ffmpeg.submit.mock.calls[0][0].inputs.captions,
          ).toBeUndefined();
        });

        it('подписи не залились — ролик собирается без них, а не падает', async () => {
          // Необязательное улучшение не должно стоить ролика. Ровно
          // эту находку аудит этапа D закрыл у дорожек озвучки.
          const { service, ffmpeg, blob } = narratedRun();
          blob.uploadBuffer.mockImplementation(async (pathname: string) => {
            if (pathname.endsWith('.ass')) throw new Error('Blob недоступен');
            return { url: `https://blob.example.com/${pathname}` };
          });

          await service.run();

          expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
          expect(
            ffmpeg.submit.mock.calls[0][0].inputs.captions,
          ).toBeUndefined();
        });

        it('подписи выключены настройкой — ролик со звуком, без них', async () => {
          // Четвёртый уровень отката §9: выключается независимо от
          // звука. §11 п.19 требует, чтобы звук при этом не пострадал.
          const { service, ffmpeg, blob } = narratedRun({
            settings: { 'postprod.tutorialCaptions': 'off' },
          });

          await service.run();

          expect(
            blob.uploadBuffer.mock.calls.filter((c: string[]) =>
              c[0].endsWith('.ass'),
            ),
          ).toHaveLength(0);
          const submitted = ffmpeg.submit.mock.calls[0][0];
          expect(submitted.inputs.captions).toBeUndefined();
          expect(submitted.commands[0]).not.toContain('subtitles=');
          // Звук на месте.
          expect(Object.keys(submitted.inputs)).toContain('voice0');
          expect(submitted.commands[0]).toContain('-map "[outa]"');
        });

        it('реплик нет — подписей нет, но вариант А звучит', async () => {
          // Подпись — это подпись к КАДРУ. У варианта А текст один на
          // весь ролик, и растянуть его на всю склейку значило бы
          // показать стену текста поверх всего.
          const { service, ffmpeg, blob } = narratedRun({
            scenario: { steps: [{ kind: 'goto', route: 'generate' }] },
          });

          await service.run();

          expect(
            blob.uploadBuffer.mock.calls.filter((c: string[]) =>
              c[0].endsWith('.ass'),
            ),
          ).toHaveLength(0);
          expect(Object.keys(ffmpeg.submit.mock.calls[0][0].inputs)).toContain(
            'voiceover',
          );
        });

        it('выключение подписей заказывает пересборку', async () => {
          // Картинка изменилась — значит изменился и отпечаток.
          // Иначе выключатель не подействовал бы ни на один уже
          // собранный ролик, и «без деплоя» оказалось бы неправдой.
          const withCaps = narratedRun();
          await withCaps.service.run();
          const a = withCaps.prisma.tutorialVideoAsset.create.mock.calls[0][0]
            .data.contentHash as string;

          const without = narratedRun({
            settings: { 'postprod.tutorialCaptions': 'off' },
          });
          await without.service.run();
          const b = without.prisma.tutorialVideoAsset.create.mock.calls[0][0]
            .data.contentHash as string;

          expect(a).not.toBe(b);
        });

        it('кеш сценария выметается от лишнего, а нужное остаётся', async () => {
          // Три способа накопить сирот разом: старая плоская
          // раскладка, шаг с убранной репликой, переход Б → А.
          const { service, blob } = narratedRun();
          blob.listByPrefix.mockResolvedValue({
            blobs: [
              { pathname: 'tutorial-voiceovers/ru/1/old-flat.mp3' },
              { pathname: 'tutorial-voiceovers/ru/1/7/gone.mp3' },
              { pathname: 'tutorial-voiceovers/ru/1/all/was-variant-a.mp3' },
            ],
            cursor: null,
          });

          await service.run();

          const deleted = blob.deleteMany.mock.calls.flatMap(
            (c: string[][]) => c[0],
          );
          expect(deleted).toEqual(
            expect.arrayContaining([
              'tutorial-voiceovers/ru/1/old-flat.mp3',
              'tutorial-voiceovers/ru/1/7/gone.mp3',
              'tutorial-voiceovers/ru/1/all/was-variant-a.mp3',
            ]),
          );
        });

        it('немой исход кеш не трогает', async () => {
          // Выключили озвучку на ночь — вернув её, платить за весь
          // набор заново не придётся. В кеше НАРОЧНО что-то лежит:
          // пустой префикс не отличил бы «не выметали» от «выметали
          // и не нашли».
          const { service, blob } = narratedRun({
            settings: { 'postprod.tutorialVoice': null },
          });
          blob.listByPrefix.mockResolvedValue({
            blobs: [{ pathname: 'tutorial-voiceovers/ru/1/0/cached.mp3' }],
            cursor: null,
          });

          await service.run();

          expect(blob.deleteMany).not.toHaveBeenCalled();
        });

        it('реплика вошла в отпечаток: правка текста заказывает пересборку', async () => {
          // Без этого правка ОДНОЙ реплики не меняла бы отпечаток
          // (кадры-то те же), пересборка не заказывалась бы — и
          // исправленный текст не звучал бы никогда, молча.
          const first = narratedRun();
          await first.service.run();
          const hashA = first.prisma.tutorialVideoAsset.create.mock.calls[0][0]
            .data.contentHash as string;

          const second = narratedRun({
            scenario: {
              steps: [
                {
                  kind: 'goto',
                  route: 'generate',
                  narration: 'Открываем мастер генерации.',
                },
                {
                  kind: 'click',
                  selector: '#next',
                  narration: 'Нажимаем «Далее».',
                },
              ],
            },
          });
          // Другой текст — другой путь в кеше, значит другая ссылка.
          second.blob.uploadBuffer.mockImplementation(
            async (pathname: string) => ({
              url: `https://blob.example.com/${pathname}`,
            }),
          );
          await second.service.run();
          const hashB = second.prisma.tutorialVideoAsset.create.mock.calls[0][0]
            .data.contentHash as string;

          expect(hashA).not.toBe(hashB);
        });
      });

      it('голос из настройки доезжает до провайдера', async () => {
        // Грамматика `on:<voiceId>` без этой проверки могла тихо
        // перестать работать: парсер её знает, а вызов — нет
        // (находка аудита этапа B).
        const { service, ttsProvider } = voicedRun({
          setting: 'on:rachel-42',
        });

        await service.run();

        expect(ttsProvider.synthesize).toHaveBeenCalledWith(
          expect.objectContaining({ voiceId: 'rachel-42' }),
        );
      });

      it('смена голоса меняет ключ кеша — старая дорожка не подходит', async () => {
        // Первая редакция ключа брала только шаг, локаль и текст:
        // оператор вводил новый голос, жал «Сохранить голос» — и в
        // уже собранных шагах не менялось НИЧЕГО (находка сквозного
        // аудита A+B+C).
        const paths: string[] = [];
        for (const setting of ['on', 'on:rachel-42']) {
          const { service, blob } = voicedRun({ setting });
          blob.uploadBuffer.mockImplementation(async (pathname: string) => {
            if (pathname.endsWith('.mp3')) paths.push(pathname);
            return { url: 'https://blob.example.com/x' };
          });
          await service.run();
        }

        expect(paths).toHaveLength(2);
        expect(paths[0]).not.toBe(paths[1]);
      });

      it('смена провайдера меняет ключ кеша — второй уровень отката работает', async () => {
        // Переключение на `veo` обещает немые ролики; на прогретом
        // кеше по старому ключу они остались бы озвученными чужой
        // дорожкой.
        const paths: string[] = [];
        for (const providerKey of ['elevenlabs', 'resemble']) {
          const { service, blob, ttsProvider } = voicedRun();
          ttsProvider.providerKey = providerKey;
          blob.uploadBuffer.mockImplementation(async (pathname: string) => {
            if (pathname.endsWith('.mp3')) paths.push(pathname);
            return { url: 'https://blob.example.com/x' };
          });
          await service.run();
        }

        expect(paths).toHaveLength(2);
        expect(paths[0]).not.toBe(paths[1]);
      });

      /** Путь, под который прогон КЛАДЁТ дорожку. Берётся из самого
       *  прогона, а не считается в тесте: хеш ключа кеша — частность
       *  реализации, и повторять её здесь значило бы проверять свою
       *  же копию формулы. */
      async function cachedPathnameAfterColdRun(): Promise<string> {
        const cold = voicedRun();
        await cold.service.run();
        const mp3 = cold.blob.uploadBuffer.mock.calls
          .map((c: string[]) => c[0])
          .filter((path: string) => path.endsWith('.mp3'));
        expect(mp3).toHaveLength(1);
        return mp3[0];
      }

      it('дорожка уже в кеше — синтеза и оплаты нет, берём готовую', async () => {
        // Ночной крон идёт каждую ночь; без кеша он платил бы за одну
        // и ту же фразу ежесуточно (≈$6 за полный набор).
        const cached = await cachedPathnameAfterColdRun();
        const { service, blob, ffmpeg, ttsProvider, aiUsage } = voicedRun();
        blob.listByPrefix.mockResolvedValue({
          blobs: [{ pathname: cached }],
          cursor: null,
        });
        blob.getPublicUrl.mockResolvedValue('https://blob.example.com/hit.mp3');

        await service.run();

        expect(ttsProvider.synthesize).not.toHaveBeenCalled();
        // И НИ ОДНОГО скачивания: длина читается из имени файла.
        // Прежняя редакция качала mp3 целиком ради одного числа, и на
        // варианте Б это стало до тридцати скачиваний в четырёхминутный
        // бюджет прогона (находка аудита этапа D).
        expect(blob.downloadBuffer).not.toHaveBeenCalled();
        // Не «ни одной записи расхода» — сборка ffmpeg платная и
        // пишется всегда (сквозной аудит A+B+C). Проверяем ровно
        // то, ради чего тест: за СИНТЕЗ не платят повторно.
        expect(operationsRecorded(aiUsage)).not.toContain('voiceover');
        expect(ffmpeg.submit.mock.calls[0][0].inputs.voiceover).toBe(
          'https://blob.example.com/hit.mp3',
        );
      });

      it('длина дорожки едет в ИМЕНИ файла и оттуда же читается', async () => {
        // Двойник провайдера отдаёт 9 секунд; в имени обязаны
        // оказаться миллисекунды, иначе следующей ночью длину брать
        // будет неоткуда и кадр схлопнется до минимума.
        const cached = await cachedPathnameAfterColdRun();

        expect(cached).toMatch(
          /^tutorial-voiceovers\/ru\/1\/all\/[0-9a-f]{16}-9000\.mp3$/,
        );
      });

      it('попадание в кеш даёт ту же длину кадра, что и синтез', async () => {
        // Длина читается из имени. Прочитав её как «неизвестно», мы
        // схлопнули бы кадр до минимума — ролик со второй ночи стал
        // бы короче и обрезал бы собственную речь, молча.
        const cached = await cachedPathnameAfterColdRun();
        const { service, blob, ffmpeg } = voicedRun();
        blob.listByPrefix.mockResolvedValue({
          blobs: [{ pathname: cached }],
          cursor: null,
        });

        await service.run();

        // 9 с речи + 0.6 хвоста на один кадр — как и на холодном
        // прогоне, а не 1.5 с минимума.
        expect(ffmpeg.submit.mock.calls[0][0].commands[0]).toContain('-t 9.6 ');
      });

      it('промах кеша сносит прежнюю дорожку этого ключа — кеш не растёт', async () => {
        // Поправили текст шага — сменился хеш; старый файл иначе
        // остался бы под тем же префиксом навсегда.
        const { service, blob } = voicedRun();
        blob.listByPrefix.mockResolvedValue({
          blobs: [{ pathname: 'tutorial-voiceovers/ru/1/all/old-1.mp3' }],
          cursor: null,
        });

        await service.run();

        expect(blob.deleteMany).toHaveBeenCalledWith([
          'tutorial-voiceovers/ru/1/all/old-1.mp3',
        ]);
      });

      it('длительность кадра считается по ИЗМЕРЕННОЙ речи, а не по константе', async () => {
        // Девять секунд речи на один кадр — кадр обязан стать
        // длиннее прежних двух секунд, иначе дорожку обрежет.
        const { service, prisma } = voicedRun();

        await service.run();

        const pending = prisma.tutorialVideoAsset.update.mock.calls.find(
          ([arg]: [{ data: Record<string, unknown> }]) =>
            arg.data.assemblyStatus === 'pending',
        );
        expect(pending![0].data.durationMs).toBe(9600);
      });

      it('расход за синтез записывается — молчаливой траты не остаётся', async () => {
        const { service, aiUsage } = voicedRun();

        await service.run();

        expect(aiUsage.record).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'voiceover',
            model: 'elevenlabs-tts',
            characters: 42,
          }),
        );
      });

      it('синтез отказал — ролик всё равно собирается, немым', async () => {
        // Первый принцип: результат получается всегда. Озвучка —
        // улучшение, а не условие.
        const { service, ffmpeg, ttsProvider, aiUsage } = voicedRun();
        ttsProvider.synthesize.mockResolvedValue({
          ok: false,
          skipped: false,
          reason: 'провайдер отказал',
        });

        await service.run();

        expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
        const submitted = ffmpeg.submit.mock.calls[0][0];
        expect(Object.keys(submitted.inputs)).not.toContain('voiceover');
        // За несостоявшийся синтез не платят — и записи о нём нет.
        // Запись о сборке при этом есть: кадры собрались, деньги за
        // приём задачи ffmpeg отданы.
        expect(operationsRecorded(aiUsage)).toEqual([
          'tutorial-video-assembly',
        ]);
      });

      it('заливка mp3 упала — тоже немой ролик, а не потерянный', async () => {
        const { service, blob, ffmpeg } = voicedRun();
        blob.uploadBuffer.mockImplementation(async (pathname: string) =>
          pathname.endsWith('.mp3')
            ? Promise.reject(new Error('Blob недоступен'))
            : { url: 'https://blob.example.com/frame.jpg' },
        );

        await service.run();

        expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
        expect(
          Object.keys(ffmpeg.submit.mock.calls[0][0].inputs),
        ).not.toContain('voiceover');
      });

      it('текста для этой локали нет — немой ролик, а не русский под чужим языком', async () => {
        const { service, ffmpeg, tts } = build([
          { ...SCENARIO_OK, subjectKey: 'client-site' },
        ]);
        const page = buildFakePage({ screenshot: true });
        launchHeadlessBrowserMock.mockResolvedValue({
          browser: {
            newPage: jest.fn().mockResolvedValue(page),
            close: jest.fn().mockResolvedValue(undefined),
          },
        });
        ffmpeg.configured.mockReturnValue(true);
        ffmpeg.submit.mockResolvedValue({ jobId: 'job-1', status: 'queued' });

        await service.run();

        expect(tts.resolve).not.toHaveBeenCalled();
        expect(
          Object.keys(ffmpeg.submit.mock.calls[0][0].inputs),
        ).not.toContain('voiceover');
      });
    });

    it('провалившийся сценарий не сабмитит сборку видео вовсе', async () => {
      const page = buildFakePage({ failClick: true, screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, blob, ffmpeg } = build([SCENARIO_FAIL]);
      ffmpeg.configured.mockReturnValue(true);

      await service.run();

      expect(blob.uploadBuffer).not.toHaveBeenCalled();
      expect(ffmpeg.submit).not.toHaveBeenCalled();
    });

    it('сборка провалилась на submit (сеть) — не бросает, regression-результат уже записан', async () => {
      const page = buildFakePage({ screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, prisma, blob, ffmpeg } = build([SCENARIO_OK]);
      ffmpeg.configured.mockReturnValue(true);
      ffmpeg.submit.mockRejectedValue(new Error('сеть недоступна'));

      const result = await service.run();

      expect(result.passed).toBe(1);
      // Строка теперь ЕСТЬ — она заводится до заливки кадров, — но
      // помечена сбойной с причиной. Прежний порядок оставлял вместо
      // неё кадры в Blob без единой ссылки из базы: опрашивать нечего,
      // убирать некому, подметальщика по этому префиксу нет (аудит
      // 27.09.2026).
      expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tva-new' },
          data: expect.objectContaining({
            assemblyStatus: 'failed',
            assemblyError: 'сеть недоступна',
          }),
        }),
      );
      // И кадры за собой убраны.
      expect(blob.listByPrefix).toHaveBeenCalledWith(
        'tutorial-video-frames/tva-new/',
        expect.anything(),
      );
    });

    it('кадры не годятся для сборки — строка и кадры не остаются висеть', async () => {
      // Ранний выход по `planSlideshow === null` происходил уже ПОСЛЕ
      // заливки: без уборки это была бы та же сирота.
      const page = buildFakePage({ screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, prisma, blob, ffmpeg } = build([SCENARIO_OK]);
      ffmpeg.configured.mockReturnValue(true);
      // `mockReturnValueOnce`, а не `mockReturnValue`: подмена нужна
      // ровно на одну сборку. Раньше здесь стоял `mockReturnValue`, и
      // при `clearAllMocks` в `afterEach` подмена утекала в ВСЕ
      // следующие тесты файла — любой, дошедший до сборки, молча
      // получал «кадры не годятся». Найдено на этапе A: новый тест
      // упал не своей причиной. Причина вылечена в `afterEach`
      // (`restoreAllMocks` + `resetAllMocks`), «Once» осталось как
      // выражение намерения.
      jest
        .spyOn(assembly, 'planSlideshow')
        .mockReturnValueOnce(
          null as unknown as ReturnType<typeof assembly.planSlideshow>,
        );

      await service.run();

      expect(ffmpeg.submit).not.toHaveBeenCalled();
      expect(blob.listByPrefix).toHaveBeenCalledWith(
        'tutorial-video-frames/tva-new/',
        expect.anything(),
      );
      expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ assemblyStatus: 'failed' }),
        }),
      );
    });

    it('poll: задача ещё pending у внешнего api — TutorialVideoAsset не трогается', async () => {
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          frameCount: 2,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({ status: 'pending' });

      await service.run();

      expect(prisma.tutorialVideoAsset.update).not.toHaveBeenCalled();
    });

    it('poll: задача завершилась — скачивает результат, перезаливает в свой Blob, помечает complete, чистит кадры-транзиты', async () => {
      const { service, prisma, blob, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          frameCount: 2,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'tutorial.mp4': 'https://ffmpeg-api.example.com/out.mp4' },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }) as unknown as typeof fetch;

      await service.run();

      expect(blob.uploadBuffer).toHaveBeenCalledWith(
        'tutorial-videos/1/tva-1.mp4',
        expect.any(Buffer),
        'video/mp4',
      );
      expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tva-1' },
          data: expect.objectContaining({ assemblyStatus: 'complete' }),
        }),
      );
      // Уборка по ПРЕФИКСУ, а не по счётчику 0..n-1: счётчик мог быть
      // меньше, чем лежит, и разница осталась бы навсегда.
      expect(blob.listByPrefix).toHaveBeenCalledWith(
        'tutorial-video-frames/tva-1/',
        expect.anything(),
      );
    });

    it('кадры не убрались — ролик всё равно собран, а не «провалился»', async () => {
      // Уборка кадров стояла ВНУТРИ того же try, что скачивание и
      // перезаливка. Икота Blob на ней после уже записанного
      // `complete` + `blobUrl` уводила строку в `catch` →
      // `failAssembly` → `failed`, причём `blobUrl` оставался, а текст
      // ошибки врал: «не удалось скачать/перезалить готовое видео».
      // Дальше по цепочке оператор одобрял такую строку (статус
      // никто не проверяет), консультант отдавал её посетителю — и
      // подметальщик считал её неproигрываемой (находка повторного
      // сквозного аудита A+B+C).
      const { service, prisma, blob, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'tutorial.mp4': 'https://ffmpeg-api.example.com/out.mp4' },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }) as unknown as typeof fetch;
      blob.listByPrefix.mockRejectedValue(new Error('Blob недоступен'));

      await service.pollAssemblies();

      const statuses = prisma.tutorialVideoAsset.update.mock.calls.map(
        (c: { data: { assemblyStatus?: string } }[]) =>
          c[0].data.assemblyStatus,
      );
      expect(statuses).toEqual(['complete']);
      expect(statuses).not.toContain('failed');
    });

    // Сквозной аудит 27.09.2026, находка Д-3: `durationMs` читается
    // экраном мастера (`client-site-tutorial.service.ts`) и печатается
    // как «Длительность — около N с», но не записывался ни одним
    // путём — строка не появлялась ни у кого.
    //
    // Этап A перенёс запись с завершения на ОТПРАВКУ и взял число из
    // плана: до этого писатель умножал `frameCount × SECONDS_PER_FRAME`
    // у себя, за три модуля от места, где строится команда. Пока все
    // кадры одной длины, оба способа дают одно и то же; на этапе B
    // длины разойдутся, и второй разошёлся бы молча.
    it('submit: durationMs пишется из плана, а не пересчитывается писателем', async () => {
      // Подменяем ПЛАНУ длительность на число, которое из кадров
      // никак не получить: 2 с × 1 кадр дало бы 2000. Если писатель
      // снова начнёт считать сам (`frameCount × SECONDS_PER_FRAME`),
      // в базу уйдёт 2000 и тест упадёт. Проверять ожиданием
      // `SECONDS_PER_FRAME * 1000` было бы бесполезно: та же формула
      // с обеих сторон, обе мутации проходят.
      const page = buildFakePage({ screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, prisma, ffmpeg } = build([SCENARIO_OK]);
      ffmpeg.configured.mockReturnValue(true);
      ffmpeg.submit.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
      const real = assembly.planSlideshow;
      jest
        .spyOn(assembly, 'planSlideshow')
        .mockImplementation((frames, opts) => {
          const plan = real(frames, opts);
          return plan && { ...plan, durationMs: 987_654 };
        });

      await service.run();

      expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assemblyStatus: 'pending',
            durationMs: 987_654,
          }),
        }),
      );
    });

    it('poll: на завершении durationMs НЕ пересчитывается заново', async () => {
      // Второй расчёт — это вторая формула, и расходится она молча.
      // Число уже записано при отправке, из плана, по которому собран
      // именно этот файл.
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          frameCount: 3,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'tutorial.mp4': 'https://ffmpeg-api.example.com/out.mp4' },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }) as unknown as typeof fetch;

      await service.run();

      const completion = prisma.tutorialVideoAsset.update.mock.calls.find(
        ([arg]: [{ data: Record<string, unknown> }]) =>
          arg.data.assemblyStatus === 'complete',
      );
      expect(completion).toBeDefined();
      expect(completion![0].data).not.toHaveProperty('durationMs');
    });

    it('опрос сборок упал — сценарии всё равно исполняются', async () => {
      // `run()` начинается с опроса, и доккомментарий обещает, что
      // одно от другого не зависит. Зависимость была, и обратная:
      // исключение из опроса (икота базы, вторая подряд ошибка Blob,
      // отказ подметальщика) вылетало ДО первого сценария, и прогон
      // не исполнял НИ ОДНОГО (находка повторного сквозного аудита
      // A+B+C). Опрос при этом повторяется каждые две минуты сам.
      const page = buildFakePage({ screenshot: true });
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      const { service, prisma } = build([SCENARIO_OK]);
      prisma.cronJobLock.create.mockRejectedValue(new Error('база недоступна'));
      prisma.cronJobLock.updateMany.mockRejectedValue(
        new Error('база недоступна'),
      );

      const result = await service.run();

      expect(result.passed).toBe(1);
    });

    // Находка Д-2: отдельный вход для частого крона. Он обязан
    // опрашивать сборки и обязан НЕ открывать браузер.
    it('pollAssemblies: опрашивает сборки, не запуская headless-браузер', async () => {
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      prisma.tutorialVideoAsset.count.mockResolvedValue(2);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          frameCount: 1,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({ status: 'pending' });

      const result = await service.pollAssemblies();

      expect(ffmpeg.status).toHaveBeenCalledTimes(1);
      expect(launchHeadlessBrowserMock).not.toHaveBeenCalled();
      // `polled` — сделанная работа, `pending` — остаток ПОСЛЕ опроса.
      // Прежняя редакция считала остаток ДО, и после тика, закрывшего
      // все сборки, в журнале всё равно стояло «pending=N».
      // `abandoned: 0` — зависших в `preparing` не было; не ноль
      // означал бы, что подготовка где-то обрывается.
      expect(result).toEqual({
        polled: 1,
        pending: 2,
        abandoned: 0,
        swept: 0,
      });
    });

    describe('подметальщик устаревших роликов', () => {
      /** Собранный ролик пары (шаг, локаль) с настоящим blobUrl. */
      function video(over: Record<string, unknown> = {}) {
        const id = String(over.id ?? 'tva-x');
        return {
          subjectKey: '1',
          locale: 'ru',
          assemblyStatus: 'complete',
          reviewed: false,
          clientSiteDraftId: null,
          blobUrl: `https://blob.example.com/tutorial-videos/1/${id}.mp4`,
          ...over,
          id,
        };
      }

      it('вчерашние ролики пары уходят вместе со своими mp4', async () => {
        // Без уборки пара прирастает строкой и файлом каждую ночь —
        // при пяти локалях это до тридцати mp4 за ночь, навсегда
        // (находка сквозного аудита A+B+C).
        const { service, prisma, blob } = build([]);
        stubAssets(prisma, [
          video({ id: 'today' }),
          video({ id: 'yesterday' }),
          video({ id: 'earlier' }),
        ]);

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(2);
        expect(blob.deleteBlob.mock.calls.map((c: string[]) => c[0])).toEqual([
          'tutorial-videos/1/yesterday.mp4',
          'tutorial-videos/1/earlier.mp4',
        ]);
        expect(
          prisma.tutorialVideoAsset.delete.mock.calls.map(
            (c: { where: { id: string } }[]) => c[0].where.id,
          ),
        ).toEqual(['yesterday', 'earlier']);
      });

      it('ролики обучалки по сайту заказчика не трогаются вовсе', async () => {
        // У них ключ у всех один и тот же служебный `client-site`,
        // то есть «одна пара — один ролик» схлопнуло бы разных
        // заказчиков в одну пару и стёрло бы всё, кроме последнего.
        // Живут они до удаления черновика (§5.2 DELETE).
        const { service, prisma, blob } = build([]);
        stubAssets(prisma, [
          video({
            id: 'cs-2',
            subjectKey: 'client-site',
            clientSiteDraftId: 'draft-b',
          }),
          video({
            id: 'cs-1',
            subjectKey: 'client-site',
            clientSiteDraftId: 'draft-a',
          }),
        ]);

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(0);
        expect(blob.deleteBlob).not.toHaveBeenCalled();
      });

      it('ролик с заявкой публикации остаётся — файл у заявки не свой', async () => {
        // `publishTutorialVideo` намеренно НЕ делает копии файла
        // («лежит в постоянном, не TTL'мом префиксе — копировать
        // нечего»), и заявка ссылается прямо на этот mp4. Удалив
        // его, мы бы уронили выгрузку на площадку молча.
        const { service, prisma, blob } = build([]);
        stubAssets(prisma, [
          video({ id: 'today' }),
          video({ id: 'published' }),
          video({ id: 'plain' }),
        ]);
        prisma.publicationRequest.findMany.mockResolvedValue([
          { tutorialVideoAssetId: 'published' },
        ]);

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(1);
        expect(blob.deleteBlob).toHaveBeenCalledTimes(1);
        expect(blob.deleteBlob).toHaveBeenCalledWith(
          'tutorial-videos/1/plain.mp4',
        );
      });

      it('заявка появилась уже во время уборки — ролик не трогаем', async () => {
        // Пакетный вопрос о заявках задаётся один раз на всю партию,
        // а партия удаляется до сотни строк подряд. Оператор,
        // нажавший «Опубликовать» внутри этого окна, получил бы
        // заявку со ссылкой на удалённый файл (находка повторного
        // сквозного аудита A+B+C).
        const { service, prisma, blob } = build([]);
        stubAssets(prisma, [video({ id: 'today' }), video({ id: 'old' })]);
        prisma.publicationRequest.count.mockResolvedValue(1);

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(0);
        expect(blob.deleteBlob).not.toHaveBeenCalled();
      });

      it('файл не удалился — строка остаётся, чтобы попробовать снова', async () => {
        // Обратный порядок (сначала строка) терял бы путь к mp4
        // навсегда: он известен только из строки.
        const { service, prisma, blob } = build([]);
        stubAssets(prisma, [video({ id: 'today' }), video({ id: 'old' })]);
        blob.deleteBlob.mockRejectedValue(new Error('Blob недоступен'));

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(0);
        expect(prisma.tutorialVideoAsset.delete).not.toHaveBeenCalled();
      });

      it('строка без blobUrl удаляется — файла за ней нет', async () => {
        // `failed` до отправки задачи: mp4 не появился вовсе, а
        // держать строку вечно незачем.
        const { service, prisma, blob } = build([]);
        stubAssets(prisma, [
          video({ id: 'today' }),
          video({ id: 'no-file', assemblyStatus: 'failed', blobUrl: null }),
        ]);

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(1);
        expect(blob.deleteBlob).not.toHaveBeenCalled();
      });

      it('за тик удаляется не больше сотни', async () => {
        // Первый прогон на накопленной таблице не должен превращаться
        // в сотни удалений файлов по одному внутри одного тика.
        const { service, prisma } = build([]);
        stubAssets(
          prisma,
          Array.from({ length: 150 }, (_, i) => video({ id: `old-${i}` })),
        );

        const result = await service.pollAssemblies();

        expect(result.swept).toBe(100);
      });
    });

    it('строка застряла в preparing — снимается вместе с кадрами', async () => {
      // `preparing` — окно между созданием строки и `submit`. Опрос
      // берёт только `pending`, и если процесс умрёт внутри окна,
      // КАДРЫ остались бы в Blob навсегда: подметальщик ходит только
      // когда его позвали (находка аудита этапа B).
      //
      // Про озвучку здесь речи нет и быть не может: дорожка живёт в
      // кеше вне префикса актива и переживает уборку намеренно —
      // прежнее название теста обещало то, чего он не делает
      // (находка сквозного аудита A+B+C).
      const { service, prisma, blob, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-stuck',
          subjectKey: '1',
          scenarioId: 'ts-1',
          assemblyStatus: 'preparing',
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      ]);

      const result = await service.pollAssemblies();

      expect(result.abandoned).toBe(1);
      expect(blob.listByPrefix).toHaveBeenCalledWith(
        'tutorial-video-frames/tva-stuck/',
        expect.anything(),
      );
      expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tva-stuck' },
          data: expect.objectContaining({ assemblyStatus: 'failed' }),
        }),
      );
    });

    it('зависшая preparing обучалки по сайту возвращает черновик на одобрение', async () => {
      // Иначе черновик остаётся `APPROVED` с брошенной сборкой, и
      // повторить её нечем. С правки сквозного аудита A+B+C в
      // `preparing` заводятся и строки этого пути.
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-cs',
          subjectKey: 'client-site',
          clientSiteDraftId: 'draft-7',
          assemblyStatus: 'preparing',
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      ]);

      await service.pollAssemblies();

      expect(prisma.clientSiteTutorialDraft.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'draft-7', status: 'APPROVED' },
        }),
      );
    });

    it('свежая preparing НЕ снимается — её прямо сейчас и готовят', async () => {
      // Подметание идёт в том же `pollAssemblies`, который дёргает и
      // двухминутный крон. Без выдержки он снёс бы строку, созданную
      // секунду назад суточным прогоном, вместе с уже залитыми
      // кадрами — прямо посреди подготовки.
      const { service, prisma, blob, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-fresh',
          subjectKey: '1',
          scenarioId: 'ts-1',
          assemblyStatus: 'preparing',
          createdAt: new Date(),
        },
      ]);

      const result = await service.pollAssemblies();

      expect(result.abandoned).toBe(0);
      expect(blob.listByPrefix).not.toHaveBeenCalled();
    });

    // Находка аудита 27.09.2026 на собственной вчерашней работе: замок
    // держал крон, а суточный прогон опрашивал те же строки в обход
    // него. Проигравший доходил до `failAssembly`/`cleanupFrames` уже
    // после чужого `complete` — помечал готовую сборку сбойной и
    // стирал её кадры.
    it('замок занят — опроса нет вовсе, и это видно по ответу', async () => {
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      prisma.cronJobLock.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );
      prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.pollAssemblies();

      expect(result.skipped).toMatch(/не завершился/);
      expect(result.polled).toBe(0);
      expect(prisma.tutorialVideoAsset.findMany).not.toHaveBeenCalled();
    });

    it('суточный прогон опрашивает через тот же замок, а не в обход', async () => {
      // Ровно то, чего не хватало: инвариант «опрашивает не больше
      // одного» принадлежит опросу, а не одному из вызывающих.
      const { service, prisma } = build([]);
      prisma.cronJobLock.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );
      prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

      await service.run();

      expect(prisma.tutorialVideoAsset.findMany).not.toHaveBeenCalled();
    });

    it('провал сборки возвращает черновик обучалки из APPROVED на одобрение', async () => {
      // Без этого неудачная сборка запирала черновик навсегда: из
      // APPROVED нет выхода ни у кого — `approve`/`reject` требуют
      // PENDING_REVIEW, пользовательский `resume` — REJECTED. Откат
      // был предусмотрен только для синхронного сбоя `submit`, а не
      // для провала, обнаруженного позже на опросе (аудит 27.09.2026).
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: null,
          clientSiteDraftId: 'draft-7',
          frameCount: 2,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({ status: 'failed', error: 'кодек' });

      await service.pollAssemblies();

      expect(prisma.clientSiteTutorialDraft.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Условие по статусу, а не слепой update: между чтением и
          // записью оператор мог сделать что-то ещё.
          where: { id: 'draft-7', status: 'APPROVED' },
          data: expect.objectContaining({ status: 'PENDING_REVIEW' }),
        }),
      );
    });

    it('у регрессионной сборки черновика нет — откатывать нечего', async () => {
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          clientSiteDraftId: null,
          frameCount: 1,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({ status: 'failed', error: 'кодек' });

      await service.pollAssemblies();

      expect(prisma.clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
    });

    it('poll: задача провалилась у внешнего api — помечает failed с причиной, чистит кадры-транзиты', async () => {
      const { service, prisma, blob, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      stubAssets(prisma, [
        {
          id: 'tva-1',
          subjectKey: '1',
          scenarioId: 'ts-1',
          frameCount: 1,
          assemblyJobId: 'job-1',
          assemblyStartedAt: new Date(),
        },
      ]);
      ffmpeg.status.mockResolvedValue({
        status: 'failed',
        error: 'кодек не поддерживается',
      });

      await service.run();

      expect(prisma.tutorialVideoAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assemblyStatus: 'failed',
            assemblyError: 'кодек не поддерживается',
          }),
        }),
      );
      expect(blob.listByPrefix).toHaveBeenCalledWith(
        'tutorial-video-frames/tva-1/',
        expect.anything(),
      );
    });
  });
});
