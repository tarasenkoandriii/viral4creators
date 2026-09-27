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
      update: jest.fn().mockResolvedValue(undefined),
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
  const service = new TutorialScenarioRunnerService(
    prisma as any,
    notify as any,
    blob as any,
    ffmpeg as any,
  );
  return { service, prisma, notify, blob, ffmpeg };
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
      'tutorial-scenario-run:2',
      expect.stringContaining('провалился'),
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
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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
        .mockImplementation((frames, outputName) => {
          const plan = real(frames, outputName);
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
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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

    // Находка Д-2: отдельный вход для частого крона. Он обязан
    // опрашивать сборки и обязан НЕ открывать браузер.
    it('pollAssemblies: опрашивает сборки, не запуская headless-браузер', async () => {
      const { service, prisma, ffmpeg } = build([]);
      ffmpeg.configured.mockReturnValue(true);
      prisma.tutorialVideoAsset.count.mockResolvedValue(2);
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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
      expect(result).toEqual({ polled: 1, pending: 2 });
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
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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
      prisma.tutorialVideoAsset.findMany.mockResolvedValue([
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
