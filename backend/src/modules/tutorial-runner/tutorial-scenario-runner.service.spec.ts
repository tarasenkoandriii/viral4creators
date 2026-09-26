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
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
  jest.clearAllMocks();
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
      create: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'proj-1' }) },
    productItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }) },
    brandManifest: { findFirst: jest.fn().mockResolvedValue(null) },
    session: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ url: 'https://blob.example.com/frame.jpg' }),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
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
        'tutorial-video-frames/ts-1/0.jpg',
        expect.any(Buffer),
        'image/jpeg',
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
            assemblyStatus: 'pending',
            assemblyJobId: 'job-1',
          }),
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
      const { service, prisma, ffmpeg } = build([SCENARIO_OK]);
      ffmpeg.configured.mockReturnValue(true);
      ffmpeg.submit.mockRejectedValue(new Error('сеть недоступна'));

      const result = await service.run();

      expect(result.passed).toBe(1);
      expect(prisma.tutorialVideoAsset.create).not.toHaveBeenCalled();
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
      expect(blob.deleteBlob).toHaveBeenCalledWith(
        'tutorial-video-frames/ts-1/0.jpg',
      );
      expect(blob.deleteBlob).toHaveBeenCalledWith(
        'tutorial-video-frames/ts-1/1.jpg',
      );
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
      expect(blob.deleteBlob).toHaveBeenCalledWith(
        'tutorial-video-frames/ts-1/0.jpg',
      );
    });
  });
});
