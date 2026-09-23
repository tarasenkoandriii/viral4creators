/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `PlanService` попадает сюда как тип-в-рантайме (метаданные DI) и тянет
// за собой сгенерированный клиент Prisma, которого в CI/песочнице нет —
// тот же приём, что в brand-manifest.service.spec.ts.
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
}));

// Настоящая `assertPubliclyRoutableUrl` делает РЕАЛЬНЫЙ dns.lookup — в CI
// и в песочнице сети нет, и любой `shop.example.com` падал бы как
// «непубличный». Подменяем только её (класс ошибки берём настоящий,
// чтобы проверялось именно то преобразование в 400, которое делает
// сервис); сама логика диапазонов адресов покрыта отдельно в
// `external-url-guard.spec.ts`.
/**
 * Поведение по умолчанию вынесено в переменную (имя с префикса `mock` —
 * единственное, что jest разрешает использовать внутри фабрики мока),
 * чтобы его можно было ВЕРНУТЬ в `beforeEach`.
 *
 * Без этого возврата тест, добавивший `mockImplementationOnce`, но не
 * израсходовавший очередь, отравлял следующий: заготовка срабатывала уже
 * в чужом тесте. Ровно это и случилось при мутационной проверке — одна
 * поломка кода уронила две проверки, из которых вторая к ней отношения
 * не имела.
 */
const mockRoutableDefault = async (raw: string): Promise<void> => {
  const actual = jest.requireActual('../../common/external-url-guard');
  const host = new URL(raw).hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(host)) {
    throw new actual.UnsafeExternalUrlError(
      `адрес ${host} не является публично маршрутизируемым`,
    );
  }
};

jest.mock('../../common/external-url-guard', () => {
  const actual = jest.requireActual('../../common/external-url-guard');
  return {
    ...actual,
    assertPubliclyRoutableUrl: jest.fn(mockRoutableDefault),
  };
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ClientSiteTutorialService,
  pickLoginProofSelector,
} from './client-site-tutorial.service';
import { RelaySessionGoneError } from './live-login-relay.client';
import { issueLiveTicket } from './live-login-ticket';
import { PageExplorer } from './page-explorer';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PlanService } from '../plan/plan.service';
import type { ClientSiteTutorialUsageService } from './client-site-tutorial-usage.service';
import type { BlobService } from '../storage/blob.service';
import type { LiveLoginRelayClient } from './live-login-relay.client';

/**
 * Проверяется ОРКЕСТРАЦИЯ раунда, без БД и без браузера: порядок
 * проверок, оптимистичная блокировка, возврат слота лимита при неудаче,
 * доменный замок после редиректа и то, что секреты не уезжают наружу.
 * Именно здесь живут ошибки, которые ни один тип не поймает.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');

const EXPLORATION = {
  currentUrl: 'https://shop.example.com/cabinet',
  screenshotDataUrl: 'data:image/jpeg;base64,кадр',
  elements: [],
  looksLikeLogin: false,
};

function makeDraftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft1',
    projectId: 'proj1',
    baseUrl: 'https://shop.example.com',
    steps: [{ kind: 'goto', route: 'https://shop.example.com' }],
    stepsPerRound: [1],
    roundScreenshots: ['кадр-1'],
    lastUrl: 'https://shop.example.com',
    cookiesEnc: null,
    credentialsEnc: null,
    requiresLiveLoginReplay: false,
    status: 'DRAFTING',
    title: null,
    rejectionReason: null,
    previewFrameCount: null,
    version: 3,
    ...over,
  };
}

function setup(
  opts: {
    project?: unknown;
    draft?: unknown;
    planAllows?: boolean;
    reserveOk?: boolean;
    explorer?: Partial<PageExplorer>;
    updateCount?: number;
    existingFrames?: Array<{ pathname: string; uploadedAt: Date }>;
    relayConfigured?: boolean;
    relay?: Record<string, unknown>;
    usageLiveOk?: boolean;
    /** Строка `TutorialVideoAsset`, которую вернёт поиск по
     * `clientSiteDraftId` (находка Б-4 аудита лендинга). `null` —
     * ролика ещё нет. */
    videoAsset?: unknown;
  } = {},
) {
  const draftRow = opts.draft === undefined ? makeDraftRow() : opts.draft;
  const clientSiteTutorialDraft = {
    findUnique: jest.fn().mockResolvedValue(draftRow),
    create: jest
      .fn()
      .mockImplementation(({ data }: any) =>
        Promise.resolve(makeDraftRow({ ...data, version: 0 })),
      ),
    updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma = {
    project: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.project === undefined
            ? { id: 'proj1', type: 'CLIENT_SITE' }
            : opts.project,
        ),
    },
    clientSiteTutorialDraft,
    tutorialVideoAsset: {
      findFirst: jest.fn().mockResolvedValue(opts.videoAsset ?? null),
    },
  } as unknown as PrismaService;

  const plans = {
    assertUser: jest.fn().mockImplementation(() => {
      if (opts.planAllows === false) {
        return Promise.reject(new ForbiddenException('тариф не позволяет'));
      }
      return Promise.resolve();
    }),
  } as unknown as PlanService;

  const usage = {
    reserveRound: jest.fn().mockResolvedValue(opts.reserveOk ?? true),
    releaseRound: jest.fn().mockResolvedValue(undefined),
    reserveLiveSession: jest.fn().mockResolvedValue(opts.usageLiveOk ?? true),
    releaseLiveSession: jest.fn().mockResolvedValue(undefined),
    roundsLimit: 60,
    liveSessionsLimit: 10,
  } as unknown as ClientSiteTutorialUsageService;

  const explorer: PageExplorer = {
    runRound: jest
      .fn()
      .mockResolvedValue({ exploration: EXPLORATION, cookies: [] }),
    replay: jest
      .fn()
      .mockResolvedValue({ exploration: EXPLORATION, cookies: [] }),
    ...opts.explorer,
  };

  const blob = {
    uploadBuffer: jest
      .fn()
      .mockImplementation((pathname: string) =>
        Promise.resolve({ url: `https://blob.example/${pathname}` }),
      ),
    listByPrefix: jest
      .fn()
      .mockResolvedValue({ blobs: opts.existingFrames ?? [], cursor: null }),
    deleteMany: jest.fn().mockResolvedValue(0),
  } as unknown as BlobService;

  const relay = {
    configured: jest.fn(() => opts.relayConfigured ?? true),
    createSession: jest.fn().mockResolvedValue({
      sessionId: 'relay-1',
      streamToken: 'tok',
      relayWsUrl: 'wss://relay.example/sessions/relay-1/stream',
    }),
    fetchResult: jest.fn().mockResolvedValue({
      cookies: [],
      finalUrl: 'https://shop.example.com/cabinet',
    }),
    cancelQuietly: jest.fn().mockResolvedValue(undefined),
    ...opts.relay,
  } as unknown as LiveLoginRelayClient;

  const service = new ClientSiteTutorialService(
    prisma,
    plans,
    usage,
    blob,
    relay,
    explorer,
  );
  return {
    service,
    prisma,
    plans,
    usage,
    blob,
    relay,
    explorer,
    clientSiteTutorialDraft,
  };
}

/** Мок SSRF-проверки, каким его видят тесты. */
function routableGuard(): {
  assertPubliclyRoutableUrl: jest.Mock;
  UnsafeExternalUrlError: new (m: string) => Error;
} {
  return jest.requireMock('../../common/external-url-guard');
}

beforeEach(() => {
  process.env.SITE_TUTORIAL_TOKEN_KEY = KEY;
  // Счётчик и очередь заготовок — общие на весь файл; сбрасываем, чтобы
  // тесты не зависели от порядка (см. комментарий у mockRoutableDefault).
  routableGuard().assertPubliclyRoutableUrl.mockReset();
  routableGuard().assertPubliclyRoutableUrl.mockImplementation(
    mockRoutableDefault,
  );
});

describe('владение проектом и тип проекта', () => {
  it('чужой проект — 404, а не 403 (как и везде в проекте)', async () => {
    const { service } = setup({ project: null });
    await expect(service.getState('user1', 'proj1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('проект не того типа — понятный отказ, а не непонятная ошибка ниже', async () => {
    const { service } = setup({ project: { id: 'proj1', type: 'SINGLE' } });
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('владение проверяется ДО тарифа — чужой проект не должен даже сообщать, что фича платная', async () => {
    const { service, plans } = setup({ project: null });
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(plans.assertUser).not.toHaveBeenCalled();
  });
});

describe('/explore', () => {
  it('фиксирует origin, а не полный URL, и создаёт первый раунд', async () => {
    const { service, clientSiteTutorialDraft } = setup({ draft: null });

    const result = await service.explore(
      'user1',
      'proj1',
      'https://shop.example.com/login?next=/cabinet',
    );

    const data = clientSiteTutorialDraft.create.mock.calls[0][0].data;
    expect(data.baseUrl).toBe('https://shop.example.com');
    expect(data.stepsPerRound).toEqual([1]);
    expect(data.roundScreenshots).toEqual([EXPLORATION.screenshotDataUrl]);
    expect(result.exploration).toEqual(EXPLORATION);
  });

  it('второй /explore на тот же проект — 409, а не перезапись чужой работы', async () => {
    const { service } = setup();
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('непубличный адрес отклоняется до запуска браузера (§8.2)', async () => {
    const { service, explorer } = setup({ draft: null });
    await expect(
      service.explore('user1', 'proj1', 'http://127.0.0.1:8080/admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(explorer.runRound).not.toHaveBeenCalled();
  });

  it('редирект на поддомен того же сайта — РАЗРЕШЁН (Т-4: shop. → accounts.)', async () => {
    const { service } = setup({
      draft: null,
      explorer: {
        runRound: jest.fn().mockResolvedValue({
          exploration: {
            ...EXPLORATION,
            currentUrl: 'https://accounts.example.com/login',
          },
          cookies: [],
        }),
      },
    });
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).resolves.toBeDefined();
  });

  it('редирект на СОСЕДНИЙ поддомен проверяется на публичность заново (§8.2 после Т-4)', async () => {
    // Пока замок сравнивал origin точно, такой редирект отклонялся сам
    // собой и адрес до проверки §8.2 не доходил. Расширение замка
    // открыло бы путь `internal.example.com` → 10.0.0.5, если бы
    // проверка не повторялась для нового хоста.
    const { service, explorer } = setup({
      draft: null,
      explorer: {
        runRound: jest.fn().mockResolvedValue({
          exploration: {
            ...EXPLORATION,
            currentUrl: 'https://internal.example.com/admin',
          },
          cookies: [],
        }),
      },
    });
    const guard = routableGuard();
    guard.assertPubliclyRoutableUrl.mockImplementationOnce(async () => {
      // первый вызов — сам `https://shop.example.com`, он публичен
    });
    guard.assertPubliclyRoutableUrl.mockImplementationOnce(async () => {
      throw new guard.UnsafeExternalUrlError('10.0.0.5 не публичен');
    });

    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(explorer.runRound).toHaveBeenCalled();
  });

  it('тот же хост после перехода — повторной проверки §8.2 не делаем', async () => {
    // Обычный случай: один лишний резолв DNS на КАЖДЫЙ раунд — это
    // плата, которой быть не должно, когда хост не менялся.
    const { service } = setup({ draft: null });
    const guard = routableGuard();

    await service.explore('user1', 'proj1', 'https://shop.example.com');

    expect(guard.assertPubliclyRoutableUrl).toHaveBeenCalledTimes(1);
  });

  it('редирект за пределы сайта заказчика — отказ (§8.1, проверка ПОСЛЕ перехода)', async () => {
    const { service } = setup({
      draft: null,
      explorer: {
        runRound: jest.fn().mockResolvedValue({
          exploration: {
            ...EXPLORATION,
            currentUrl: 'https://evil.example.net/phish',
          },
          cookies: [],
        }),
      },
    });
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('лимиты (§9)', () => {
  it('исчерпанный дневной лимит — отказ до запуска браузера', async () => {
    const { service, explorer } = setup({ draft: null, reserveOk: false });
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(explorer.runRound).not.toHaveBeenCalled();
  });

  it('слот возвращается, если раунд не состоялся — иначе сбой сайта заказчика съедал бы квоту', async () => {
    const { service, usage } = setup({
      draft: null,
      explorer: {
        runRound: jest.fn().mockRejectedValue(new Error('браузер не поднялся')),
      },
    });
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toThrow('браузер не поднялся');
    expect(usage.releaseRound).toHaveBeenCalledWith('user1');
  });
});

describe('/step и оптимистичная блокировка', () => {
  it('раунд из двух полей и кнопки — три шага и ОДИН кадр', async () => {
    const { service, clientSiteTutorialDraft } = setup();

    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [
        { selector: '#email', value: 'a@b.c' },
        { selector: '#pass', value: 'секрет' },
      ],
      clickSelector: '#submit',
    });

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.stepsPerRound).toEqual([1, 3]);
    expect(data.roundScreenshots).toHaveLength(2);
    expect(data.version).toEqual({ increment: 1 });
  });

  it('устаревшая версия — 409 «черновик изменился в другой вкладке»', async () => {
    const { service } = setup({ updateCount: 0 });
    await expect(
      service.step('user1', 'proj1', {
        expectedVersion: 1,
        fills: [{ selector: '#a', value: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('версия из запроса идёт прямо в WHERE, а не берётся из прочитанной строки', async () => {
    const { service, clientSiteTutorialDraft } = setup();
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [{ selector: '#a', value: 'x' }],
    });
    expect(
      clientSiteTutorialDraft.updateMany.mock.calls[0][0].where,
    ).toMatchObject({ id: 'draft1', version: 3, status: 'DRAFTING' });
  });

  it('пустой раунд отклоняется', async () => {
    const { service } = setup();
    await expect(
      service.step('user1', 'proj1', { expectedVersion: 3, fills: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('черновик не в DRAFTING редактировать нельзя (§14 п.2)', async () => {
    const { service } = setup({
      draft: makeDraftRow({ status: 'PENDING_REVIEW' }),
    });
    await expect(
      service.step('user1', 'proj1', {
        expectedVersion: 3,
        fills: [{ selector: '#a', value: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('/login и секреты', () => {
  it('значение секретного поля НЕ попадает в шаги сценария', async () => {
    const { service, clientSiteTutorialDraft } = setup();

    await service.login('user1', 'proj1', {
      expectedVersion: 3,
      submitSelector: '#submit',
      fields: [
        { selector: '#email', value: 'a@b.c', sensitive: false },
        { selector: '#pass', value: 'очень-секретный-пароль', sensitive: true },
      ],
    });

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    const asJson = JSON.stringify(data.steps);
    // Пароль виден оператору при модерации сценария — значит в steps его
    // быть не должно вообще, даже «на всякий случай».
    expect(asJson).not.toContain('очень-секретный-пароль');
    expect(asJson).toContain('a@b.c');
    // А в браузер он при этом ушёл — иначе форма не заполнится.
    expect(data.credentialsEnc).toEqual(expect.any(String));
    expect(data.credentialsEnc).not.toContain('очень-секретный-пароль');
  });

  it('форма без полей отклоняется', async () => {
    const { service } = setup();
    await expect(
      service.login('user1', 'proj1', {
        expectedVersion: 3,
        submitSelector: '#submit',
        fields: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('состояние и возврат в работу', () => {
  it('наружу не уходят ни куки, ни креды — даже зашифрованными', async () => {
    const { service } = setup({
      draft: makeDraftRow({
        cookiesEnc: 'шифр-куки',
        credentialsEnc: 'шифр-креды',
      }),
    });
    const view = (await service.getState('user1', 'proj1'))!;
    expect(JSON.stringify(view)).not.toContain('шифр-куки');
    expect(JSON.stringify(view)).not.toContain('шифр-креды');
    // Но факт наличия кред фронтенду знать полезно.
    expect(view.hasCredentials).toBe(true);
  });

  it('черновика нет — null, а не 404 (экран визарда сам решит, что показать)', async () => {
    const { service } = setup({ draft: null });
    await expect(service.getState('user1', 'proj1')).resolves.toBeNull();
  });

  it('/resume работает только для отклонённого черновика', async () => {
    const { service } = setup();
    await expect(service.resume('user1', 'proj1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('/resume возвращает REJECTED в работу и чистит причину отказа', async () => {
    const rejected = makeDraftRow({
      status: 'REJECTED',
      rejectionReason: 'не то',
    });
    const { service, clientSiteTutorialDraft } = setup({ draft: rejected });
    await service.resume('user1', 'proj1');
    const call = clientSiteTutorialDraft.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ version: 3, status: 'REJECTED' });
    expect(call.data).toMatchObject({
      status: 'DRAFTING',
      rejectionReason: null,
    });
  });
});

// ── этап 113 ──────────────────────────────────────────────────────────

const THREE_ROUNDS = {
  steps: [
    { kind: 'goto', route: 'https://shop.example.com' },
    { kind: 'fill', selector: '#email', value: 'a@b.c' },
    { kind: 'fill', selector: '#pass', value: '' },
    { kind: 'click', selector: '#submit' },
    { kind: 'click', selector: '#next' },
  ],
  stepsPerRound: [1, 3, 1],
  roundScreenshots: ['кадр-1', 'кадр-2', 'кадр-3'],
};

describe('/undo — снимается РАУНД, а не шаг', () => {
  it('раунд из трёх шагов уходит целиком, кадр — один', async () => {
    // Снять «последний элемент массива» отрезало бы только click,
    // оставив осиротевшие fill без пары.
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow({ ...THREE_ROUNDS, stepsPerRound: [1, 1, 3] }),
    });

    await service.undo('user1', 'proj1', 3);

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.stepsPerRound).toEqual([1, 1]);
    expect(data.steps).toHaveLength(2);
    expect(data.roundScreenshots).toHaveLength(2);
  });

  it('свежий кадр ЗАМЕЩАЕТ последний оставшийся, а не дописывается', async () => {
    // Иначе предпросмотр после отмены показывал бы кадр, снятый при
    // первом проходе через эту же страницу, — то есть устаревший.
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow(THREE_ROUNDS),
    });

    await service.undo('user1', 'proj1', 3);

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.roundScreenshots).toEqual([
      'кадр-1',
      EXPLORATION.screenshotDataUrl,
    ]);
  });

  it('переигрываются ОСТАВШИЕСЯ шаги с первого goto, а не «шаг назад»', async () => {
    const { service, explorer } = setup({
      draft: makeDraftRow(THREE_ROUNDS),
    });

    await service.undo('user1', 'proj1', 3);

    const request = (explorer.replay as jest.Mock).mock.calls[0][0];
    expect(request.steps).toHaveLength(4);
    expect(request.steps[0].kind).toBe('goto');
    expect(request.allowedOrigin).toBe('https://shop.example.com');
  });

  it('первый раунд не отменяется — он задаёт исходную страницу', async () => {
    const { service } = setup();
    await expect(service.undo('user1', 'proj1', 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('раунд живого входа не отменяется — капчу переиграть нечем', async () => {
    // Последний раунд — один шаг `assertVisible`: так и только так
    // выглядит маркер живого входа.
    const { service } = setup({
      draft: makeDraftRow({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com' },
          { kind: 'assertVisible', selector: '#account' },
        ],
        stepsPerRound: [1, 1],
        roundScreenshots: ['кадр-1', 'кадр-2'],
        requiresLiveLoginReplay: true,
      }),
    });
    await expect(service.undo('user1', 'proj1', 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('обычный раунд ПОСЛЕ живого входа отменяется — переигрывать капчу не нужно', async () => {
    // До аудита этапа 116 флаг черновика запрещал отмену навсегда:
    // человек, записавший шаг за экраном логина и ошибшийся, не мог
    // откатить ничего, хотя сессия лежит в куках и переигрывается.
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com' },
          { kind: 'assertVisible', selector: '#account' },
          { kind: 'click', selector: '#orders' },
        ],
        stepsPerRound: [1, 1, 1],
        roundScreenshots: ['кадр-1', 'кадр-2', 'кадр-3'],
        requiresLiveLoginReplay: true,
      }),
    });

    await service.undo('user1', 'proj1', 3);

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.stepsPerRound).toEqual([1, 1]);
  });

  it('слот лимита возвращается, если переигровка не удалась', async () => {
    const { service, usage } = setup({
      draft: makeDraftRow(THREE_ROUNDS),
      explorer: {
        replay: jest.fn().mockRejectedValue(new Error('сайт лёг')),
      },
    });
    await expect(service.undo('user1', 'proj1', 3)).rejects.toThrow('сайт лёг');
    expect(usage.releaseRound).toHaveBeenCalledWith('user1');
  });

  it('устаревшая версия — 409', async () => {
    const { service } = setup({
      draft: makeDraftRow(THREE_ROUNDS),
      updateCount: 0,
    });
    await expect(service.undo('user1', 'proj1', 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('/finish — заморозка и заливка кадров', () => {
  const FRAMES = {
    steps: [
      { kind: 'goto', route: 'https://shop.example.com' },
      { kind: 'click', selector: '#next' },
    ],
    stepsPerRound: [1, 1],
    roundScreenshots: [
      'data:image/jpeg;base64,/9j/AAA=',
      'data:image/jpeg;base64,/9j/BBB=',
    ],
  };

  it('кадры берутся с сервера и ложатся по номеру раунда', async () => {
    const { service, blob } = setup({ draft: makeDraftRow(FRAMES) });

    await service.finish('user1', 'proj1', {
      expectedVersion: 3,
      title: 'Как оформить заявку',
    });

    const paths = (blob.uploadBuffer as jest.Mock).mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      'tutorial-video-frames/draft1/0.jpg',
      'tutorial-video-frames/draft1/1.jpg',
    ]);
  });

  it('прошлый префикс стирается ПЕРЕД заливкой (§15 п.4)', async () => {
    // Повторный /finish после resume+undo короче прошлого иначе оставил
    // бы «хвостовые» файлы навсегда.
    const { service, blob } = setup({
      draft: makeDraftRow(FRAMES),
      existingFrames: [
        {
          pathname: 'tutorial-video-frames/draft1/5.jpg',
          uploadedAt: new Date(),
        },
      ],
    });

    await service.finish('user1', 'proj1', {
      expectedVersion: 3,
      title: 'Заголовок',
    });

    expect(blob.deleteMany).toHaveBeenCalledWith([
      'tutorial-video-frames/draft1/5.jpg',
    ]);
    const wipeOrder = (blob.deleteMany as jest.Mock).mock
      .invocationCallOrder[0];
    const uploadOrder = (blob.uploadBuffer as jest.Mock).mock
      .invocationCallOrder[0];
    expect(wipeOrder).toBeLessThan(uploadOrder);
  });

  it('черновик замораживается и запоминает число кадров', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow(FRAMES),
    });

    await service.finish('user1', 'proj1', {
      expectedVersion: 3,
      title: '  Заголовок  ',
    });

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.status).toBe('PENDING_REVIEW');
    expect(data.previewFrameCount).toBe(2);
    expect(data.title).toBe('Заголовок');
  });

  it('проигранная гонка версий убирает только что залитые кадры', async () => {
    // Иначе префикс осиротел бы: строка не наша, а файлы уже лежат.
    const { service, blob } = setup({
      draft: makeDraftRow(FRAMES),
      updateCount: 0,
    });

    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((blob.listByPrefix as jest.Mock).mock.calls.length).toBe(2);
  });

  it('кадр, который не похож на data:image, не уезжает в хранилище', async () => {
    const { service } = setup({
      draft: makeDraftRow({ ...FRAMES, roundScreenshots: ['мусор', 'мусор'] }),
    });
    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toThrow(/data:image/);
  });

  it('уже отправленный на проверку черновик не финишируется повторно', async () => {
    const { service } = setup({
      draft: makeDraftRow({ ...FRAMES, status: 'PENDING_REVIEW' }),
    });
    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DELETE — за собой убирают и в хранилище', () => {
  it('черновик, доходивший до /finish, уносит свои кадры', async () => {
    const { service, blob, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow({ previewFrameCount: 2 }),
      existingFrames: [
        {
          pathname: 'tutorial-video-frames/draft1/0.jpg',
          uploadedAt: new Date(),
        },
      ],
    });

    await service.remove('user1', 'proj1');

    expect(blob.deleteMany).toHaveBeenCalled();
    // Порядок важен: после удаления строки draftId взять неоткуда.
    expect(
      (blob.deleteMany as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      clientSiteTutorialDraft.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('кадры стираются ДАЖЕ если счётчик пуст — заливка могла оборваться', async () => {
    // `previewFrameCount` проставляется последним, после заливки:
    // оборвавшийся `/finish` оставляет файлы при пустом счётчике, и
    // условная уборка теряла их навсегда (аудит этапа 116).
    const { service, blob } = setup({ draft: makeDraftRow() });
    await service.remove('user1', 'proj1');
    expect(blob.listByPrefix).toHaveBeenCalled();
  });

  it('удалять нечего — это не ошибка', async () => {
    const { service } = setup({ draft: null });
    await expect(service.remove('user1', 'proj1')).resolves.toBeUndefined();
  });
});

// ── этап 114: живой вход ──────────────────────────────────────────────

describe('/live-login/start', () => {
  it('отдаёт всё для ПРЯМОГО соединения с реле', async () => {
    // Видеопоток через serverless-функцию не имеет смысла ни по
    // архитектуре, ни по биллингу — фронтенд идёт к реле сам.
    const { service } = setup();
    const start = await service.startLiveLogin('user1', 'proj1');
    expect(start.relayWsUrl).toBe(
      'wss://relay.example/sessions/relay-1/stream',
    );
    expect(start.streamToken).toBe('tok');
    expect(start.ticket).toBeTruthy();
  });

  it('квитанция — не сам sessionId: иначе сосед подставил бы чужой', async () => {
    const { service } = setup();
    const start = await service.startLiveLogin('user1', 'proj1');
    expect(start.ticket).not.toContain('relay-1');
  });

  it('реле стартует с последней страницы черновика и с его же origin', async () => {
    const { service, relay } = setup();
    await service.startLiveLogin('user1', 'proj1');
    expect(relay.createSession).toHaveBeenCalledWith({
      startUrl: 'https://shop.example.com',
      allowedOrigin: 'https://shop.example.com',
    });
  });

  it('не настроенное реле — 503 с человеческим текстом, а не 500', async () => {
    const { service, relay } = setup({ relayConfigured: false });
    await expect(
      service.startLiveLogin('user1', 'proj1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(relay.createSession).not.toHaveBeenCalled();
  });

  it('исчерпанный дневной лимит живых входов — отказ ДО реле', async () => {
    const { service, relay } = setup({
      relay: {},
      usageLiveOk: false,
    });
    await expect(
      service.startLiveLogin('user1', 'proj1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(relay.createSession).not.toHaveBeenCalled();
  });

  it('слот живого входа возвращается, если реле не подняло сессию', async () => {
    const { service, usage } = setup({
      relay: {
        createSession: jest.fn().mockRejectedValue(new Error('реле легло')),
      },
    });
    await expect(service.startLiveLogin('user1', 'proj1')).rejects.toBeTruthy();
    expect(usage.releaseLiveSession).toHaveBeenCalledWith('user1');
  });

  it('признак доступности живого входа виден в состоянии черновика (§15.8)', async () => {
    const on = setup();
    expect(
      (await on.service.getState('user1', 'proj1'))?.liveLoginAvailable,
    ).toBe(true);
    const off = setup({ relayConfigured: false });
    expect(
      (await off.service.getState('user1', 'proj1'))?.liveLoginAvailable,
    ).toBe(false);
  });
});

describe('/live-login/complete', () => {
  async function ticketFor(over: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(over);
    const start = await ctx.service.startLiveLogin('user1', 'proj1');
    return { ...ctx, ticket: start.ticket };
  }

  it('записывает маркерный шаг и кадр — один раунд, как у всех (§15 п.2/п.3)', async () => {
    const { service, clientSiteTutorialDraft, ticket } = await ticketFor();

    const result = await service.completeLiveLogin('user1', 'proj1', {
      ticket,
      expectedVersion: 3,
    });

    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.stepsPerRound).toEqual([1, 1]);
    expect(data.roundScreenshots).toHaveLength(2);
    expect(data.steps[1].kind).toBe('assertVisible');
    expect(data.requiresLiveLoginReplay).toBe(true);
    // Без свежего PageExploration визарду нечем было бы продолжить.
    expect(result.exploration).toBeDefined();
  });

  it('буквальная последовательность кликов НЕ записывается', async () => {
    // Интерактивно пройденную капчу воспроизвести нельзя в принципе —
    // записать «нажми сюда, потом сюда» было бы враньём.
    const { service, clientSiteTutorialDraft, ticket } = await ticketFor();
    await service.completeLiveLogin('user1', 'proj1', {
      ticket,
      expectedVersion: 3,
    });
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.steps.filter((s: any) => s.kind === 'click')).toHaveLength(0);
  });

  it('выход на ЧУЖОМ домене — отказ и отмена сессии, а не тихий приём чужих кук', async () => {
    // Успешный 200 от реле НЕ означает, что человек довёл вход до
    // конца: куки снимаются и по таймауту тоже (§15.2).
    const { service, relay, ticket } = await ticketFor({
      relay: {
        fetchResult: jest.fn().mockResolvedValue({
          cookies: [],
          finalUrl: 'https://sso.example.org/consent',
        }),
      },
    });
    await expect(
      service.completeLiveLogin('user1', 'proj1', {
        ticket,
        expectedVersion: 3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(relay.cancelQuietly).toHaveBeenCalledWith('relay-1');
  });

  it('истёкшая сессия реле — 409 «начните заново», а не повтор', async () => {
    const { service, ticket } = await ticketFor({
      relay: {
        fetchResult: jest
          .fn()
          .mockRejectedValue(new RelaySessionGoneError('истекла')),
      },
    });
    await expect(
      service.completeLiveLogin('user1', 'proj1', {
        ticket,
        expectedVersion: 3,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('квитанция от другого черновика не принимается', async () => {
    const { service } = setup();
    const foreign = issueLiveTicket(
      { sessionId: 'чужая', draftId: 'другой-черновик' },
      KEY,
    );
    await expect(
      service.completeLiveLogin('user1', 'proj1', {
        ticket: foreign,
        expectedVersion: 3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('мусор вместо квитанции — 400, а не 500', async () => {
    const { service } = setup();
    await expect(
      service.completeLiveLogin('user1', 'proj1', {
        ticket: 'мусор-мусор-мусор',
        expectedVersion: 3,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('раунд после входа снимается с ВОССТАНОВЛЕННЫМИ куками', async () => {
    const cookies = [
      {
        name: 'sid',
        value: 'v',
        domain: 'shop.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: -1,
      },
    ];
    const { service, explorer, ticket } = await ticketFor({
      relay: {
        fetchResult: jest.fn().mockResolvedValue({
          cookies,
          finalUrl: 'https://shop.example.com/cabinet',
        }),
      },
    });
    await service.completeLiveLogin('user1', 'proj1', {
      ticket,
      expectedVersion: 3,
    });
    const request = (explorer.runRound as jest.Mock).mock.calls[0][0];
    expect(request.cookies).toEqual(cookies);
    expect(request.actions).toEqual([]);
  });
});

describe('селектор-доказательство входа', () => {
  const el = (selector: string, tag: string) => ({ selector, tag }) as any;

  it('предпочитает устойчивый селектор пути по тегам', () => {
    expect(
      pickLoginProofSelector({
        currentUrl: 'x',
        screenshotDataUrl: 'x',
        looksLikeLogin: false,
        elements: [
          el('div:nth-of-type(2) > input:nth-of-type(1)', 'input'),
          el('#account-name', 'input'),
        ],
      }),
    ).toBe('#account-name');
  });

  it('поле кабинета важнее ссылки — навигация есть и на экране логина', () => {
    expect(
      pickLoginProofSelector({
        currentUrl: 'x',
        screenshotDataUrl: 'x',
        looksLikeLogin: false,
        elements: [el('#nav-home', 'a'), el('#search', 'input')],
      }),
    ).toBe('#search');
  });

  it('пустая страница — body: бессмысленно, но честно', () => {
    expect(
      pickLoginProofSelector({
        currentUrl: 'x',
        screenshotDataUrl: 'x',
        looksLikeLogin: false,
        elements: [],
      }),
    ).toBe('body');
  });
});

describe('/refresh — посмотреть заново, ничего не записав', () => {
  it('отдаёт свежий снимок и НЕ трогает черновик', async () => {
    // Иначе перезагрузка вкладки дописывала бы в сценарий пустые шаги.
    const { service, clientSiteTutorialDraft } = setup();
    const result = await service.refresh('user1', 'proj1');
    expect(result.exploration).toEqual(EXPLORATION);
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
  });

  it('тратит слот суточного лимита — браузер поднимается по-настоящему', async () => {
    const { service, usage } = setup();
    await service.refresh('user1', 'proj1');
    expect(usage.reserveRound).toHaveBeenCalledWith('user1');
  });

  it('слот возвращается, если снимок не состоялся', async () => {
    const { service, usage } = setup({
      explorer: {
        runRound: jest.fn().mockRejectedValue(new Error('сайт лёг')),
      },
    });
    await expect(service.refresh('user1', 'proj1')).rejects.toThrow('сайт лёг');
    expect(usage.releaseRound).toHaveBeenCalledWith('user1');
  });

  it('черновик на проверке не обновляется — его нельзя редактировать', async () => {
    const { service } = setup({
      draft: makeDraftRow({ status: 'PENDING_REVIEW' }),
    });
    await expect(service.refresh('user1', 'proj1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('повтор раунда не повторяет действие на сайте (этап 117)', () => {
  it('версия занимается ДО браузера, а не после', async () => {
    // Раньше версия проверялась только при записи результата — то есть
    // уже ПОСЛЕ клика. Повтор после оборванной связи нажимал ту же
    // кнопку второй раз, и для «Оформить заказ» это второй заказ.
    const { service, clientSiteTutorialDraft, explorer } = setup();

    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [],
      clickSelector: '#pay',
    });

    expect(
      clientSiteTutorialDraft.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      (explorer.runRound as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('повтор с той же версией — 409 и браузер не трогается', async () => {
    const { service, explorer } = setup({ updateCount: 0 });
    await expect(
      service.step('user1', 'proj1', {
        expectedVersion: 3,
        fills: [],
        clickSelector: '#pay',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(explorer.runRound).not.toHaveBeenCalled();
  });

  it('текст отказа предупреждает, что действие могло состояться', async () => {
    // «Черновик изменился в другой вкладке» тут было бы неправдой и
    // подтолкнуло бы человека просто нажать ещё раз.
    const { service } = setup({ updateCount: 0 });
    await expect(
      service.step('user1', 'proj1', {
        expectedVersion: 3,
        fills: [],
        clickSelector: '#pay',
      }),
    ).rejects.toThrow(/могло состояться/);
  });

  it('то же для отмены — переигровка тоже нажимает кнопки', async () => {
    const { service, explorer } = setup({
      draft: makeDraftRow(THREE_ROUNDS),
      updateCount: 0,
    });
    await expect(service.undo('user1', 'proj1', 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(explorer.replay).not.toHaveBeenCalled();
  });

  it('результат пишется по ЗАНЯТОЙ версии, а не по исходной', async () => {
    // Иначе запись не нашла бы собственную строку и всегда давала 409.
    const { service, clientSiteTutorialDraft } = setup();
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [{ selector: '#a', value: 'x' }],
    });
    const calls = clientSiteTutorialDraft.updateMany.mock.calls;
    expect(calls[0][0].where.version).toBe(3);
    expect(calls.at(-1)[0].where.version).toBe(4);
  });
});

/**
 * Находка Б-4 аудита `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`:
 * собранный ролик был виден только оператору, и у целого вида проекта
 * не оставалось артефакта для того, кто его записал.
 *
 * Проверяется не «поле появилось», а три границы, каждая из которых
 * отдаёт человеку неверный файл, если её сдвинуть.
 */
describe('готовый ролик у владельца проекта (Б-4)', () => {
  const COMPLETE = {
    assemblyStatus: 'complete',
    blobUrl: 'https://blob.example/tutorial-videos/v1.mp4',
    durationMs: 21000,
  };

  it('одобренный черновик с готовой сборкой отдаёт ссылку и длительность', async () => {
    const { service } = setup({
      draft: makeDraftRow({ status: 'APPROVED' }),
      videoAsset: COMPLETE,
    });

    const view = await service.getState('user1', 'proj1');

    expect(view?.video).toEqual({
      status: 'complete',
      url: 'https://blob.example/tutorial-videos/v1.mp4',
      durationMs: 21000,
    });
  });

  it('сборка ещё идёт — ссылки нет, а не пустая строка вместо неё', async () => {
    const { service } = setup({
      draft: makeDraftRow({ status: 'APPROVED' }),
      videoAsset: {
        assemblyStatus: 'pending',
        blobUrl: null,
        durationMs: null,
      },
    });

    const view = await service.getState('user1', 'proj1');

    expect(view?.video).toEqual({
      status: 'pending',
      url: null,
      durationMs: null,
    });
  });

  it('провалившаяся сборка НЕ отдаёт ссылку, даже если в строке что-то лежит', async () => {
    // Самая важная из трёх: `blobUrl` у 'failed' может остаться от
    // прошлой попытки, и отдать его значит показать человеку битый
    // файл как готовый ролик.
    const { service } = setup({
      draft: makeDraftRow({ status: 'APPROVED' }),
      videoAsset: {
        assemblyStatus: 'failed',
        blobUrl: 'https://blob.example/tutorial-videos/половина.mp4',
        durationMs: 3000,
      },
    });

    const view = await service.getState('user1', 'proj1');

    expect(view?.video).toEqual({
      status: 'failed',
      url: null,
      durationMs: null,
    });
  });

  it('неизвестный assemblyStatus трактуется как «собирается», а не роняет экран состояния', async () => {
    // `assemblyStatus` в схеме — свободная строка; экран состояния
    // зовётся на каждом открытии визарда, и падать он не должен ни от
    // какого её значения.
    const { service } = setup({
      draft: makeDraftRow({ status: 'APPROVED' }),
      videoAsset: {
        assemblyStatus: 'подождите',
        blobUrl: null,
        durationMs: null,
      },
    });

    const view = await service.getState('user1', 'proj1');

    expect(view?.video?.status).toBe('pending');
  });

  it('у черновика в работе за роликом вообще не ходим — лишний запрос на каждом открытии экрана', async () => {
    const { service, prisma } = setup({
      draft: makeDraftRow({ status: 'DRAFTING' }),
    });

    const view = await service.getState('user1', 'proj1');

    expect(view?.video).toBeNull();
    expect(
      (prisma as unknown as { tutorialVideoAsset: { findFirst: jest.Mock } })
        .tutorialVideoAsset.findFirst,
    ).not.toHaveBeenCalled();
  });

  it('одобрен, но строки ролика ещё нет — video остаётся пустым, а не выдуманным', async () => {
    const { service } = setup({
      draft: makeDraftRow({ status: 'APPROVED' }),
      videoAsset: null,
    });

    const view = await service.getState('user1', 'proj1');

    expect(view?.video).toBeNull();
  });
});
