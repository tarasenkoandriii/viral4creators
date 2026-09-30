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
// `resolveChangeSensitivity` — настоящая: проверяется, что переменные
// окружения доходят до `hasChanged`, а не подменённое её поведение.
const computeSnapshotHashMock = jest.fn();
const hasChangedMock = jest.fn();
const diffScoreMock = jest.fn();
jest.mock('./perceptual-hash', () => ({
  computeSnapshotHash: (...args: unknown[]) => computeSnapshotHashMock(...args),
  hasChanged: (...args: unknown[]) => hasChangedMock(...args),
  diffScore: (...args: unknown[]) => diffScoreMock(...args),
  resolveChangeSensitivity:
    jest.requireActual('./perceptual-hash').resolveChangeSensitivity,
}));

import { Logger } from '@nestjs/common';
import {
  FREEZE_MOTION_CSS,
  maskAndFreezeInPage,
  PERSONAL_TEXT_MASK_CSS,
  PERSONAL_TEXT_MASK_PREFIX,
  scrollToSection,
  settleForComparison,
  UiSnapshotRunnerService,
} from './ui-snapshot-runner.service';

const ENV_KEYS = [
  'FIXTURE_TELEGRAM_ID',
  'FIXTURE_USER_TOKEN',
  'TMA_PUBLIC_URL',
  'API_PUBLIC_URL',
  'UI_SNAPSHOT_CELL_DELTA',
  'UI_SNAPSHOT_MIN_CHANGED_CELLS',
];
const envBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) envBefore[key] = process.env[key];
  process.env.FIXTURE_TELEGRAM_ID = 'fixture-1';
  process.env.FIXTURE_USER_TOKEN = 'sekret';
  process.env.TMA_PUBLIC_URL = 'https://app.example.com';
  process.env.API_PUBLIC_URL = 'https://api.example.com/api';
  delete process.env.UI_SNAPSHOT_CELL_DELTA;
  delete process.env.UI_SNAPSHOT_MIN_CHANGED_CELLS;
  computeSnapshotHashMock.mockReturnValue('abc123');
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
  const requestHandlers: Array<(req: unknown) => void> = [];
  return {
    requestHandlers,
    setViewport: jest.fn().mockResolvedValue(undefined),
    // Токен — через перехват и только своему API (этап I ТЗ на
    // озвученную обучалку), а не `setExtraHTTPHeaders` всем подряд.
    setRequestInterception: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, handler: (req: unknown) => void) => {
      if (event === 'request') requestHandlers.push(handler);
    }),
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    close: jest.fn().mockResolvedValue(undefined),
    // Съёмочные шаги (этап I, второй заход) идут через `runScenario`,
    // а он работает Locators API — тем же, что настоящий puppeteer.
    locator: jest.fn(() => ({
      fill: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
    })),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    // Маска личного текста (этап I ТЗ Greeting 2.0) — стилем документа.
    addStyleTag: jest.fn().mockResolvedValue(undefined),
    waitForFunction: jest.fn().mockResolvedValue(undefined),
    // Оседание сравниваемого кадра (разбор «мигания» 30.09.2026).
    waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
  };
}

function build() {
  const notify = { alert: jest.fn().mockResolvedValue(true) };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'usr_fixture' }) },
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: 'proj-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
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

/** Исполняет подкладки `evaluateOnNewDocument` на поддельном
 *  `localStorage` и возвращает получившееся содержимое. */
function seededStorage(page: {
  evaluateOnNewDocument: unknown;
}): Record<string, string> {
  const stored: Record<string, string> = {};
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;
  g.window = {
    localStorage: {
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    },
  };
  try {
    for (const call of (page.evaluateOnNewDocument as jest.Mock).mock.calls) {
      const [fn, ...args] = call as [(...a: unknown[]) => void, ...unknown[]];
      fn(...args);
    }
  } finally {
    if (before === undefined) delete g.window;
    else g.window = before;
  }
  return stored;
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

  it('без API_PUBLIC_URL — пропуск: без него токен ушёл бы сторонним сайтам', async () => {
    delete process.env.API_PUBLIC_URL;
    const { service, prisma } = build();
    const result = await service.run();
    expect(result.skipped).toContain('API_PUBLIC_URL');
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
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    // Пять маршрутов — пять страниц, но фейк один: обработчиков пять.
    const handler = page.requestHandlers[0];
    const headersFor = (url: string) => {
      let sent: Record<string, string> | undefined;
      handler({
        url: () => url,
        headers: () => ({}),
        continue: (o?: { headers?: Record<string, string> }) => {
          sent = o?.headers;
          return Promise.resolve();
        },
      });
      return sent;
    };
    expect(headersFor('https://api.example.com/api/plan')).toEqual({
      'x-fixture-token': 'sekret',
    });
    expect(headersFor('https://fonts.googleapis.com/css2?family=Sora')).toEqual(
      {},
    );
    expect(blob.uploadBuffer).toHaveBeenCalledTimes(5);
    // Сравниваемые снимки — под префиксом, который знает уборка по сроку
    // хранения (`ui-snapshot-retention.ts`): чужой префикс она не трогает,
    // и файлы копились бы вечно.
    for (const [pathname] of blob.uploadBuffer.mock.calls as Array<[string]>) {
      expect(pathname).toMatch(/^qa-snapshots\/[a-z-]+\/ru\/light\/\d+\.png$/);
    }
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

    // Колбэк ИСПОЛНЯЕТСЯ на поддельном хранилище: проверка одних
    // аргументов пропускала опечатку в самом имени ключа (правка
    // аудита этапа C ТЗ TZ-Tutorial-Video-Voiced.md — там та же
    // подкладка, и там мутация ключа выживала).
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
      for (const call of (page.evaluateOnNewDocument as jest.Mock).mock.calls) {
        const [fn, ...args] = call as [(...a: unknown[]) => void, ...unknown[]];
        fn(...args);
      }
    } finally {
      if (windowBefore === undefined) delete g.window;
      else g.window = windowBefore;
    }
    expect(stored).toMatchObject({ v4c_locale: 'uk', v4c_theme: 'dark' });
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

  // Шаги перед съёмкой — этап I, второй заход (27.09.2026). Две
  // карточки лендинга из четырёх это МГНОВЕННЫЕ состояния браузера
  // («ссылка вставлена, но не отправлена»), которых нет в базе. Прогон,
  // открывающий маршрут, снимал вместо них пустую форму — отсюда и
  // родился вывод «нужны руки человека», оказавшийся неверным.
  describe('шаги перед съёмкой', () => {
    const STEPS = [
      {
        kind: 'fill' as const,
        selector: '#site-url',
        value: 'https://viral4creators.app',
      },
      { kind: 'click' as const, selector: '[data-qa="client-site-explore"]' },
    ];

    function withPage() {
      const page = buildFakePage();
      const browser = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      launchHeadlessBrowserMock.mockResolvedValue({ browser });
      return page;
    }

    it('кадр снимается ПОСЛЕ КАЖДОГО шага, плюс итоговый', async () => {
      // Ровно это и делает мгновенные состояния доступными: кадр между
      // `fill` и `click` — и есть «вставили ссылку».
      const page = withPage();
      const { service, blob } = build();
      blob.uploadBuffer
        .mockResolvedValueOnce({ url: 'https://blob/1.png' })
        .mockResolvedValueOnce({ url: 'https://blob/2.png' })
        .mockResolvedValueOnce({ url: 'https://blob/final.png' });

      const result = await service.run({
        routeKeys: ['site-tutorial'],
        unmasked: true,
        deviceScaleFactor: 2,
        steps: STEPS,
      });

      expect(page.locator).toHaveBeenCalledWith('#site-url');
      expect(page.locator).toHaveBeenCalledWith(
        '[data-qa="client-site-explore"]',
      );
      expect(result.outcomes[0].stepsDone).toBe(2);
      // Каждый кадр несёт номер СВОЕГО шага, а итоговый кадр всей
      // страницы сюда не попадает — он в `blobUrl`.
      expect(result.outcomes[0].shots).toEqual([
        { stepIndex: 0, url: 'https://blob/1.png' },
        { stepIndex: 1, url: 'https://blob/2.png' },
      ]);
      expect(result.outcomes[0].blobUrl).toBe('https://blob/final.png');
    });

    it('пропавший кадр не сдвигает остальные — ни в именах, ни в привязке', async () => {
      // Этап A ТЗ `TZ-Tutorial-Video-Voiced.md` и правка его аудита.
      // Скриншот снимается best-effort: единичный сбой (страница в
      // переходном состоянии, гонка CDP) глотается, чтобы не ронять
      // прогон. Потребитель берёт кадр ПО НОМЕРУ ШАГА
      // (`CARD_BY_STEP_INDEX`), и если бы номер выводился из позиции
      // в массиве, карточка лендинга подписалась бы чужим экраном —
      // молча, правдоподобным кадром соседнего шага.
      const page = withPage();
      page.screenshot
        .mockRejectedValueOnce(new Error('CDP занят'))
        .mockResolvedValue(new Uint8Array([1, 2, 3]));
      const { service, blob } = build();
      blob.uploadBuffer.mockResolvedValue({ url: 'https://blob/2.png' });

      const result = await service.run({
        routeKeys: ['site-tutorial'],
        unmasked: true,
        steps: STEPS,
      });

      // Уцелел кадр ВТОРОГО шага, и он это про себя знает.
      expect(result.outcomes[0].shots).toEqual([
        { stepIndex: 1, url: 'https://blob/2.png' },
      ]);
      const stepShots = blob.uploadBuffer.mock.calls
        .map(([pathname]: [string]) => pathname)
        .filter((n: string) => /^qa-shots\//.test(n));
      // В имени файла — тоже второй, а не первый (там номер 1-based).
      expect(stepShots.some((n: string) => /-2\.png$/.test(n))).toBe(true);
      expect(stepShots.some((n: string) => /-1\.png$/.test(n))).toBe(false);
    });

    it('без шагов ни shots, ни stepsDone не появляются', async () => {
      // Прогон крона не должен получить новых полей ни на байт.
      withPage();
      const { service } = build();

      const result = await service.run({
        routeKeys: ['projects'],
        unmasked: true,
      });

      expect(result.outcomes[0].shots).toBeUndefined();
      expect(result.outcomes[0].stepsDone).toBeUndefined();
    });

    it('шаги без unmasked отвергаются — шаги меняют состояние продукта', async () => {
      // Запрет строже, чем у плотности: сравниваемый прогон обязан
      // быть наблюдателем, а шаги создают черновики и шлют формы.
      withPage();
      const { service } = build();

      await expect(
        service.run({ routeKeys: ['site-tutorial'], steps: STEPS }),
      ).rejects.toThrow(/unmasked/);
    });

    it('шаги при нескольких маршрутах отвергаются', async () => {
      withPage();
      const { service } = build();

      await expect(
        service.run({ unmasked: true, steps: STEPS }),
      ).rejects.toThrow(/routeKeys/);
    });

    it('шаг упал — кадры до обрыва отдаются вместе с причиной', async () => {
      // Выбросить уже снятое было бы расточительством: кадры до обрыва
      // годные, а оператору нужны и они, и причина.
      const page = withPage();
      page.locator.mockImplementation(() => ({
        fill: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockRejectedValue(new Error('кнопка не нашлась')),
      }));
      const { service, blob } = build();
      blob.uploadBuffer.mockResolvedValue({ url: 'https://blob/1.png' });

      const result = await service.run({
        routeKeys: ['site-tutorial'],
        unmasked: true,
        steps: STEPS,
      });

      expect(result.outcomes[0].error).toMatch(/кнопка не нашлась/);
      expect(result.outcomes[0].stepsDone).toBe(1);
      expect(result.outcomes[0].shots).toEqual([
        { stepIndex: 0, url: 'https://blob/1.png' },
      ]);
      // У оборванного прогона итогового кадра нет — `blobUrl`
      // указывает на последний снятый шаговый.
      expect(result.outcomes[0].blobUrl).toBe('https://blob/1.png');
      expect(result.failed).toBe(1);
    });
  });

  it('плотность пикселей по умолчанию 1 — крон снимает ровно то же, что снимал', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service } = build();

    await service.run({ routeKeys: ['projects'] });

    expect(page.setViewport).toHaveBeenCalledWith({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
    });
  });

  it('deviceScaleFactor: 2 доезжает до вьюпорта, а не теряется по дороге', async () => {
    // Находка прода (этап I): прогон отдавал 390×844 растровых, а
    // лендингу нужен кадр шириной 780. Растянуть постобработкой значит
    // подделать резкость — скрипт обработки такой вход отклоняет.
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service } = build();

    await service.run({
      routeKeys: ['projects'],
      unmasked: true,
      deviceScaleFactor: 2,
    });

    expect(page.setViewport).toHaveBeenCalledWith({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
    });
  });

  it('плотность больше 1 без unmasked отвергается — иначе подменит базовый отпечаток крона', async () => {
    // Размер кадра входит в отпечаток. Маскированный прогон плотностью
    // 2 записал бы строку, не сравнимую ни с одной прежней, и
    // следующий тик крона честно закричал бы «изменилось». Отвергаем, а
    // не исправляем молча: молчаливое исправление вернуло бы оператору
    // кадр 390px, который он заметит только на шаге обработки.
    const { service, prisma } = build();

    await expect(
      service.run({ routeKeys: ['projects'], deviceScaleFactor: 2 }),
    ).rejects.toThrow(/unmasked/);
    expect(launchHeadlessBrowserMock).not.toHaveBeenCalled();
    expect(prisma.uiSnapshot.create).not.toHaveBeenCalled();
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

  it('в diffHash пишется составной отпечаток целиком — иначе следующей ночи не с чем сравнить сетку', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build();
    const composite = '0123456789abcdef:g1x1:ff';
    computeSnapshotHashMock.mockReturnValue(composite);

    await service.run();

    expect(prisma.uiSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ diffHash: composite }),
      }),
    );
  });

  it('чувствительность из окружения доходит до hasChanged и diffScore', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build();
    prisma.uiSnapshot.findFirst.mockResolvedValue({
      blobUrl: 'https://blob.example.com/prev.png',
      diffHash: 'prevhash',
    });
    process.env.UI_SNAPSHOT_CELL_DELTA = '20';
    process.env.UI_SNAPSHOT_MIN_CHANGED_CELLS = '6';

    await service.run();

    const expected = { cellDelta: 20, minChangedCells: 6 };
    expect(hasChangedMock).toHaveBeenCalledWith('abc123', 'prevhash', expected);
    expect(diffScoreMock).toHaveBeenCalledWith('abc123', 'prevhash', expected);
  });

  it('неверная чувствительность — умолчание и предупреждение в лог, обход не падает', async () => {
    const page = buildFakePage();
    const browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    launchHeadlessBrowserMock.mockResolvedValue({ browser });
    const { service, prisma } = build();
    prisma.uiSnapshot.findFirst.mockResolvedValue({
      blobUrl: 'https://blob.example.com/prev.png',
      diffHash: 'prevhash',
    });
    process.env.UI_SNAPSHOT_MIN_CHANGED_CELLS = 'три';
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await service.run();

    expect(result.failed).toBe(0);
    expect(hasChangedMock).toHaveBeenCalledWith('abc123', 'prevhash', {
      cellDelta: 12,
      minChangedCells: 3,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('UI_SNAPSHOT_MIN_CHANGED_CELLS'),
    );
    warn.mockRestore();
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

    // Ключ хранилища сверяется ИСПОЛНЕНИЕМ колбэка, а не списком
    // аргументов: список пропускал опечатку в самом ключе, а с общей
    // константой `SPA_SESSION_STORAGE_KEY` (29.09.2026) пропустил бы и
    // подмену её литералом.
    expect(seededStorage(page).sessionId).toBe('qa-session');
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
    expect(seededStorage(page).sessionId).toBe('new-qa');
  });
});

/**
 * Этап I ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`
 * (§5.3): кадры мастера поздравлений. Три вещи, каждая из которых
 * ломается молча — кадр снимется, просто не тот.
 */
describe('UiSnapshotRunnerService — кадры мастера поздравлений', () => {
  function withPage() {
    const page = buildFakePage();
    const calls: string[] = [];
    page.addStyleTag.mockImplementation(async () => {
      calls.push('style');
    });
    page.waitForSelector.mockImplementation(async () => {
      calls.push('wait');
    });
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
    return { page, calls };
  }

  it('личный текст скрыт и в немаскированном прогоне — стилем до съёмки', async () => {
    // Немаскированный прогон открывает переменные зоны (кадр сайта,
    // постер ролика) — но не имена: выдуманное имя на маркетинговом
    // кадре запрещено правилом §5.5 образца.
    const { page, calls } = withPage();
    const { service } = build();

    await service.run({ routeKeys: ['projects'], unmasked: true });

    expect(page.addStyleTag).toHaveBeenCalledWith({
      content: PERSONAL_TEXT_MASK_CSS,
    });
    expect(calls.indexOf('style')).toBeLessThan(calls.indexOf('screenshot'));
  });

  it('…и в маскированном тоже: личное не показывается никому', async () => {
    const { page } = withPage();
    const { service } = build();

    await service.run({ routeKeys: ['projects'] });

    expect(page.addStyleTag).toHaveBeenCalledTimes(1);
  });

  it('маска цепляется за префикс и размывает, а не прячет поле целиком', () => {
    expect(PERSONAL_TEXT_MASK_PREFIX).toBe('personal-');
    expect(PERSONAL_TEXT_MASK_CSS).toContain(
      '[data-qa-mask^="personal-"]{color:transparent',
    );
    expect(PERSONAL_TEXT_MASK_CSS).toContain('text-shadow');
    // `visibility: hidden` убрал бы и рамку поля — на кадре осталась бы
    // дыра посреди формы.
    expect(PERSONAL_TEXT_MASK_CSS).not.toContain('visibility');
    // Плейсхолдер скрыт вместе с текстом (наследует прозрачную заливку):
    // у титров он собран из брифа с именем получателя. Ни одного правила,
    // которое вернуло бы ему видимость, быть не должно.
    expect(PERSONAL_TEXT_MASK_CSS).not.toMatch(/placeholder/);
    expect(PERSONAL_TEXT_MASK_CSS.match(/\{[^}]*\}/g)).toHaveLength(1);
  });

  it('scrollTo без unmasked — отказ: прокрученный кадр подменил бы отпечаток крона', async () => {
    const { service } = build();
    await expect(
      service.run({ routeKeys: ['projects'], scrollTo: '#x' }),
    ).rejects.toThrow('scrollTo допустим только вместе с unmasked');
    await expect(
      service.run({
        routeKeys: ['projects', 'postprod'],
        unmasked: true,
        scrollTo: '#x',
      }),
    ).rejects.toThrow('ровно одного маршрута');
  });

  it('scrollTo: ждёт секцию и прокручивает ДО снимка', async () => {
    const { page, calls } = withPage();
    const { service } = build();

    const result = await service.run({
      routeKeys: ['projects'],
      unmasked: true,
      scrollTo: '[data-qa="greeting-script-card"]',
    });

    expect(page.waitForSelector).toHaveBeenCalledWith(
      '[data-qa="greeting-script-card"]',
      expect.objectContaining({ visible: true }),
    );
    expect(calls).toEqual(['style', 'wait', 'evaluate', 'screenshot']);
    expect(result.outcomes[0].blobUrl).toBeTruthy();
  });

  it('секция не нашлась — ошибка маршрута, а не кадр верха страницы под чужой подписью', async () => {
    const { page } = withPage();
    page.waitForSelector.mockRejectedValue(new Error('Waiting failed'));
    const { service, blob } = build();

    const result = await service.run({
      routeKeys: ['projects'],
      unmasked: true,
      scrollTo: '[data-qa="greeting-video-card"]',
    });

    expect(result.outcomes[0].error).toContain('Waiting failed');
    expect(result.outcomes[0].blobUrl).toBeUndefined();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
  });

  it('резолвер знает проекты-поздравления — до этапа I их здесь не было вовсе', async () => {
    const { prisma, service } = build();
    prisma.project.findMany.mockResolvedValue([
      {
        id: 'g-done',
        sessions: [
          { status: 'prompt_generated', generationStatus: 'complete' },
        ],
      },
      {
        id: 'g-ready',
        sessions: [{ status: 'prompt_generated', generationStatus: null }],
      },
      { id: 'g-fresh', sessions: [] },
    ]);

    const ctx = await service.resolveFixtureContext('usr_fixture');

    expect(ctx).toMatchObject({
      greetingProjectId: 'g-fresh',
      greetingReadyProjectId: 'g-ready',
      greetingDoneProjectId: 'g-done',
    });
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: 'GREETING_VIDEO' }),
      }),
    );
  });
});

describe('scrollToSection — расчёт в браузере', () => {
  /** Исполняет колбэк `evaluate` на поддельном документе. */
  function runInFakeDom(opts: { headerBottom: number; sticky: boolean }) {
    const scrolls: Array<{ top: number; behavior: string }> = [];
    const video = {
      currentSrc: 'https://blob/v.mp4',
      getAttribute: () => 'https://blob/v.mp4',
      preload: '',
      currentTime: 0,
      duration: 6,
      readyState: 1,
      addEventListener: jest.fn(),
    };
    const g = globalThis as any;
    const before = { document: g.document, window: g.window };
    g.document = {
      querySelector: () => ({
        getBoundingClientRect: () => ({ top: 500 }),
      }),
      querySelectorAll: (sel: string) =>
        sel === 'header'
          ? [{ getBoundingClientRect: () => ({ bottom: opts.headerBottom }) }]
          : [video],
    };
    g.window = {
      scrollY: 100,
      getComputedStyle: () => ({
        position: opts.sticky ? 'sticky' : 'static',
      }),
      scrollTo: (arg: { top: number; behavior: string }) => scrolls.push(arg),
    };
    return {
      scrolls,
      video,
      restore: () => {
        g.document = before.document;
        g.window = before.window;
      },
    };
  }

  function fakePage() {
    return {
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn(async (fn: (sel: string) => void, sel: string) =>
        fn(sel),
      ),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('секция встаёт под липкую шапку, мгновенно, а ролик просят загрузить', async () => {
    const dom = runInFakeDom({ headerBottom: 56, sticky: true });
    try {
      const page = fakePage();
      await scrollToSection(page, '#s');
      // 500 (секция в окне) + 100 (уже прокручено) − 56 (шапка) − 8.
      expect(dom.scrolls).toEqual([{ top: 536, behavior: 'instant' }]);
      expect(dom.video.preload).toBe('auto');
      // Первый кадр сгенерированного ролика часто затемнён — встаём на
      // секунду вперёд.
      expect(dom.video.currentTime).toBe(1);
      expect(page.waitForFunction).toHaveBeenCalled();
    } finally {
      dom.restore();
    }
  });

  it('нелипкая шапка не сдвигает секцию', async () => {
    const dom = runInFakeDom({ headerBottom: 56, sticky: false });
    try {
      await scrollToSection(fakePage(), '#s');
      expect(dom.scrolls[0].top).toBe(592);
    } finally {
      dom.restore();
    }
  });

  it('ролик так и не загрузился — кадр всё равно снимается (best-effort)', async () => {
    const dom = runInFakeDom({ headerBottom: 0, sticky: false });
    try {
      const page = fakePage();
      page.waitForFunction.mockRejectedValue(new Error('timeout'));
      await expect(scrollToSection(page, '#s')).resolves.toBeUndefined();
    } finally {
      dom.restore();
    }
  });
});

/**
 * Разбор «мигания» крона 30.09.2026: `changed=1` парами через две
 * минуты в случайные минуты часа. Кадр зависел от того, КОГДА он снят
 * (фаза бесконечной анимации знака в шапке, недогруженные запросы при
 * `networkidle2`), а не от того, что на экране.
 */
describe('UiSnapshotRunnerService — кадр не зависит от момента съёмки', () => {
  function withPage() {
    const page = buildFakePage();
    const calls: string[] = [];
    page.waitForNetworkIdle.mockImplementation(async () => {
      calls.push('idle');
    });
    page.waitForFunction.mockImplementation(async () => {
      calls.push('ready');
    });
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
    return { page, calls };
  }

  it('сравниваемый прогон: оседание → маска с заморозкой → снимок', async () => {
    const { page, calls } = withPage();
    const { service } = build();

    await service.run({ routeKeys: ['projects'] });

    expect(calls).toEqual(['idle', 'ready', 'evaluate', 'screenshot']);
    // Полное затишье сети — не `networkidle2` с двумя запросами в полёте.
    expect(page.waitForNetworkIdle).toHaveBeenCalledWith(
      expect.objectContaining({ idleTime: expect.any(Number) }),
    );
    expect(
      (page.waitForNetworkIdle.mock.calls[0] as unknown[])[0],
    ).not.toHaveProperty('concurrency');
    expect(page.evaluate).toHaveBeenCalledWith(
      maskAndFreezeInPage,
      FREEZE_MOTION_CSS,
    );
  });

  it('экран не осел — кадр всё равно снимается и сравнивается, без ошибки маршрута', async () => {
    const { page } = withPage();
    page.waitForNetworkIdle.mockRejectedValue(new Error('timeout'));
    page.waitForFunction.mockRejectedValue(new Error('timeout'));
    const { service, prisma } = build();

    const result = await service.run({ routeKeys: ['projects'] });

    expect(result.outcomes[0].error).toBeUndefined();
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(prisma.uiSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ diffHash: 'abc123' }),
      }),
    );
  });

  it('немаскированный прогон не ждёт оседания и не замораживает — его кадры не меняются', async () => {
    const { page } = withPage();
    const { service } = build();

    await service.run({ routeKeys: ['projects'], unmasked: true });

    expect(page.waitForNetworkIdle).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('заморозка — на весь документ, включая псевдоэлементы, и снимает и анимации, и переходы', () => {
    expect(FREEZE_MOTION_CSS).toMatch(/^\*,\*::before,\*::after\{/);
    expect(FREEZE_MOTION_CSS).toContain('animation:none!important');
    expect(FREEZE_MOTION_CSS).toContain('transition:none!important');
    // Не прячет ничего: только движение. Маскирование — отдельно.
    expect(FREEZE_MOTION_CSS).not.toContain('visibility');
    expect(FREEZE_MOTION_CSS).not.toContain('display');
  });

  it('в странице: маски прячутся, стиль заморозки попадает в документ', () => {
    const masked = [
      { style: { visibility: '' } },
      { style: { visibility: '' } },
    ];
    const appended: Array<{
      textContent: string;
      attrs: Record<string, string>;
    }> = [];
    const g = globalThis as any;
    const before = g.document;
    g.document = {
      querySelectorAll: (sel: string) =>
        sel === '[data-qa-mask]' ? masked : [],
      createElement: () => {
        const attrs: Record<string, string> = {};
        return {
          attrs,
          textContent: '',
          setAttribute: (k: string, v: string) => {
            attrs[k] = v;
          },
        };
      },
      head: {
        appendChild: (el: any) => appended.push(el),
      },
    };
    try {
      maskAndFreezeInPage(FREEZE_MOTION_CSS);
    } finally {
      g.document = before;
    }
    expect(masked.map((m) => m.style.visibility)).toEqual(['hidden', 'hidden']);
    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toBe(FREEZE_MOTION_CSS);
    expect(appended[0].attrs).toHaveProperty('data-qa-freeze');
  });

  it('условие готовности: шрифты загружены и ни одного спиннера', async () => {
    const g = globalThis as any;
    const before = g.document;
    const page = {
      waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
    };
    await settleForComparison(page);
    const ready = page.waitForFunction.mock.calls[0][0] as () => boolean;
    try {
      g.document = { fonts: { status: 'loading' }, querySelector: () => null };
      expect(ready()).toBe(false);
      g.document = { fonts: { status: 'loaded' }, querySelector: () => ({}) };
      expect(ready()).toBe(false);
      g.document = {
        fonts: { status: 'loaded' },
        querySelector: (sel: string) => (sel === '.animate-spin' ? null : {}),
      };
      expect(ready()).toBe(true);
    } finally {
      g.document = before;
    }
  });
});
