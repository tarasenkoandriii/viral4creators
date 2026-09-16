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
});
