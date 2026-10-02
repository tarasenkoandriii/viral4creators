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
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ClientSiteTutorialService,
  alignRoundWarnings,
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
import {
  ClientSiteAccessService,
  JOURNAL_CONSENT_LOCALE,
  SITE_MODE_CACHE_MS,
  STICKY_A_MS,
  accountConsentPolicy,
  consentIpHash,
} from './site-access.service';
import {
  SitesUnavailableError,
  type SitesInternalClient,
} from '../sites-internal/sites-internal.client';
import { ACCOUNT_CONSENT_TEXT_VERSION } from './account-consent';
import { DraftSecretsStore } from './draft-secrets-store';
import { FakeSitesCredentials } from '../../../test/fake-sites-credentials';

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
    /** Хранилище целиком — там, где важно, ЧТО в нём лежит после
     * операции, а не какие вызовы были (см. `memoryBlob`). */
    blob?: BlobService;
    /** Э-С Ш1: что ответит кабинет сайтов. По умолчанию — `A` (свой
     * подтверждённый сайт), чтобы тесты оркестрации раунда не зависели
     * от ворот П-Т2; сами ворота — в своём `describe`. */
    sitesMode?: 'A' | 'B' | 'down' | 'unconfigured';
    /** Есть ли подтверждение прав на аккаунт текущей версии. */
    consent?: boolean;
    telegramId?: string;
    /** `SITE_TUTORIAL_ACCOUNT_CONSENT`; не задан — по умолчанию (`journal`). */
    consentPolicy?: string;
    /** `SITES_VERIFY_URL`; по умолчанию задан, `null` — не задан. */
    verifyUrl?: string | null;
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

  const blob =
    opts.blob ??
    ({
      uploadBuffer: jest
        .fn()
        .mockImplementation((pathname: string) =>
          Promise.resolve({ url: `https://blob.example/${pathname}` }),
        ),
      listByPrefix: jest
        .fn()
        .mockResolvedValue({ blobs: opts.existingFrames ?? [], cursor: null }),
      deleteMany: jest.fn().mockResolvedValue(0),
    } as unknown as BlobService);

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

  // Своя «база» у сервиса режима: его записи (режим в черновик,
  // подтверждения) не смешиваются со счётом вызовов `updateMany`
  // черновика, на который опираются тесты оркестрации.
  const consentRows: Array<Record<string, unknown>> = opts.consent
    ? [
        {
          userId: 'user1',
          registrableDomain: 'example.com',
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        },
      ]
    : [];
  const accessPrisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ telegramId: opts.telegramId ?? '4242' }),
    },
    siteTutorialAccountConsent: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        const k = where.userId_registrableDomain_textVersion;
        const hit = consentRows.find(
          (r) =>
            r.userId === k.userId &&
            r.registrableDomain === k.registrableDomain &&
            r.textVersion === k.textVersion,
        );
        return Promise.resolve(
          hit ? { id: 'c1', locale: hit.locale ?? 'ru' } : null,
        );
      }),
      // Уникальный индекс пользователь+домен+версия — как в базе.
      create: jest.fn().mockImplementation(({ data }: any) => {
        const dup = consentRows.some(
          (r) =>
            r.userId === data.userId &&
            r.registrableDomain === data.registrableDomain &&
            r.textVersion === data.textVersion,
        );
        if (dup) return Promise.reject({ code: 'P2002' });
        consentRows.push(data);
        return Promise.resolve({ id: 'c2', ...data });
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        let count = 0;
        for (const r of consentRows) {
          if (
            r.userId === where.userId &&
            r.registrableDomain === where.registrableDomain &&
            r.textVersion === where.textVersion &&
            r.locale === where.locale
          ) {
            Object.assign(r, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
    },
    clientSiteTutorialDraft: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService;
  const sitesMode = opts.sitesMode ?? 'A';
  const sites = {
    configured: jest.fn(() => sitesMode !== 'unconfigured'),
    hostStatus: jest.fn().mockImplementation(() =>
      sitesMode === 'down'
        ? Promise.reject(new SitesUnavailableError('нет связи'))
        : Promise.resolve({
            mode: sitesMode,
            host: 'shop.example.com',
            registrableDomain: 'example.com',
            hostId: 'host1',
            status: sitesMode === 'A' ? 'verified' : 'pending',
            expiresAt: null,
            optedOut: false,
            reason: sitesMode === 'A' ? null : 'not_verified',
          }),
    ),
    registerHost: jest.fn().mockResolvedValue({}),
  } as unknown as SitesInternalClient;
  const access = new ClientSiteAccessService(accessPrisma, sites);
  access.env = {
    ...(opts.verifyUrl === null
      ? {}
      : {
          SITES_VERIFY_URL:
            opts.verifyUrl ?? 'https://t.me/assist_bot?startapp',
        }),
    ...(opts.consentPolicy === undefined
      ? {}
      : { SITE_TUTORIAL_ACCOUNT_CONSENT: opts.consentPolicy }),
  };

  const service = new ClientSiteTutorialService(
    prisma,
    plans,
    usage,
    blob,
    relay,
    explorer,
    access,
  );
  return {
    accessPrisma,
    consentRows,
    sites,
    access,
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
    // Подробность декодера («data:image/...;base64») — в лог; человеку —
    // что делать.
    const refused = service.finish('user1', 'proj1', {
      expectedVersion: 3,
      title: 'Т',
    });
    await expect(refused).rejects.toThrow(/кадр предпросмотра не читается/);
    await expect(refused).rejects.not.toThrow(/data:image/);
  });

  it('черновик без единого кадра не финишируется — и это тот же список, что на экране', async () => {
    // «Тонкая красная линия» §7.2 п.3: барьер и строка «до готового
    // ролика» читают ОДНУ функцию (`clientSiteReadiness`). До этого
    // условие жило только здесь, и до аудита волны B его не проверял
    // ни один тест — убери строку, и набор оставался зелёным.
    const { service, blob } = setup({
      draft: makeDraftRow({
        steps: [],
        stepsPerRound: [],
        roundScreenshots: [],
      }),
    });
    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toThrow(/ни одного кадра/);
    // И ничего не залилось: отказ случился до работы с хранилищем.
    expect((blob.uploadBuffer as jest.Mock).mock.calls.length).toBe(0);
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

/**
 * Хранилище с состоянием: путь → тип содержимого. Моки вызовов выше
 * проверяют порядок, но не видят главного — что осталось лежать. Блокер
 * QA 01.10.2026 (стирание съёмочных кадров перед их копированием) по
 * одним вызовам не ловился: `copyBlob` звался, просто копировать было
 * уже нечего.
 */
function memoryBlob(initial: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial));
  const blob = {
    store,
    uploadBuffer: jest.fn((pathname: string, _b: Buffer, type: string) => {
      store.set(pathname, type);
      return Promise.resolve({ url: `https://blob.example/${pathname}` });
    }),
    // Как настоящий `BlobService.copyBlob`: исходника нет — `null`.
    copyBlob: jest.fn((from: string, to: string, type = 'image/jpeg') => {
      if (!store.has(from)) return Promise.resolve(null);
      store.set(to, type);
      return Promise.resolve(`https://blob.example/${to}`);
    }),
    listByPrefix: jest.fn((prefix: string) =>
      Promise.resolve({
        blobs: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((pathname) => ({ pathname, uploadedAt: new Date() })),
        cursor: null,
      }),
    ),
    deleteMany: jest.fn((paths: string[]) => {
      for (const p of paths) store.delete(p);
      return Promise.resolve(paths.length);
    }),
  };
  return blob;
}

describe('/finish — съёмочные кадры переживают уборку (блокер QA 01.10.2026)', () => {
  const ROUNDS = {
    steps: [
      { kind: 'goto', route: 'https://shop.example.com' },
      { kind: 'click', selector: '#next' },
    ],
    stepsPerRound: [1, 1],
    roundScreenshots: [
      'data:image/jpeg;base64,/9j/AAA=',
      'data:image/jpeg;base64,/9j/BBB=',
    ],
    roundVideoFrames: [
      'https://blob.example/tutorial-video-frames/draft1/round-0.png',
      'https://blob.example/tutorial-video-frames/draft1/round-1.png',
    ],
  };

  it('итоговые кадры собираются из съёмочных, и съёмочные остаются на месте', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
      'tutorial-video-frames/draft1/round-1.png': 'image/png',
      // Хвост прошлого, более длинного /finish — его стереть надо.
      'tutorial-video-frames/draft1/7.jpg': 'image/jpeg',
    });
    const { service } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
    });

    await service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' });

    expect([...blob.store.keys()].sort()).toEqual([
      'tutorial-video-frames/draft1/0.png',
      'tutorial-video-frames/draft1/1.png',
      'tutorial-video-frames/draft1/round-0.png',
      'tutorial-video-frames/draft1/round-1.png',
    ]);
    // Оба кадра — съёмочные (PNG), а не откат на предпросмотр: откат
    // здесь означал бы, что исходник исчез до копирования.
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
  });

  it('повторный /finish после resume тоже находит съёмочные кадры', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
      'tutorial-video-frames/draft1/round-1.png': 'image/png',
    });
    const { service } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
    });
    await service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' });
    await service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' });

    expect(blob.store.get('tutorial-video-frames/draft1/0.png')).toBe(
      'image/png',
    );
    expect(blob.store.get('tutorial-video-frames/draft1/1.png')).toBe(
      'image/png',
    );
  });

  it('пропавший съёмочный кадр заменяется кадром предпросмотра, а не выпадает', async () => {
    const blob = memoryBlob({
      // round-1 нет: заливка съёмочного кадра раунда не удалась.
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
    });
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
    });

    await service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' });

    expect(blob.store.get('tutorial-video-frames/draft1/0.png')).toBe(
      'image/png',
    );
    expect(blob.store.get('tutorial-video-frames/draft1/1.jpg')).toBe(
      'image/jpeg',
    );
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.previewFrameCount).toBe(2);
  });

  it('проигрыш гонки чужому /finish не стирает итоговые кадры победителя', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
      'tutorial-video-frames/draft1/round-1.png': 'image/png',
    });
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
      updateCount: 0,
    });
    // Первое чтение — наш черновик в работе; повторное, после
    // проигранной гонки — уже отправленный другой вкладкой.
    clientSiteTutorialDraft.findUnique
      .mockResolvedValueOnce(makeDraftRow(ROUNDS))
      .mockResolvedValueOnce(
        makeDraftRow({ ...ROUNDS, status: 'PENDING_REVIEW' }),
      );

    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(blob.store.has('tutorial-video-frames/draft1/0.png')).toBe(true);
    expect(blob.store.has('tutorial-video-frames/draft1/1.png')).toBe(true);
  });
});

describe('/finish — отставшая вкладка не портит чужие кадры (аудит 01.10.2026)', () => {
  const ROUNDS = {
    steps: [{ kind: 'goto', route: 'https://shop.example.com' }],
    stepsPerRound: [1],
    roundScreenshots: ['data:image/jpeg;base64,/9j/AAA='],
    roundVideoFrames: [
      'https://blob.example/tutorial-video-frames/draft1/round-0.png',
    ],
  };

  it('устаревшая версия — 409 ДО любой работы с хранилищем', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
      'tutorial-video-frames/draft1/0.png': 'image/png',
    });
    const { service } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
    });
    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 2, title: 'Т' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(blob.listByPrefix).not.toHaveBeenCalled();
    expect(blob.copyBlob).not.toHaveBeenCalled();
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
  });

  it('сбой заливки при черновике, уже отправленном другой вкладкой, — итоговые не стираются', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
      'tutorial-video-frames/draft1/0.png': 'image/png',
    });
    blob.copyBlob.mockRejectedValueOnce(new Error('хранилище икнуло'));
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
    });
    clientSiteTutorialDraft.findUnique
      .mockResolvedValueOnce(makeDraftRow(ROUNDS))
      .mockResolvedValueOnce(
        makeDraftRow({ ...ROUNDS, status: 'PENDING_REVIEW' }),
      );
    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Первое стирание (перед заливкой) — наше законное; второго, после
    // сбоя, быть не должно: листинг под уборку — ровно один.
    expect(blob.listByPrefix).toHaveBeenCalledTimes(1);
  });

  it('сбой заливки при черновике в работе — за собой убираем', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
    });
    blob.copyBlob.mockRejectedValueOnce(new Error('хранилище икнуло'));
    const { service } = setup({
      draft: makeDraftRow(ROUNDS),
      blob: blob as unknown as BlobService,
    });
    await expect(
      service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(blob.listByPrefix).toHaveBeenCalledTimes(2);
  });
});

describe('DELETE — за собой убирают и в хранилище', () => {
  it('DELETE уносит и съёмочные кадры раундов — префикс целиком', async () => {
    const blob = memoryBlob({
      'tutorial-video-frames/draft1/round-0.png': 'image/png',
      'tutorial-video-frames/draft1/0.png': 'image/png',
    });
    const { service } = setup({ blob: blob as unknown as BlobService });
    await service.remove('user1', 'proj1');
    expect(blob.store.size).toBe(0);
  });

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
    // Живой вход ничего «опасного» не нажимал от нашего имени — но
    // место в массиве предупреждений за раундом всё равно держится,
    // иначе следующее съехало бы на чужой кадр.
    expect(data.roundDangerWarnings).toEqual([null, null]);
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

describe('предупреждение стоп-листа доживает до оператора (перенос QA TMA §12)', () => {
  it('/step сохраняет предупреждение своего раунда', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      explorer: {
        runRound: jest.fn().mockResolvedValue({
          exploration: { ...EXPLORATION, dangerWarning: 'похоже на оплату' },
          cookies: [],
        }),
      },
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      clickSelector: '#pay',
      fills: [],
    });
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    // Черновик до колонки (`undefined`) — ранний раунд без пометки.
    expect(data.roundDangerWarnings).toEqual([null, 'похоже на оплату']);
  });

  it('раунд без предупреждения держит место `null`', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow({ roundDangerWarnings: ['было'] }),
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      clickSelector: '#next',
      fills: [],
    });
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.roundDangerWarnings).toEqual(['было', null]);
  });

  it('/undo снимает предупреждение отменённого раунда, а не чужое', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com' },
          { kind: 'click', selector: '#a' },
          { kind: 'click', selector: '#pay' },
        ],
        stepsPerRound: [1, 1, 1],
        roundScreenshots: ['кадр-1', 'кадр-2', 'кадр-3'],
        roundDangerWarnings: [null, 'удаление', 'оплата'],
      }),
    });
    await service.undo('user1', 'proj1', 3);
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.roundDangerWarnings).toEqual([null, 'удаление']);
  });

  it('alignRoundWarnings выравнивает по левому краю и чистит мусор', () => {
    expect(alignRoundWarnings(undefined, 2)).toEqual([null, null]);
    expect(alignRoundWarnings(['x'], 3)).toEqual([null, null, 'x']);
    expect(alignRoundWarnings(['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
    expect(alignRoundWarnings([42, '', 'ok'], 3)).toEqual([null, null, 'ok']);
    expect(alignRoundWarnings('не массив', 1)).toEqual([null]);
  });
});

// ── Ш0.5/Ш0.6 аудита 02.10.2026 (риски В-1, В-2) ──────────────────────

/** Кука в форме CDP. */
function cdpCookie(name: string, domain: string) {
  return {
    name,
    value: `${name}-value`,
    domain,
    path: '/',
    secure: true,
    httpOnly: true,
    expires: -1,
  };
}

const MIXED_JAR = [
  cdpCookie('sid', '.shop.example.com'),
  cdpCookie('auth', 'auth.example.com'),
  cdpCookie('SID', '.google.com'),
  cdpCookie('c_user', '.facebook.com'),
  cdpCookie('_ga', '.doubleclick.net'),
];

function storedCookieNames(enc: string): string[] {
  const { decryptCookieJar } = jest.requireActual('../../common/cookie-jar');
  return decryptCookieJar(enc, KEY)
    .cookies.map((c: { name: string }) => c.name)
    .sort();
}

describe('Ш0.5: в базу — только куки сайта заказчика', () => {
  it('живой вход: SSO-сессия Google/Facebook не попадает ни в раунд, ни в cookiesEnc', async () => {
    const ctx = setup({
      relay: {
        fetchResult: jest.fn().mockResolvedValue({
          cookies: MIXED_JAR,
          finalUrl: 'https://shop.example.com/cabinet',
        }),
      },
    });
    const { ticket } = await ctx.service.startLiveLogin('user1', 'proj1');
    await ctx.service.completeLiveLogin('user1', 'proj1', {
      ticket,
      expectedVersion: 3,
    });

    const roundCookies = (ctx.explorer.runRound as jest.Mock).mock.calls[0][0]
      .cookies as Array<{ name: string }>;
    expect(roundCookies.map((c) => c.name).sort()).toEqual(['auth', 'sid']);

    const data =
      ctx.clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(storedCookieNames(data.cookiesEnc)).toEqual(['auth', 'sid']);
    expect(data.secretsUsedAt).toBeInstanceOf(Date);
  });

  it('/step: сторонние куки из jar разведчика тоже отбрасываются', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      explorer: {
        runRound: jest
          .fn()
          .mockResolvedValue({ exploration: EXPLORATION, cookies: MIXED_JAR }),
      },
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [],
      clickSelector: '#next',
    });
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(storedCookieNames(data.cookiesEnc)).toEqual(['auth', 'sid']);
    // Отметка «секреты использовались» — от неё считается срок хранения.
    expect(data.secretsUsedAt).toBeInstanceOf(Date);
  });

  it('/login с «одноразово» запоминает выбор; без флага — не трогает его', async () => {
    const { service, clientSiteTutorialDraft } = setup();
    const fields = [{ selector: '#pass', value: 'p', sensitive: true }];
    await service.login('user1', 'proj1', {
      expectedVersion: 3,
      submitSelector: '#submit',
      fields,
      forgetAfterBuild: true,
    });
    expect(
      clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data
        .secretsOneShot,
    ).toBe(true);

    await service.login('user1', 'proj1', {
      expectedVersion: 3,
      submitSelector: '#submit',
      fields,
    });
    expect(
      clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data,
    ).not.toHaveProperty('secretsOneShot');
  });
});

describe('Ш0.6: кадры — по неугадываемому пути', () => {
  it('/explore заводит случайный frameKey, и съёмочный кадр ложится под него', async () => {
    const { service, clientSiteTutorialDraft, blob } = setup({
      draft: null,
      explorer: {
        runRound: jest.fn().mockResolvedValue({
          exploration: {
            ...EXPLORATION,
            videoFrameDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          },
          cookies: [],
        }),
      },
    });
    await service.explore('user1', 'proj1', 'https://shop.example.com');

    const data = clientSiteTutorialDraft.create.mock.calls[0][0].data;
    expect(data.frameKey).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(data.secretsUsedAt).toBeInstanceOf(Date);
    const pathname = (blob.uploadBuffer as jest.Mock).mock.calls[0][0];
    expect(pathname).toBe(
      `tutorial-video-frames/draft1/${data.frameKey}/round-0.png`,
    );
  });

  it('ключи двух черновиков разные', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const { service, clientSiteTutorialDraft } = setup({ draft: null });
      await service.explore('user1', 'proj1', 'https://shop.example.com');
      keys.add(clientSiteTutorialDraft.create.mock.calls[0][0].data.frameKey);
    }
    expect(keys.size).toBe(2);
  });

  it('/finish раскладывает итоговые кадры в ту же папку-ключ, корень пуст', async () => {
    const K = 'k'.repeat(24);
    const blob = memoryBlob({
      [`tutorial-video-frames/draft1/${K}/round-0.png`]: 'image/png',
    });
    const { service } = setup({
      draft: makeDraftRow({
        frameKey: K,
        roundScreenshots: ['data:image/jpeg;base64,/9j/AAA='],
        roundVideoFrames: [
          `https://blob.example/tutorial-video-frames/draft1/${K}/round-0.png`,
        ],
      }),
      blob: blob as unknown as BlobService,
    });
    await service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' });
    expect([...blob.store.keys()].sort()).toEqual([
      `tutorial-video-frames/draft1/${K}/0.png`,
      `tutorial-video-frames/draft1/${K}/round-0.png`,
    ]);
    // Съёмочный нашёлся по ключу — отката на предпросмотр не было.
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('аудит Ш0: уборка кадров снова отвечает за новые кадры', () => {
  it('новый съёмочный кадр снимает отметку framesPurgedAt', async () => {
    const { service, clientSiteTutorialDraft, blob } = setup({
      draft: makeDraftRow({
        frameKey: 'k'.repeat(24),
        framesPurgedAt: new Date('2026-09-01T00:00:00Z'),
      }),
      explorer: {
        runRound: jest.fn().mockResolvedValue({
          exploration: {
            ...EXPLORATION,
            videoFrameDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          },
          cookies: [],
        }),
      },
    });
    // В общем моке `update` нет (сбой заливки кадра глотается) — здесь он
    // нужен, чтобы увидеть, ЧТО пишется вместе со ссылкой на кадр.
    const update = jest.fn().mockResolvedValue(makeDraftRow());
    Object.assign(clientSiteTutorialDraft, { update });
    Object.assign(blob, {
      getPublicUrl: jest.fn().mockResolvedValue('https://blob.example/f.png'),
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [],
      clickSelector: '#next',
    });
    const frameWrite = update.mock.calls.find(
      (c) => 'roundVideoFrames' in c[0].data,
    );
    expect(frameWrite?.[0].data.framesPurgedAt).toBeNull();
  });

  it('/finish заливает итоговые кадры и снимает отметку framesPurgedAt', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: makeDraftRow({
        roundScreenshots: ['data:image/jpeg;base64,/9j/AAA='],
        framesPurgedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    });
    await service.finish('user1', 'proj1', { expectedVersion: 3, title: 'Т' });
    const claim = (
      clientSiteTutorialDraft.updateMany as jest.Mock
    ).mock.calls.find((c) => c[0].data.status === 'PENDING_REVIEW');
    expect(claim?.[0].data).toHaveProperty('framesPurgedAt', null);
  });
});

describe('Э-С Ш1: режим A/B (П-Т1) и ворота П-Т2 при SITE_TUTORIAL_ACCOUNT_CONSENT=required', () => {
  // Ворота 409 — только в `required` (решение владельца 02.10.2026: по
  // умолчанию `journal`, ничего не блокирует). Здесь — прежнее поведение.
  const setupR = (o: Parameters<typeof setup>[0] = {}) =>
    setup({ consentPolicy: 'required', ...o });
  const LOGIN = {
    expectedVersion: 3,
    submitSelector: '#submit',
    fields: [{ selector: '#pass', value: 'секрет', sensitive: true }],
  };
  const codeOf = (e: unknown) =>
    ((e as ConflictException).getResponse() as { code?: string }).code;

  it('B без подтверждения: /explore — 409 с кодом, ДО слота лимита и браузера', async () => {
    const { service, usage, explorer, clientSiteTutorialDraft } = setupR({
      draft: null,
      sitesMode: 'B',
    });
    const err = await service
      .explore('user1', 'proj1', 'https://shop.example.com/x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED');
    expect(usage.reserveRound).not.toHaveBeenCalled();
    expect(explorer.runRound).not.toHaveBeenCalled();
    expect(clientSiteTutorialDraft.create).not.toHaveBeenCalled();
  });

  it('B с подтверждением: /explore идёт, черновик помнит режим B и хост', async () => {
    const { service, clientSiteTutorialDraft } = setupR({
      draft: null,
      sitesMode: 'B',
      consent: true,
    });
    await service.explore('user1', 'proj1', 'https://shop.example.com/x');
    const data = clientSiteTutorialDraft.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ siteMode: 'B', siteHostId: 'host1' });
    expect(data.siteModeCheckedAt).toBeInstanceOf(Date);
  });

  it('A (свой подтверждённый сайт): подтверждение прав не нужно', async () => {
    const { service, clientSiteTutorialDraft } = setupR({
      draft: null,
      sitesMode: 'A',
    });
    await service.explore('user1', 'proj1', 'https://shop.example.com');
    expect(clientSiteTutorialDraft.create.mock.calls[0][0].data.siteMode).toBe(
      'A',
    );
  });

  it.each([
    ['sites-backend не отвечает', { sitesMode: 'down' as const }, true],
    [
      'sites-backend не настроен',
      { sitesMode: 'unconfigured' as const },
      false,
    ],
    ['dev-пользователь без Telegram-id', { telegramId: 'dev-1' }, false],
  ])('%s — режим B, обучалка не падает', async (_n, o, asked) => {
    const { service, sites } = setupR({ draft: null, ...o });
    const view = await service.siteAccess(
      'user1',
      'proj1',
      'https://shop.example.com',
    );
    expect(view.mode).toBe('B');
    expect(view.consent).toMatchObject({ required: true, accepted: false });
    // Без подтверждения — те же ворота, что у обычного B…
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).rejects.toBeInstanceOf(ConflictException);
    // …с подтверждением — работает, как будто кабинета сайтов нет вовсе.
    await service.acceptAccountConsent(
      'user1',
      'proj1',
      {
        url: 'https://shop.example.com',
        textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        locale: 'ru',
      },
      'iphash',
    );
    await expect(
      service.explore('user1', 'proj1', 'https://shop.example.com'),
    ).resolves.toBeDefined();
    // Не настроено и нет Telegram-id — в сеть не ходим вовсе.
    expect((sites.hostStatus as jest.Mock).mock.calls.length > 0).toBe(asked);
  });

  it('B без подтверждения: /login — 409 до шифрования кред и до занятия версии', async () => {
    const { service, clientSiteTutorialDraft, usage, accessPrisma } = setupR({
      sitesMode: 'B',
    });
    const err = await service
      .login('user1', 'proj1', LOGIN)
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED');
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
    expect(usage.reserveRound).not.toHaveBeenCalled();
    // Режим всё равно записан в черновик (плашка увидит B).
    expect(
      (accessPrisma.clientSiteTutorialDraft.updateMany as jest.Mock).mock
        .calls[0][0],
    ).toMatchObject({ where: { id: 'draft1' }, data: { siteMode: 'B' } });
  });

  it('B без подтверждения: живой вход — 409, реле и лимит не тронуты', async () => {
    const { service, relay, usage } = setupR({ sitesMode: 'B' });
    const err = await service
      .startLiveLogin('user1', 'proj1')
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED');
    expect(relay.createSession).not.toHaveBeenCalled();
    expect(usage.reserveLiveSession).not.toHaveBeenCalled();
  });

  // Аудит Ш1: `/step` с `fills` по форме входа — это вход без `/login`,
  // `/undo` переигрывает сохранённые креды, `/refresh` открывает сайт с
  // куками сессии. Черновик, начатый в A (хост потом истёк — сразу B), до
  // Ш1 или до новой версии текста, иначе водился бы дальше без галочки.
  it.each([
    [
      '/step',
      (svc: ClientSiteTutorialService) =>
        svc.step('user1', 'proj1', {
          expectedVersion: 3,
          fills: [{ selector: '#pass', value: 'чужой-пароль' }],
          clickSelector: '#submit',
        }),
    ],
    [
      '/undo',
      (svc: ClientSiteTutorialService) => svc.undo('user1', 'proj1', 3),
    ],
    [
      '/refresh',
      (svc: ClientSiteTutorialService) => svc.refresh('user1', 'proj1'),
    ],
  ])(
    'B без подтверждения: %s — 409 до версии, слота и браузера',
    async (_n, call) => {
      const { service, clientSiteTutorialDraft, usage, explorer } = setupR({
        sitesMode: 'B',
        draft: makeDraftRow(THREE_ROUNDS),
      });
      const err = await call(service).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED');
      expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
      expect(usage.reserveRound).not.toHaveBeenCalled();
      expect(explorer.runRound).not.toHaveBeenCalled();
      expect(explorer.replay).not.toHaveBeenCalled();
    },
  );

  it('B с подтверждением: /step, /undo, /refresh идут как раньше', async () => {
    for (const call of [
      (svc: ClientSiteTutorialService) =>
        svc.step('user1', 'proj1', {
          expectedVersion: 3,
          fills: [],
          clickSelector: '#a',
        }),
      (svc: ClientSiteTutorialService) => svc.undo('user1', 'proj1', 3),
      (svc: ClientSiteTutorialService) => svc.refresh('user1', 'proj1'),
    ]) {
      const { service } = setupR({
        sitesMode: 'B',
        consent: true,
        draft: makeDraftRow(THREE_ROUNDS),
      });
      await expect(call(service)).resolves.toBeDefined();
    }
  });

  it('подтверждение — на регистрируемый домен: shop. подтвердил — admin. того же сайта проходит, чужой домен — нет', async () => {
    const { service, consentRows } = setupR({
      sitesMode: 'B',
      draft: makeDraftRow({ baseUrl: 'https://admin.example.com' }),
    });
    consentRows.push({
      userId: 'user1',
      registrableDomain: 'example.com',
      textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
    });
    await expect(service.login('user1', 'proj1', LOGIN)).resolves.toBeDefined();

    const other = setupR({
      sitesMode: 'B',
      draft: makeDraftRow({
        baseUrl: 'https://example.org',
        lastUrl: 'https://example.org',
      }),
    });
    other.consentRows.push({
      userId: 'user1',
      registrableDomain: 'example.com',
      textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
    });
    await expect(
      other.service.login('user1', 'proj1', LOGIN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('подтверждение другого пользователя не считается', async () => {
    const { service, consentRows } = setupR({ sitesMode: 'B' });
    consentRows.push({
      userId: 'user2',
      registrableDomain: 'example.com',
      textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
    });
    await expect(service.login('user1', 'proj1', LOGIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('смена версии текста: старое подтверждение не действует, подтверждение старой версии — 409 STALE', async () => {
    const { service, consentRows, accessPrisma } = setupR({ sitesMode: 'B' });
    consentRows.push({
      userId: 'user1',
      registrableDomain: 'example.com',
      textVersion: '2020-01-01-old',
    });
    await expect(service.login('user1', 'proj1', LOGIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const stale = await service
      .acceptAccountConsent(
        'user1',
        'proj1',
        { textVersion: '2020-01-01-old', locale: 'uk' },
        null,
      )
      .catch((e: unknown) => e);
    expect(codeOf(stale)).toBe('SITE_TUTORIAL_CONSENT_VERSION_STALE');
    expect(
      accessPrisma.siteTutorialAccountConsent.create,
    ).not.toHaveBeenCalled();
  });

  it('подтверждение пишет {userId, домен, версия, язык, ipHash}; повтор не ломается', async () => {
    const { service, accessPrisma } = setupR({ sitesMode: 'B' });
    const view = await service.acceptAccountConsent(
      'user1',
      'proj1',
      {
        // Ссылка из тела при существующем черновике не слушается —
        // домен берётся из baseUrl черновика.
        url: 'https://evil.example.net',
        textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        locale: 'uk',
      },
      'a'.repeat(32),
    );
    expect(
      (accessPrisma.siteTutorialAccountConsent.create as jest.Mock).mock
        .calls[0][0].data,
    ).toEqual({
      userId: 'user1',
      registrableDomain: 'example.com',
      textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
      locale: 'uk',
      ipHash: 'a'.repeat(32),
    });
    expect(view.consent.accepted).toBe(true);
    (
      accessPrisma.siteTutorialAccountConsent.create as jest.Mock
    ).mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      service.acceptAccountConsent(
        'user1',
        'proj1',
        { textVersion: ACCOUNT_CONSENT_TEXT_VERSION, locale: 'uk' },
        null,
      ),
    ).resolves.toMatchObject({ consent: { accepted: true } });
  });

  it('пересчёт при подтверждении сайта: GET черновика берёт свежий режим B→A и пишет его', async () => {
    const { service, sites, accessPrisma } = setupR({
      sitesMode: 'B',
      draft: makeDraftRow({ siteMode: 'B' }),
    });
    const before = await service.getState('user1', 'proj1');
    expect(before).toMatchObject({ siteMode: 'B', access: { mode: 'B' } });
    (sites.hostStatus as jest.Mock).mockResolvedValueOnce({
      mode: 'A',
      host: 'shop.example.com',
      registrableDomain: 'example.com',
      hostId: 'host1',
      status: 'verified',
      expiresAt: null,
      optedOut: false,
      reason: null,
    });
    const after = await service.getState('user1', 'proj1');
    expect(after).toMatchObject({
      siteMode: 'A',
      access: { mode: 'A', reason: null, consent: { required: false } },
    });
    const writes = (
      accessPrisma.clientSiteTutorialDraft.updateMany as jest.Mock
    ).mock.calls;
    expect(writes.at(-1)[0].data.siteMode).toBe('A');
  });

  it('отзыв подтверждения сайта: A→B, и /login снова требует подтверждения прав', async () => {
    const { service, sites } = setupR({
      sitesMode: 'A',
      draft: makeDraftRow({ siteMode: 'A' }),
    });
    await expect(service.login('user1', 'proj1', LOGIN)).resolves.toBeDefined();
    (sites.hostStatus as jest.Mock).mockResolvedValue({
      mode: 'B',
      host: 'shop.example.com',
      registrableDomain: 'example.com',
      hostId: 'host1',
      status: 'revoked',
      expiresAt: null,
      optedOut: false,
      reason: 'revoked',
    });
    await expect(
      service.login('user1', 'proj1', { ...LOGIN, expectedVersion: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('одобренный черновик: GET не ходит в кабинет сайтов (фоновый опрос ролика)', async () => {
    const { service, sites } = setupR({
      draft: makeDraftRow({ status: 'APPROVED' }),
    });
    const view = await service.getState('user1', 'proj1');
    expect(view?.access).toBeNull();
    expect(sites.hostStatus).not.toHaveBeenCalled();
  });

  it('«Подтвердить сайт»: хост заводится в кабинете по Telegram-id; без Telegram — 409', async () => {
    const { service, sites } = setupR({ sitesMode: 'B' });
    const view = await service.registerSite('user1', 'proj1');
    expect(sites.registerHost).toHaveBeenCalledWith(
      '4242',
      'https://shop.example.com',
    );
    expect(view.mode).toBe('B');
    const dev = setupR({ telegramId: 'dev-7' });
    await expect(
      dev.service.registerSite('user1', 'proj1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(dev.sites.registerHost).not.toHaveBeenCalled();
  });

  it('до первого /explore: ссылка с внутренним адресом отклоняется ещё на /access', async () => {
    const { service, sites } = setupR({ draft: null });
    await expect(
      service.siteAccess('user1', 'proj1', 'http://127.0.0.1:8080/admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sites.hostStatus).not.toHaveBeenCalled();
  });
});

describe('П-Т2 по переключателю SITE_TUTORIAL_ACCOUNT_CONSENT (решение владельца 02.10.2026)', () => {
  const LOGIN = {
    expectedVersion: 3,
    submitSelector: '#submit',
    fields: [{ selector: '#pass', value: 'секрет', sensitive: true }],
  };
  const codeOf = (e: unknown) =>
    ((e as ConflictException).getResponse() as { code?: string }).code;
  const createCalls = (accessPrisma: PrismaService) =>
    (accessPrisma.siteTutorialAccountConsent.create as jest.Mock).mock.calls;

  it('разбор значения: пусто — journal; регистр и пробелы не важны; неизвестное — journal с сигналом', () => {
    const unknown: string[] = [];
    const p = (v?: string) =>
      accountConsentPolicy(
        v === undefined ? {} : { SITE_TUTORIAL_ACCOUNT_CONSENT: v },
        (raw) => unknown.push(raw),
      );
    expect(p()).toBe('journal');
    expect(p('')).toBe('journal');
    expect(p(' Required ')).toBe('required');
    expect(p('off')).toBe('off');
    expect(p('journal')).toBe('journal');
    expect(p('yes')).toBe('journal');
    expect(unknown).toEqual(['yes']);
  });

  it('неизвестное значение — warn в лог ОДИН раз, работаем как journal', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { service, access } = setup({
        draft: null,
        sitesMode: 'B',
        consentPolicy: 'strict',
      });
      for (let i = 0; i < 3; i++) {
        const view = await service.siteAccess(
          'user1',
          'proj1',
          'https://shop.example.com',
        );
        expect(view.consent).toMatchObject({
          policy: 'journal',
          required: false,
        });
      }
      expect(access.policy()).toBe('journal');
      const policyWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes('SITE_TUTORIAL_ACCOUNT_CONSENT'),
      );
      expect(policyWarns).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('journal (по умолчанию): B без галочки — /explore идёт, журнал пишет строку один раз', async () => {
    const { service, explorer, accessPrisma, access } = setup({
      draft: null,
      sitesMode: 'B',
    });
    const view = await service.siteAccess(
      'user1',
      'proj1',
      'https://shop.example.com',
    );
    expect(view.mode).toBe('B');
    expect(view.consent).toMatchObject({
      policy: 'journal',
      required: false,
      accepted: false,
    });

    await service.explore(
      'user1',
      'proj1',
      'https://shop.example.com/x',
      'b'.repeat(32),
    );
    expect(explorer.runRound).toHaveBeenCalled();
    expect(createCalls(accessPrisma)).toHaveLength(1);
    expect(createCalls(accessPrisma)[0][0].data).toEqual({
      userId: 'user1',
      registrableDomain: 'example.com',
      textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
      locale: JOURNAL_CONSENT_LOCALE,
      ipHash: 'b'.repeat(32),
    });
    // Следующий запуск по тому же домену — строка уже есть, второй не пишем.
    const again = await access.resolve('user1', 'https://admin.example.com');
    expect(again.consent.accepted).toBe(true);
    await access.gate('user1', 'https://admin.example.com', again, null);
    expect(createCalls(accessPrisma)).toHaveLength(1);
  });

  it.each([
    [
      '/step',
      (svc: ClientSiteTutorialService) =>
        svc.step(
          'user1',
          'proj1',
          { expectedVersion: 3, fills: [], clickSelector: '#a' },
          'h',
        ),
    ],
    [
      '/login',
      (svc: ClientSiteTutorialService) =>
        svc.login('user1', 'proj1', LOGIN, 'h'),
    ],
    [
      '/undo',
      (svc: ClientSiteTutorialService) => svc.undo('user1', 'proj1', 3, 'h'),
    ],
    [
      '/refresh',
      (svc: ClientSiteTutorialService) => svc.refresh('user1', 'proj1', 'h'),
    ],
    [
      '/live-login/start',
      (svc: ClientSiteTutorialService) =>
        svc.startLiveLogin('user1', 'proj1', 'h'),
    ],
  ])(
    'journal: %s в B без галочки не блокируется и пишет журнал',
    async (_n, call) => {
      const { service, accessPrisma } = setup({
        sitesMode: 'B',
        draft: makeDraftRow(THREE_ROUNDS),
      });
      await expect(call(service)).resolves.toBeDefined();
      expect(createCalls(accessPrisma)).toHaveLength(1);
      expect(createCalls(accessPrisma)[0][0].data).toMatchObject({
        locale: JOURNAL_CONSENT_LOCALE,
        ipHash: 'h',
      });
    },
  );

  it('journal: режим A — журнал не нужен (сайт подтверждён)', async () => {
    const { service, accessPrisma } = setup({ draft: null, sitesMode: 'A' });
    await service.explore('user1', 'proj1', 'https://shop.example.com');
    expect(createCalls(accessPrisma)).toHaveLength(0);
  });

  it('journal: повтор (P2002) и сбой записи журнала НЕ ломают запуск; в лог — без домена и пользователя', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const a = setup({ draft: null, sitesMode: 'B' });
      (
        a.accessPrisma.siteTutorialAccountConsent.create as jest.Mock
      ).mockRejectedValueOnce({ code: 'P2002' });
      await expect(
        a.service.explore('user1', 'proj1', 'https://shop.example.com'),
      ).resolves.toBeDefined();

      const b = setup({ draft: null, sitesMode: 'B' });
      (
        b.accessPrisma.siteTutorialAccountConsent.create as jest.Mock
      ).mockRejectedValueOnce(
        Object.assign(new Error('connection user1 example.com'), {
          code: 'P1001',
        }),
      );
      await expect(
        b.service.explore('user1', 'proj1', 'https://shop.example.com'),
      ).resolves.toBeDefined();
      expect(b.explorer.runRound).toHaveBeenCalled();
      const journalWarns = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('журнал'));
      expect(journalWarns).toHaveLength(1);
      expect(journalWarns[0]).toContain('P1001');
      expect(journalWarns[0]).not.toMatch(/user1|example\.com/);
    } finally {
      warn.mockRestore();
    }
  });

  it('off: ни ворот, ни журнала, базу подтверждений не читаем', async () => {
    const { service, accessPrisma } = setup({
      sitesMode: 'B',
      consentPolicy: 'off',
      draft: makeDraftRow(THREE_ROUNDS),
    });
    await expect(service.login('user1', 'proj1', LOGIN)).resolves.toBeDefined();
    await expect(service.refresh('user1', 'proj1')).resolves.toBeDefined();
    const view = await service.siteAccess('user1', 'proj1');
    expect(view.consent).toMatchObject({ policy: 'off', required: false });
    expect(createCalls(accessPrisma)).toHaveLength(0);
    expect(
      accessPrisma.siteTutorialAccountConsent.findUnique,
    ).not.toHaveBeenCalled();
  });

  it('journal → required: строка журнала — не подтверждение; галочка превращает её в настоящую', async () => {
    const j = setup({ sitesMode: 'B', draft: makeDraftRow(THREE_ROUNDS) });
    await j.service.refresh('user1', 'proj1', 'h');
    expect(createCalls(j.accessPrisma)[0][0].data.locale).toBe(
      JOURNAL_CONSENT_LOCALE,
    );
    // Тот же человек, та же база — переключатель сменили на required.
    j.access.env = {
      ...j.access.env,
      SITE_TUTORIAL_ACCOUNT_CONSENT: 'required',
    };
    const before = await j.service.siteAccess('user1', 'proj1');
    expect(before.consent).toMatchObject({ required: true, accepted: false });
    await expect(j.service.refresh('user1', 'proj1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    const after = await j.service.acceptAccountConsent(
      'user1',
      'proj1',
      { textVersion: ACCOUNT_CONSENT_TEXT_VERSION, locale: 'uk' },
      'c'.repeat(32),
    );
    expect(after.consent.accepted).toBe(true);
    expect(j.consentRows).toHaveLength(1);
    expect(j.consentRows[0]).toMatchObject({
      locale: 'uk',
      ipHash: 'c'.repeat(32),
    });
    await expect(j.service.refresh('user1', 'proj1')).resolves.toBeDefined();
  });

  it('journal → required: служебное подтверждение съёмщика переводит строку журнала в service', async () => {
    const j = setup({ sitesMode: 'B', draft: makeDraftRow(THREE_ROUNDS) });
    await j.service.refresh('user1', 'proj1', 'h');
    j.access.env = {
      ...j.access.env,
      SITE_TUTORIAL_ACCOUNT_CONSENT: 'required',
    };
    await j.access.recordServiceConsent('user1', 'https://shop.example.com');
    expect(j.consentRows).toHaveLength(1);
    expect(j.consentRows[0]).toMatchObject({ locale: 'service', ipHash: null });
    const view = await j.access.resolve('user1', 'https://shop.example.com');
    expect(view.consent).toMatchObject({ required: true, accepted: true });
  });

  it('/consent работает и в journal (на случай перехода в required)', async () => {
    const { service, accessPrisma } = setup({ sitesMode: 'B' });
    const view = await service.acceptAccountConsent(
      'user1',
      'proj1',
      { textVersion: ACCOUNT_CONSENT_TEXT_VERSION, locale: 'ru' },
      null,
    );
    expect(view.consent.accepted).toBe(true);
    expect(createCalls(accessPrisma)[0][0].data.locale).toBe('ru');
  });

  describe('required: ворота и на /live-login/complete (дефект 9)', () => {
    it('режим сменился на B за время сессии — 409, сессия реле закрыта, результат не забирается', async () => {
      const ctx = setup({ sitesMode: 'A', consentPolicy: 'required' });
      const start = await ctx.service.startLiveLogin('user1', 'proj1');
      (ctx.sites.hostStatus as jest.Mock).mockResolvedValue({
        mode: 'B',
        host: 'shop.example.com',
        registrableDomain: 'example.com',
        hostId: 'host1',
        status: 'revoked',
        expiresAt: null,
        optedOut: false,
        reason: 'revoked',
      });
      const err = await ctx.service
        .completeLiveLogin('user1', 'proj1', {
          ticket: start.ticket,
          expectedVersion: 3,
        })
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED');
      expect(ctx.relay.cancelQuietly).toHaveBeenCalledWith('relay-1');
      expect(ctx.relay.fetchResult).not.toHaveBeenCalled();
    });

    it('в journal завершение живого входа не проверяет режим заново', async () => {
      const ctx = setup({ sitesMode: 'B' });
      const start = await ctx.service.startLiveLogin('user1', 'proj1');
      const calls = (ctx.sites.hostStatus as jest.Mock).mock.calls.length;
      await expect(
        ctx.service.completeLiveLogin('user1', 'proj1', {
          ticket: start.ticket,
          expectedVersion: 3,
        }),
      ).resolves.toBeDefined();
      expect((ctx.sites.hostStatus as jest.Mock).mock.calls.length).toBe(calls);
    });
  });

  describe('кэш режима на черновике (дефект 10)', () => {
    const ago = (ms: number) => new Date(Date.now() - ms);

    it('раунд со свежим решением (< 10 мин) не ходит в sites-backend и не переписывает отметку', async () => {
      const { service, sites, accessPrisma } = setup({
        sitesMode: 'B',
        consentPolicy: 'required',
        consent: true,
        draft: makeDraftRow({
          ...THREE_ROUNDS,
          siteMode: 'B',
          siteModeCheckedAt: ago(60_000),
        }),
      });
      await service.step('user1', 'proj1', {
        expectedVersion: 3,
        fills: [],
        clickSelector: '#a',
      });
      expect(sites.hostStatus).not.toHaveBeenCalled();
      expect(
        accessPrisma.clientSiteTutorialDraft.updateMany,
      ).not.toHaveBeenCalled();
    });

    it('кэш не обходит ворота required: свежий B без галочки — всё равно 409', async () => {
      const { service, sites } = setup({
        sitesMode: 'B',
        consentPolicy: 'required',
        draft: makeDraftRow({
          siteMode: 'B',
          siteModeCheckedAt: ago(60_000),
        }),
      });
      const err = await service
        .login('user1', 'proj1', LOGIN)
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe('SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED');
      expect(sites.hostStatus).not.toHaveBeenCalled();
    });

    it('решение старше 10 мин — перепроверка и новая отметка', async () => {
      const { service, sites, accessPrisma } = setup({
        sitesMode: 'A',
        draft: makeDraftRow({
          siteMode: 'A',
          siteModeCheckedAt: ago(SITE_MODE_CACHE_MS + 1000),
        }),
      });
      await service.login('user1', 'proj1', LOGIN);
      expect(sites.hostStatus).toHaveBeenCalledTimes(1);
      expect(
        (accessPrisma.clientSiteTutorialDraft.updateMany as jest.Mock).mock
          .calls[0][0].data.siteModeCheckedAt,
      ).toBeInstanceOf(Date);
    });

    it('GET: свежий A — из черновика; B — перепроверяется (экрану нужна причина)', async () => {
      const a = setup({
        sitesMode: 'A',
        draft: makeDraftRow({
          siteMode: 'A',
          siteHostId: 'host1',
          siteModeCheckedAt: ago(60_000),
        }),
      });
      const viewA = await a.service.getState('user1', 'proj1');
      expect(viewA?.access).toMatchObject({ mode: 'A', hostId: 'host1' });
      expect(a.sites.hostStatus).not.toHaveBeenCalled();

      const b = setup({
        sitesMode: 'B',
        draft: makeDraftRow({
          siteMode: 'B',
          siteModeCheckedAt: ago(60_000),
        }),
      });
      const viewB = await b.service.getState('user1', 'proj1');
      expect(viewB?.access).toMatchObject({
        mode: 'B',
        reason: 'not_verified',
      });
      expect(b.sites.hostStatus).toHaveBeenCalledTimes(1);
    });

    it('явный /access спрашивает кабинет сайтов всегда', async () => {
      const { service, sites } = setup({
        sitesMode: 'A',
        draft: makeDraftRow({
          siteMode: 'A',
          siteModeCheckedAt: ago(1000),
        }),
      });
      await service.siteAccess('user1', 'proj1');
      expect(sites.hostStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('«липкий A» при сбое кабинета сайтов (дефект 1)', () => {
    const ago = (ms: number) => new Date(Date.now() - ms);

    it('A моложе суток + sites-backend не ответил — остаётся A, черновик не переписывается', async () => {
      const { service, accessPrisma } = setup({
        sitesMode: 'down',
        draft: makeDraftRow({
          siteMode: 'A',
          siteHostId: 'host1',
          siteModeCheckedAt: ago(2 * 3600_000),
        }),
      });
      const view = await service.siteAccess('user1', 'proj1');
      expect(view).toMatchObject({
        mode: 'A',
        reason: null,
        hostId: 'host1',
        cached: true,
      });
      expect(
        accessPrisma.clientSiteTutorialDraft.updateMany,
      ).not.toHaveBeenCalled();
    });

    it('A старше суток — B с причиной unavailable, без кнопки «Это мой сайт»', async () => {
      const { service, accessPrisma } = setup({
        sitesMode: 'down',
        draft: makeDraftRow({
          siteMode: 'A',
          siteModeCheckedAt: ago(STICKY_A_MS + 1000),
        }),
      });
      const view = await service.siteAccess('user1', 'proj1');
      expect(view).toMatchObject({
        mode: 'B',
        reason: 'unavailable',
        canRegister: false,
      });
      expect(
        (accessPrisma.clientSiteTutorialDraft.updateMany as jest.Mock).mock
          .calls[0][0].data.siteMode,
      ).toBe('B');
    });

    it('другой хост — не держим A (resolve с колонками чужого черновика)', async () => {
      const { access } = setup({ sitesMode: 'down' });
      const view = await access.resolve('user1', 'https://admin.example.com', {
        id: 'd',
        baseUrl: 'https://shop.example.com',
        siteMode: 'A',
        siteModeCheckedAt: ago(1000),
        siteHostId: 'host1',
      });
      expect(view).toMatchObject({ mode: 'B', reason: 'unavailable' });
    });

    it('B до сбоя — B (липким бывает только A)', async () => {
      const { service } = setup({
        sitesMode: 'down',
        draft: makeDraftRow({
          siteMode: 'B',
          siteModeCheckedAt: ago(1000),
        }),
      });
      await expect(service.siteAccess('user1', 'proj1')).resolves.toMatchObject(
        { mode: 'B', reason: 'unavailable' },
      );
    });
  });

  describe('причины и кнопка «Это мой сайт» (дефекты 4, 6, 12)', () => {
    it('адрес по IP — своя причина ip_address, в сеть не ходим, кнопки нет', async () => {
      const { service, sites } = setup({ draft: null, sitesMode: 'B' });
      const view = await service.siteAccess(
        'user1',
        'proj1',
        'https://93.184.216.34/',
      );
      expect(view).toMatchObject({
        mode: 'B',
        reason: 'ip_address',
        canRegister: false,
      });
      expect(sites.hostStatus).not.toHaveBeenCalled();
    });

    it.each([
      ['not_configured', { sitesMode: 'unconfigured' as const }],
      ['no_telegram', { telegramId: 'dev-1' }],
      ['unavailable', { sitesMode: 'down' as const }],
    ])('%s — кнопки нет (тупик)', async (reason, o) => {
      const { service } = setup({ draft: null, ...o });
      await expect(
        service.siteAccess('user1', 'proj1', 'https://shop.example.com'),
      ).resolves.toMatchObject({ mode: 'B', reason, canRegister: false });
    });

    it('no_account — кнопка есть (кабинет создаст /verify-site); not_registered — есть; оператор без своего кабинета (canRegister=false с сервера) — нет', async () => {
      const status = (over: Record<string, unknown>) => ({
        mode: 'B',
        host: 'shop.example.com',
        registrableDomain: 'example.com',
        hostId: null,
        status: 'none',
        expiresAt: null,
        optedOut: false,
        ...over,
      });
      const { service, sites } = setup({ draft: null, sitesMode: 'B' });
      const ask = () =>
        service.siteAccess('user1', 'proj1', 'https://shop.example.com');
      (sites.hostStatus as jest.Mock).mockResolvedValueOnce(
        status({ reason: 'no_account', canRegister: true }),
      );
      expect(await ask()).toMatchObject({
        reason: 'no_account',
        canRegister: true,
      });
      (sites.hostStatus as jest.Mock).mockResolvedValueOnce(
        status({ reason: 'not_registered', canRegister: true }),
      );
      expect((await ask()).canRegister).toBe(true);
      (sites.hostStatus as jest.Mock).mockResolvedValueOnce(
        status({ reason: 'role', hostId: 'h', canRegister: false }),
      );
      expect((await ask()).canRegister).toBe(false);
      // Старый sites-backend без поля — решают остальные условия.
      (sites.hostStatus as jest.Mock).mockResolvedValueOnce(
        status({ reason: 'not_registered' }),
      );
      expect((await ask()).canRegister).toBe(true);
    });

    it.each([
      ['не задан', null],
      ['не https', 'http://t.me/assist_bot'],
      ['мусор', 'not a url'],
    ])(
      'SITES_VERIFY_URL %s — кнопки «Это мой сайт» нет (подтверждать негде)',
      async (_n, verifyUrl) => {
        const { service, sites } = setup({
          draft: null,
          sitesMode: 'B',
          verifyUrl,
        });
        for (const reason of ['not_registered', 'no_account']) {
          (sites.hostStatus as jest.Mock).mockResolvedValueOnce({
            mode: 'B',
            host: 'shop.example.com',
            registrableDomain: 'example.com',
            hostId: null,
            status: 'none',
            expiresAt: null,
            optedOut: false,
            reason,
            canRegister: true,
          });
          await expect(
            service.siteAccess('user1', 'proj1', 'https://shop.example.com'),
          ).resolves.toMatchObject({
            reason,
            verifyUrl: null,
            canRegister: false,
          });
        }
      },
    );

    it('«Подтвердить сайт» при недоступном кабинете — нейтральный текст без «чужого сайта»', async () => {
      const { service, sites } = setup({ sitesMode: 'B' });
      (sites.registerHost as jest.Mock).mockRejectedValueOnce(
        new SitesUnavailableError('нет связи'),
      );
      const err = await service
        .registerSite('user1', 'proj1')
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe('SITE_TUTORIAL_SITES_UNAVAILABLE');
      const msg = (
        (err as ConflictException).getResponse() as { message: string }
      ).message;
      expect(msg).not.toMatch(/чуж/);
    });
  });

  describe('хеш адреса для журнала (дефект 8)', () => {
    it('на проде без настоящего секрета — NULL; с секретом и вне прода — HMAC', () => {
      expect(consentIpHash('203.0.113.7', { NODE_ENV: 'production' })).toBe(
        null,
      );
      for (const k of [
        'RATE_LIMIT_KEY_SECRET',
        'ASSISTANT_IP_HASH_SECRET',
        'CRON_SECRET',
      ]) {
        expect(
          consentIpHash('203.0.113.7', { NODE_ENV: 'production', [k]: 's' }),
        ).toMatch(/^[0-9a-f]{32}$/);
      }
      expect(consentIpHash('203.0.113.7', { NODE_ENV: 'test' })).toMatch(
        /^[0-9a-f]{32}$/,
      );
      expect(
        consentIpHash('203.0.113.7', {
          NODE_ENV: 'production',
          CRON_SECRET: '   ',
        }),
      ).toBe(null);
      expect(consentIpHash('unknown', {})).toBe(null);
      expect(consentIpHash(null, {})).toBe(null);
    });
  });
});

describe('Э-С Ш2: данные входа в хранилище sites-backend', () => {
  /** Сервис с хранилищем: `SITE_TUTORIAL_CREDENTIALS_STORE=sites`, поддельный API. */
  function withStore(
    opts: Parameters<typeof setup>[0] = {},
    fake = new FakeSitesCredentials(),
  ) {
    const base = setup(opts);
    const store = new DraftSecretsStore(
      base.accessPrisma,
      fake.client(),
      () => KEY,
      {
        log: jest.fn(),
        warn: jest.fn(),
      },
    );
    store.env = { SITE_TUTORIAL_CREDENTIALS_STORE: 'sites' };
    const service = new ClientSiteTutorialService(
      base.prisma,
      base.plans,
      base.usage,
      base.blob,
      base.relay,
      base.explorer,
      base.access,
      store,
    );
    return { ...base, fake, store, service };
  }

  const LOGIN = {
    expectedVersion: 3,
    submitSelector: '#submit',
    fields: [
      { selector: '#email', value: 'a@b.c', sensitive: false },
      { selector: '#pass', value: 'пароль-B', sensitive: true },
    ],
  };

  it('режим B: /login кладёт пароль в личную запись, колонки обнулены, наружу — только «есть данные»', async () => {
    const { service, fake, clientSiteTutorialDraft } = withStore({
      sitesMode: 'B',
      draft: makeDraftRow({ siteMode: 'B' }),
    });
    await service.login('user1', 'proj1', LOGIN);
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data).toMatchObject({
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: null,
      userSiteSessionId: expect.stringMatching(/^user-/),
      storeHasCredentials: true,
    });
    expect(JSON.stringify(data)).not.toContain('пароль-B');
    const rec = fake.records.get(data.userSiteSessionId)!;
    expect(rec.owner).toBe('gen:user1');
    expect(rec.secrets['login-fields']).toContain('пароль-B');
  });

  it('режим B «как сейчас»: /undo переигрывает вход сохранённым паролем', async () => {
    const fake = new FakeSitesCredentials();
    const rec = (
      await fake.client().upsertUserSession('gen:user1', {
        origin: 'https://shop.example.com',
        clientRef: 'project:proj1',
      })
    ).id;
    await fake
      .client()
      .putUserSessionSecret(
        'gen:user1',
        rec,
        'login-fields',
        JSON.stringify([{ selector: '#pass', value: 'пароль-B' }]),
      );
    const { service, explorer } = withStore(
      {
        sitesMode: 'B',
        draft: makeDraftRow({
          ...THREE_ROUNDS,
          siteMode: 'B',
          userSiteSessionId: rec,
        }),
      },
      fake,
    );
    await service.undo('user1', 'proj1', 3);
    const replay = (explorer.replay as jest.Mock).mock.calls.at(-1)[0];
    expect(replay.secrets).toEqual({ '#pass': 'пароль-B' });
    expect(fake.calls).toContain('readUserSession');
  });

  it('режим A: /login заводит учётку реестра на хосте черновика, /undo берёт пароль арендой', async () => {
    const { service, fake, clientSiteTutorialDraft, explorer } = withStore({
      sitesMode: 'A',
      draft: makeDraftRow({
        ...THREE_ROUNDS,
        siteMode: 'A',
        siteHostId: 'host1',
        siteModeCheckedAt: new Date(),
      }),
    });
    await service.login('user1', 'proj1', LOGIN);
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.siteTestAccountId).toMatch(/^site-/);
    expect(fake.records.get(data.siteTestAccountId)!.hostIds).toEqual([
      'host1',
    ]);

    clientSiteTutorialDraft.findUnique.mockResolvedValue(
      makeDraftRow({
        ...THREE_ROUNDS,
        siteMode: 'A',
        siteHostId: 'host1',
        siteModeCheckedAt: new Date(),
        siteTestAccountId: data.siteTestAccountId,
      }),
    );
    await service.undo('user1', 'proj1', 3);
    const replay = (explorer.replay as jest.Mock).mock.calls.at(-1)[0];
    expect(replay.secrets).toEqual({ '#pass': 'пароль-B' });
    expect(fake.calls.filter((c) => c.startsWith('leaseSecrets'))).toEqual(
      expect.arrayContaining(['leaseSecrets:draft:draft1']),
    );
  });

  it('черновик в хранилище, хранилище недоступно — 503 ДО занятия версии и слота', async () => {
    const { service, fake, clientSiteTutorialDraft, usage } = withStore({
      sitesMode: 'B',
      draft: makeDraftRow({ siteMode: 'B', userSiteSessionId: 'user-9' }),
    });
    fake.offline = true;
    await expect(
      service.step('user1', 'proj1', {
        expectedVersion: 3,
        fills: [{ selector: '#a', value: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
    expect(usage.reserveRound).not.toHaveBeenCalled();
  });

  it('хранилище включено, но sites-backend без ключей — раунд пишет в колонки (фолбэк)', async () => {
    const { service, fake, clientSiteTutorialDraft } = withStore({
      sitesMode: 'B',
      draft: makeDraftRow({ siteMode: 'B' }),
    });
    fake.unconfigured = true;
    await service.login('user1', 'proj1', LOGIN);
    const data = clientSiteTutorialDraft.updateMany.mock.calls.at(-1)[0].data;
    expect(data.credentialsEnc).toEqual(expect.any(String));
    expect(data.userSiteSessionId).toBeUndefined();
  });

  it('удаление черновика стирает личную запись в хранилище', async () => {
    const fake = new FakeSitesCredentials();
    const id = (
      await fake.client().upsertUserSession('gen:user1', {
        origin: 'https://shop.example.com',
        clientRef: 'project:proj1',
      })
    ).id;
    const { service: svc, clientSiteTutorialDraft } = withStore(
      { sitesMode: 'B', draft: makeDraftRow({ userSiteSessionId: id }) },
      fake,
    );
    await svc.remove('user1', 'proj1');
    expect(fake.records.has(id)).toBe(false);
    expect(clientSiteTutorialDraft.deleteMany).toHaveBeenCalled();
  });

  it('hasCredentials — и по хранилищу, без похода в sites-backend', async () => {
    const { service, fake } = withStore({
      draft: makeDraftRow({
        status: 'PENDING_REVIEW',
        userSiteSessionId: 'user-1',
        storeHasCredentials: true,
      }),
    });
    const view = (await service.getState('user1', 'proj1'))!;
    expect(view.hasCredentials).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

describe('аудит Э6, Д1: липкий признак входа loginUsedAt', () => {
  /** Кука первой стороны — её сайт ставит и на публичных страницах. */
  const SITE_COOKIE = {
    name: '_ga',
    value: 'GA1.2.1',
    domain: '.shop.example.com',
    path: '/',
    secure: true,
    httpOnly: false,
    expires: -1,
  };
  const roundWith = (over: Record<string, unknown> = {}) => ({
    runRound: jest.fn().mockResolvedValue({
      exploration: EXPLORATION,
      cookies: [SITE_COOKIE],
      ...over,
    }),
    replay: jest.fn().mockResolvedValue({
      exploration: EXPLORATION,
      cookies: [SITE_COOKIE],
      ...over,
    }),
  });
  /** Как в жизни: прошлые раунды писали куки и `secretsUsedAt`. */
  const liveRow = (over: Record<string, unknown> = {}) =>
    makeDraftRow({
      secretsUsedAt: new Date('2027-01-20T10:00:00Z'),
      loginUsedAt: null,
      ...over,
    });
  const lastData = (draft: { updateMany: jest.Mock }) =>
    draft.updateMany.mock.calls.at(-1)[0].data;

  it('/explore с куками сайта — признака нет', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: null,
      explorer: roundWith(),
    });
    await service.explore('user1', 'proj1', 'https://shop.example.com/');
    const data = clientSiteTutorialDraft.create.mock.calls[0][0].data;
    expect(data.cookiesEnc).toEqual(expect.any(String));
    expect(data.secretsUsedAt).toEqual(expect.any(Date));
    expect(data).not.toHaveProperty('loginUsedAt');
  });

  it('/step с обычным вводом и куками, secretsUsedAt стоит — признака нет', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: liveRow(),
      explorer: roundWith(),
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [{ selector: 'input[name="q"]', value: 'чайник' }],
      clickSelector: '#search',
    });
    const data = lastData(clientSiteTutorialDraft);
    expect(data.cookiesEnc).toEqual(expect.any(String));
    expect(data.secretsUsedAt).toEqual(expect.any(Date));
    expect(data).not.toHaveProperty('loginUsedAt');
  });

  it('/step: разведчик увидел поле пароля/кода — признак ставится', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: liveRow(),
      explorer: roundWith({ sensitiveFill: true }),
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [{ selector: '#field-2', value: '123456' }],
    });
    expect(lastData(clientSiteTutorialDraft).loginUsedAt).toEqual(
      expect.any(Date),
    );
  });

  it('/step: селектор похож на пароль/код — признак ставится', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: liveRow(),
      explorer: roundWith(),
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [{ selector: 'input[name="otp"]', value: '123456' }],
    });
    expect(lastData(clientSiteTutorialDraft).loginUsedAt).toEqual(
      expect.any(Date),
    );
  });

  it('/login — признак ставится; уже стоявший не переписывается', async () => {
    const LOGIN = {
      expectedVersion: 3,
      submitSelector: '#submit',
      fields: [{ selector: '#email', value: 'a@b.c', sensitive: true }],
    };
    const a = setup({ draft: liveRow(), explorer: roundWith() });
    await a.service.login('user1', 'proj1', LOGIN);
    expect(lastData(a.clientSiteTutorialDraft).loginUsedAt).toEqual(
      expect.any(Date),
    );
    const first = new Date('2027-01-01T00:00:00Z');
    const b = setup({
      draft: liveRow({ loginUsedAt: first }),
      explorer: roundWith(),
    });
    await b.service.login('user1', 'proj1', LOGIN);
    expect(lastData(b.clientSiteTutorialDraft).loginUsedAt).toBe(first);
  });

  it('раунд читает из колонок сохранённые поля входа — признак ставится (черновик до флага)', async () => {
    const { encryptCredentials } = jest.requireActual('./draft-credentials');
    const { service, clientSiteTutorialDraft } = setup({
      draft: liveRow({
        credentialsEnc: encryptCredentials(
          [{ selector: '#pass', value: 'x' }],
          KEY,
        ),
      }),
      explorer: roundWith(),
    });
    await service.step('user1', 'proj1', {
      expectedVersion: 3,
      fills: [],
      clickSelector: '#next',
    });
    expect(lastData(clientSiteTutorialDraft).loginUsedAt).toEqual(
      expect.any(Date),
    );
  });

  it('/undo, переигрывающий вход (секретное поле в оставшихся шагах), — признак ставится', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: liveRow({ ...THREE_ROUNDS }),
      explorer: roundWith(),
    });
    await service.undo('user1', 'proj1', 3);
    expect(lastData(clientSiteTutorialDraft).loginUsedAt).toEqual(
      expect.any(Date),
    );
  });

  it('/undo публичного сценария — признака нет', async () => {
    const { service, clientSiteTutorialDraft } = setup({
      draft: liveRow({
        steps: [
          { kind: 'goto', route: 'https://shop.example.com' },
          { kind: 'click', selector: '#catalog' },
          { kind: 'click', selector: '#buy' },
        ],
        stepsPerRound: [1, 1, 1],
        roundScreenshots: ['к1', 'к2', 'к3'],
      }),
      explorer: roundWith(),
    });
    await service.undo('user1', 'proj1', 3);
    expect(lastData(clientSiteTutorialDraft)).not.toHaveProperty('loginUsedAt');
  });

  it('живой вход: старт ставит признак сразу, завершение — тоже', async () => {
    const { service, clientSiteTutorialDraft } = setup({ draft: liveRow() });
    const start = await service.startLiveLogin('user1', 'proj1');
    expect(clientSiteTutorialDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft1', loginUsedAt: null },
      data: { loginUsedAt: expect.any(Date) },
    });
    await service.completeLiveLogin('user1', 'proj1', {
      ticket: start.ticket,
      expectedVersion: 3,
    });
    expect(lastData(clientSiteTutorialDraft).loginUsedAt).toEqual(
      expect.any(Date),
    );
  });

  it('снимок (/refresh) с прочитанными полями входа — признак до браузера; без них — ничего', async () => {
    const { encryptCredentials } = jest.requireActual('./draft-credentials');
    const a = setup({
      draft: liveRow({
        credentialsEnc: encryptCredentials(
          [{ selector: '#pass', value: 'x' }],
          KEY,
        ),
      }),
    });
    await a.service.refresh('user1', 'proj1');
    expect(a.clientSiteTutorialDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft1', loginUsedAt: null },
      data: { loginUsedAt: expect.any(Date) },
    });
    const b = setup({ draft: liveRow() });
    await b.service.refresh('user1', 'proj1');
    expect(b.clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
  });

  describe('хранилище Ш2', () => {
    function withStore(
      opts: Parameters<typeof setup>[0],
      fake = new FakeSitesCredentials(),
    ) {
      const base = setup(opts);
      const store = new DraftSecretsStore(
        base.accessPrisma,
        fake.client(),
        () => KEY,
        { log: jest.fn(), warn: jest.fn() },
      );
      store.env = { SITE_TUTORIAL_CREDENTIALS_STORE: 'sites' };
      const service = new ClientSiteTutorialService(
        base.prisma,
        base.plans,
        base.usage,
        base.blob,
        base.relay,
        base.explorer,
        base.access,
        store,
      );
      return { ...base, fake, store, service };
    }

    it('B: раунд по личной записи только с куками — признака нет; запись с полями входа — признак', async () => {
      const fake = new FakeSitesCredentials();
      const rec = (
        await fake.client().upsertUserSession('gen:user1', {
          origin: 'https://shop.example.com',
          clientRef: 'draft:draft1',
        })
      ).id;
      await fake
        .client()
        .putUserSessionSecret('gen:user1', rec, 'session-cookies', '[]');
      const STEP = {
        expectedVersion: 3,
        fills: [],
        clickSelector: '#next',
      };
      const a = withStore(
        {
          sitesMode: 'B',
          draft: liveRow({ siteMode: 'B', userSiteSessionId: rec }),
          explorer: roundWith(),
        },
        fake,
      );
      await a.service.step('user1', 'proj1', STEP);
      expect(lastData(a.clientSiteTutorialDraft)).not.toHaveProperty(
        'loginUsedAt',
      );
      await fake
        .client()
        .putUserSessionSecret(
          'gen:user1',
          rec,
          'login-fields',
          JSON.stringify([{ selector: '#pass', value: 'x' }]),
        );
      const b = withStore(
        {
          sitesMode: 'B',
          draft: liveRow({ siteMode: 'B', userSiteSessionId: rec }),
          explorer: roundWith(),
        },
        fake,
      );
      await b.service.step('user1', 'proj1', STEP);
      expect(lastData(b.clientSiteTutorialDraft).loginUsedAt).toEqual(
        expect.any(Date),
      );
    });

    it('B: /explore двух черновиков пользователя — РАЗНЫЕ личные записи (не общий «draft:new»)', async () => {
      const fake = new FakeSitesCredentials();
      const ids: string[] = [];
      for (const url of [
        'https://shop.example.com/',
        'https://other.example.org/',
      ]) {
        const { service, clientSiteTutorialDraft } = withStore(
          {
            sitesMode: 'B',
            draft: null,
            explorer: roundWith({
              exploration: { ...EXPLORATION, currentUrl: url },
              cookies: [{ ...SITE_COOKIE, domain: new URL(url).hostname }],
            }),
          },
          fake,
        );
        await service.explore('user1', 'proj1', url);
        const data = clientSiteTutorialDraft.create.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('loginUsedAt');
        ids.push(data.userSiteSessionId);
      }
      expect(ids[0]).toEqual(expect.stringMatching(/^user-/));
      expect(ids[1]).toEqual(expect.stringMatching(/^user-/));
      expect(ids[0]).not.toBe(ids[1]);
    });
  });
});
