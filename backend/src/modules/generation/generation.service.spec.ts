/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles: private fetchReference */
/**
 * Денежный шлюз перед Veo (ТЗ §25.3, §26.4).
 *
 * Генерация — самый дорогой вызов сервиса, и `assertCanSpendUser` перед
 * ней — единственное, что стоит между заблокированным (или исчерпавшим
 * дневной лимит) пользователем и счётом за рендер. Проверка не имеет
 * дублёра ниже по стеку: если её убрать, ни один другой тест этого не
 * заметит, а узнаем мы по счёту от Google.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
const generateVideos = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateVideos },
    operations: { getVideosOperation: jest.fn() },
  })),
  VideoGenerationReferenceType: { ASSET: 'ASSET' },
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GenerationService,
  VeoOperationOrphanedError,
} from './generation.service';
import { SessionStatus } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';

// Сервис отказывается собираться без ключа, а тесты здесь про деньги, а
// не про ключ. Ставим и убираем за собой: process.env общий на весь
// воркер jest, и подброшенный ключ сломал бы соседнюю спеку, которая
// проверяет поведение ИМЕННО без ключа.
const keyBefore = process.env.GOOGLE_GEMINI_API_KEY;
beforeAll(() => {
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = keyBefore;
});

/** Сессия, готовая к генерации: промпт утверждён, фото товара на месте. */
const readySession = (userId: string | null = 'u1') => ({
  sessionId: 's1',
  userId,
  generationPrompt: { finalText: 'реклама кроссовок', approvedAt: new Date() },
  productInformation: {
    productImagePathname: 'sessions/s1/product-image.jpg',
    productImageMimeType: 'image/jpeg',
  },
});

function build(session: unknown = readySession()) {
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('изображение')),
    uploadBuffer: jest.fn(),
  };
  const plans = {
    assertUserNotBlocked: jest.fn().mockResolvedValue(undefined),
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
    accessOf: jest.fn().mockResolvedValue({
      plan: 'PREMIUM',
      isBlocked: false,
      blockedReason: null,
    }),
  };
  const aiUsage = { record: jest.fn() };
  const postprod = { start: jest.fn(), poll: jest.fn() };
  // ТЗ §28: провал рендера уходит тревогой в служебный канал.
  const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };
  // Этап 60: счётчик конверсии страницы шеринга — best-effort, мок молчит.
  const sharedVideos = {
    markConverted: jest.fn().mockResolvedValue(undefined),
  };
  // Этап 62: по умолчанию кредита нет — деньги проходят обычным путём
  // через `assertCanSpendUser` (см. заголовок файла), как и раньше.
  const creditLedger = {
    reserveForGeneration: jest.fn().mockResolvedValue(false),
    refundIfReserved: jest.fn().mockResolvedValue(undefined),
  };
  // Доп. запрос владельца продукта: Grok как провайдер (§10-11 ТЗ) —
  // по умолчанию не настроен, тот же принцип, что уже настроенные
  // моки выше (пустые/false по умолчанию, тесты сами переопределяют
  // нужное).
  const grokVideo = {
    isConfigured: jest.fn().mockReturnValue(false),
    startGeneration: jest.fn(),
    getStatus: jest.fn(),
    modelName: 'grok-imagine-video-1.5',
  };
  const promptService = {
    rewriteForGrokReferences: jest.fn().mockResolvedValue('rewritten scene'),
  };
  const svc = new GenerationService(
    sessions as never,
    blob as never,
    plans as never,
    aiUsage as never,
    postprod as never,
    notify as never,
    sharedVideos as never,
    creditLedger as never,
    grokVideo as never,
    promptService as never,
  );
  return {
    svc,
    sessions,
    blob,
    plans,
    aiUsage,
    postprod,
    sharedVideos,
    creditLedger,
    grokVideo,
    promptService,
  };
}

beforeEach(() => {
  generateVideos.mockReset();
  generateVideos.mockResolvedValue({ name: 'operations/veo-1' });
});

describe('GenerationService.generateVideo — деньги проверяются до Veo', () => {
  it('отказ по блокировке или лимиту останавливает генерацию до вызова Veo', async () => {
    const { svc, sessions, blob, plans, aiUsage } = build();
    plans.assertCanSpendUser.mockRejectedValue(
      new ForbiddenException('Платные операции приостановлены'),
    );

    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // Ни рендера, ни строки расхода, ни статуса «идёт генерация»: отказ
    // должен быть полным. Сессия, помеченная GENERATING_VIDEO без
    // операции в Veo, — это тупик, из которого интерфейсом не выйти.
    expect(generateVideos).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
  });

  it('лимит спрашивается у ВЛАДЕЛЬЦА сессии, а не у предъявителя', async () => {
    // Маршрут генерации открыт и предъявителем считает UUID сессии
    // (§7.8). Спроси мы права у «текущего пользователя», анонимный
    // вызов с чужим UUID тратил бы лимит владельца, а сам владелец —
    // терял свой пакет на каждом открытом маршруте.
    const { svc, plans } = build();
    await svc.generateVideo('s1');
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith('u1');
  });

  it('анонимная сессия тоже проходит через проверку — под общим лимитом', async () => {
    // §26.4: у анонимных общий потолок на всех. Пропустить их мимо
    // проверки значило бы отдать самый дорогой вызов сервиса без счёта.
    const { svc, plans } = build(readySession(null));
    await svc.generateVideo('s1');
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith(null);
  });

  it('проверка стоит РАНЬШЕ вызова Veo, а не рядом с ним', async () => {
    // Порядок здесь и есть смысл проверки: разрешение, полученное после
    // старта рендера, уже ничего не отменяет — деньги потрачены.
    const order: string[] = [];
    const { svc, plans } = build();
    plans.assertCanSpendUser.mockImplementation(async () => {
      order.push('проверка');
    });
    generateVideos.mockImplementation(async () => {
      order.push('veo');
      return { name: 'operations/veo-1' };
    });

    await svc.generateVideo('s1');
    expect(order).toEqual(['проверка', 'veo']);
  });

  it('расход пишется в момент ЗАПУСКА рендера, а не по его завершении', async () => {
    // Занизить отчёт о расходах опаснее, чем завысить: по нему планируют
    // бюджет, а невидимые неудачные рендеры превращают его в фантазию.
    const { svc, aiUsage } = build();
    const video = await svc.generateVideo('s1', 'standard');

    expect(aiUsage.record).toHaveBeenCalledWith({
      operation: 'generation',
      model: 'veo-3.1-generate-preview',
      seconds: 8,
      sessionId: 's1',
    });
    expect(video.status).toBe(GenerationStatus.PROCESSING);
    expect(video.veoOperationName).toBe('operations/veo-1');
  });

  it('сессия помечается «идёт генерация» только после ответа Veo', async () => {
    const { svc, sessions } = build();
    await svc.generateVideo('s1');
    expect(sessions.updateSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ status: SessionStatus.GENERATING_VIDEO }),
    );
  });

  it('Veo не вернул операцию — отслеживать нечего, сессия не трогается', async () => {
    // Без имени операции опрос статуса невозможен: пользователь получил
    // бы вечное «идёт рендер» вместо честной ошибки.
    const { svc, sessions } = build();
    generateVideos.mockResolvedValue({});
    await expect(svc.generateVideo('s1')).rejects.toThrow(
      /did not return an operation/,
    );
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('заблокированный отказывается ДО замка и до кредитного резерва', async () => {
    // Этап 62: блокировка проверяется в generateVideo() самой первой —
    // до claimWork и до попытки списать кредит, а не внутри startGeneration.
    const { svc, sessions, plans, creditLedger } = build();
    plans.assertUserNotBlocked.mockRejectedValue(
      new ForbiddenException('Платные операции приостановлены'),
    );
    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sessions.claimWork).not.toHaveBeenCalled();
    expect(creditLedger.reserveForGeneration).not.toHaveBeenCalled();
    expect(generateVideos).not.toHaveBeenCalled();
  });
});

/**
 * Этап 62 (ТЗ §41.1): кредит — это оплаченный ролик, списывается при
 * старте рендера и возвращается при неудаче.
 */
describe('GenerationService.generateVideo — кредитный пакет', () => {
  it('есть кредит — суточный лимит вообще не спрашивается', async () => {
    const { svc, plans, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    await svc.generateVideo('s1');
    expect(creditLedger.reserveForGeneration).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
    );
    expect(plans.assertCanSpendUser).not.toHaveBeenCalled();
    expect(generateVideos).toHaveBeenCalled();
  });

  it('нет кредита — старый путь через суточный лимит, как раньше', async () => {
    const { svc, plans, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(false);
    await svc.generateVideo('s1');
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith('u1');
  });

  it('резерв кредита — по стабильному generatedVideoId, а не по сессии', async () => {
    // Ключ идемпотентности резерва/возврата — конкретная ПОПЫТКА рендера,
    // не сессия (в одной сессии рендеров может быть несколько подряд).
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    const video = await svc.generateVideo('s1');
    expect(creditLedger.reserveForGeneration).toHaveBeenCalledWith(
      'u1',
      video.generatedVideoId,
    );
  });

  it('повторный запрос на идущую операцию не резервирует кредит второй раз', async () => {
    // Б-2.3: у идущей операции есть быстрый путь — она даже не доходит до
    // startGeneration, значит и до резерва кредита.
    const inFlight = {
      ...readySession(),
      generatedVideo: {
        generatedVideoId: 'v1',
        status: GenerationStatus.PROCESSING,
        veoOperationName: 'operations/veo-1',
      },
    };
    const { svc, creditLedger } = build(inFlight);
    await svc.generateVideo('s1');
    expect(creditLedger.reserveForGeneration).not.toHaveBeenCalled();
  });
});

/**
 * Г-2.3 (аудит round4, этап 64): кредит списывается ДО старта Veo
 * (`reserveForGeneration`, см. блок выше) — если после этого что-то
 * бросает раньше, чем `updateSession` успеет сохранить `generatedVideo`,
 * ролика не было, а кредит был бы потерян навсегда. Кредит должен
 * вернуться при ЛЮБОМ сбое в этом промежутке, не только при явном отказе
 * Veo.
 */
describe('GenerationService.generateVideo — возврат кредита при сбое старта (Г-2.3)', () => {
  it('Veo отклонил запрос — кредит возвращается', async () => {
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    generateVideos.mockRejectedValue(new Error('quota exceeded'));

    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(creditLedger.refundIfReserved).toHaveBeenCalledWith(
      expect.any(String),
    );
    // Тот же generatedVideoId, что был зарезервирован — не случайный
    // другой uuid.
    const reservedId = creditLedger.reserveForGeneration.mock.calls[0][1];
    const refundedId = creditLedger.refundIfReserved.mock.calls[0][0];
    expect(refundedId).toBe(reservedId);
  });

  it('Е-1.2 шестого аудита: транзиентный сбой Veo (429/5xx у @google/genai) — ServiceUnavailableException, НЕ BadRequestException', async () => {
    // Воркеры партии/A-B классифицируют BadRequestException как "не
    // повторять" по имени класса — до этой правки транзиентный сбой
    // (лимит скорости, временная недоступность) уводил строку партии в
    // FAILED навсегда неотличимо от постоянной ошибки валидации запроса.
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    generateVideos.mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(creditLedger.refundIfReserved).toHaveBeenCalled();

    creditLedger.refundIfReserved.mockClear();
    generateVideos.mockRejectedValue(
      Object.assign(new Error('internal error'), { status: 503 }),
    );
    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(creditLedger.refundIfReserved).toHaveBeenCalled();
  });

  it('Е-1.2: сбой Veo БЕЗ числового .status (валидационная ошибка) — остаётся BadRequestException, как раньше', async () => {
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    generateVideos.mockRejectedValue(
      Object.assign(new Error('invalid prompt'), { status: 400 }),
    );
    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(creditLedger.refundIfReserved).toHaveBeenCalled();
  });

  it('Е-1.4 шестого аудита: Veo не вернул operation.name — кредит НЕ возвращается (деньги, скорее всего, уже потрачены)', async () => {
    // До фикса: это тоже уходило в обычный refundIfReserved, хотя Veo
    // ответила без ошибки — значит запрос почти наверняка принят и
    // деньги потрачены, просто зацепиться не за что. Автоматический
    // возврат кредита здесь создавал риск бесплатного повтора реального
    // платного рендера.
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    generateVideos.mockResolvedValue({});

    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      VeoOperationOrphanedError,
    );
    expect(creditLedger.refundIfReserved).not.toHaveBeenCalled();
  });

  it('Е-1.4 шестого аудита: запись сессии после успешного старта Veo упала — кредит НЕ возвращается, ошибка — VeoOperationOrphanedError', async () => {
    // Самый поздний из возможных сбоев: Veo уже стартовал (деньги ушли и
    // Google уже работает), но записать generatedVideo в сессию не
    // удалось. До этого фикса (Г-2.3) кредит возвращался безусловно —
    // но это означало, что либо оплаченный рендер остаётся никак не
    // привязанным, либо (что хуже) обычный повтор пользователя после
    // "ошибки" запускает ВТОРОЙ настоящий платный рендер того же ролика.
    // Теперь кредит остаётся списанным намеренно — разбор ручной.
    const { svc, sessions, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    sessions.updateSession.mockRejectedValue(new Error('db unavailable'));

    const err = await svc.generateVideo('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VeoOperationOrphanedError);
    expect((err as VeoOperationOrphanedError).operationName).toBe(
      'operations/veo-1',
    );
    expect((err as Error).message).toMatch(/operations\/veo-1/);
    expect(creditLedger.refundIfReserved).not.toHaveBeenCalled();
  });

  it('скачивание референса упало — кредит возвращается, Veo не звался', async () => {
    const { svc, blob, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    blob.downloadBuffer.mockRejectedValue(new Error('blob 404'));

    await expect(svc.generateVideo('s1')).rejects.toThrow('blob 404');
    expect(generateVideos).not.toHaveBeenCalled();
    expect(creditLedger.refundIfReserved).toHaveBeenCalled();
  });

  it('кредита не было (обычный дневной лимит) — сбой всё равно не роняет вызов refundIfReserved, он безопасный no-op', async () => {
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(false);
    generateVideos.mockRejectedValue(new Error('quota exceeded'));

    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Вызывается всегда — no-op на стороне CreditLedgerService, если
    // резерва не было (проверено отдельно в credit-ledger.service.spec.ts).
    expect(creditLedger.refundIfReserved).toHaveBeenCalled();
  });

  it('успешный старт — refundIfReserved не зовётся', async () => {
    const { svc, creditLedger } = build();
    creditLedger.reserveForGeneration.mockResolvedValue(true);
    await svc.generateVideo('s1');
    expect(creditLedger.refundIfReserved).not.toHaveBeenCalled();
  });
});

/**
 * Б-2.3: повтор запроса не оплачивает второй рендер.
 *
 * Метод не смотрел на `session.generatedVideo` вообще. Сборка
 * референсов и старт Veo не всегда укладываются в клиентский таймаут
 * (120 с); пользователь жал кнопку ещё раз — и получал вторую операцию,
 * вторую строку расхода и затёртый `generatedVideo`: первый, уже
 * оплаченный рендер осиротевал вместе со своим `veoOperationName`.
 */
describe('GenerationService.generateVideo — повтор при идущем рендере', () => {
  const inFlight = (status: GenerationStatus) => ({
    ...readySession(),
    generatedVideo: {
      generatedVideoId: 'v1',
      status,
      veoOperationName: 'operations/veo-1',
    },
  });

  it('второй запрос возвращает ту же операцию и не зовёт Veo', async () => {
    for (const status of [
      GenerationStatus.PENDING,
      GenerationStatus.PROCESSING,
    ]) {
      const { svc, sessions, aiUsage } = build(inFlight(status));
      const r = await svc.generateVideo('s1');
      expect(r.veoOperationName).toBe('operations/veo-1');
      expect(generateVideos).not.toHaveBeenCalled();
      // Ни второго счёта, ни перезаписи сессии — иначе первый рендер
      // становится недостижимым.
      expect(aiUsage.record).not.toHaveBeenCalled();
      expect(sessions.updateSession).not.toHaveBeenCalled();
      generateVideos.mockClear();
    }
  });

  it('готовый или упавший рендер повтору не мешает', async () => {
    // «Сгенерировать ещё раз» после результата — обычный сценарий, в том
    // числе после аудита с исправленным промптом.
    for (const status of [GenerationStatus.COMPLETE, GenerationStatus.FAILED]) {
      const { svc } = build(inFlight(status));
      await svc.generateVideo('s1');
      expect(generateVideos).toHaveBeenCalled();
      generateVideos.mockClear();
    }
  });
});

describe('GenerationService.generateVideo — история версий (доп. запрос владельца продукта)', () => {
  it('путь в Blob уникален на попытку — раньше был фиксированным и затирал прошлую версию', async () => {
    const { svc, sessions } = build();
    const video = await svc.generateVideo('s1');
    expect(video.pathname).toBe(`sessions/s1/generated-${video.generatedVideoId}.mp4`);
    const [, patch] = sessions.updateSession.mock.calls[0];
    expect(patch.generatedVideo.pathname).toBe(video.pathname);
  });

  it('нет прошлой попытки — videoHistory пустой, ничего не архивируется', async () => {
    const { svc, sessions } = build();
    await svc.generateVideo('s1');
    const [, patch] = sessions.updateSession.mock.calls[0];
    expect(patch.videoHistory).toEqual([]);
  });

  it('прошлая попытка COMPLETE/FAILED — архивируется в videoHistory ПЕРЕД перезаписью', async () => {
    for (const status of [GenerationStatus.COMPLETE, GenerationStatus.FAILED]) {
      const previous = {
        generatedVideoId: 'old-1',
        status,
        pathname: 'sessions/s1/generated-old-1.mp4',
      };
      const { svc, sessions } = build({
        ...readySession(),
        generatedVideo: previous,
      });
      const video = await svc.generateVideo('s1');
      const [, patch] = sessions.updateSession.mock.calls[0];
      expect(patch.videoHistory).toEqual([previous]);
      // Новая попытка остаётся в generatedVideo, не в истории.
      expect(patch.generatedVideo.generatedVideoId).toBe(video.generatedVideoId);
      sessions.updateSession.mockClear();
    }
  });

  it('прошлая история сохраняется — новая версия становится первой (самой свежей), не заменяет список', async () => {
    const olderStill = { generatedVideoId: 'old-0', status: GenerationStatus.FAILED };
    const previous = { generatedVideoId: 'old-1', status: GenerationStatus.COMPLETE };
    const { svc, sessions } = build({
      ...readySession(),
      generatedVideo: previous,
      videoHistory: [olderStill],
    });
    await svc.generateVideo('s1');
    const [, patch] = sessions.updateSession.mock.calls[0];
    expect(patch.videoHistory).toEqual([previous, olderStill]);
  });
});

describe('GenerationService.generateVideo — замок и запись расхода (этап 47)', () => {
  it('занятый замок — 409 до скачивания фото и до Veo', async () => {
    // В-2.2 / В-3.1: тридцать одновременных запросов проходили и
    // проверку бюджета, и проверку «уже идёт», потому что обе читали
    // состояние, которое пишется после старта Veo. Замок занимается
    // одним условным UPDATE ДО любой сетевой работы.
    const { svc, sessions, blob, aiUsage } = build();
    sessions.claimWork.mockResolvedValue(false);

    await expect(svc.generateVideo('s1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'generate',
      expect.any(Number),
    );
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
    expect(generateVideos).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
    // Чужой замок не снимается: его снимет тот, кто занял.
    expect(sessions.releaseWork).not.toHaveBeenCalled();
  });

  it('замок снимается после успешного старта — повтор увидит generatedVideo', async () => {
    const { svc, sessions } = build();
    await svc.generateVideo('s1');
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'generate');
    // Порядок: захват → работа → освобождение.
    const claimOrder = sessions.claimWork.mock.invocationCallOrder[0];
    const releaseOrder = sessions.releaseWork.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(releaseOrder);
  });

  it('замок снимается и при провале старта — иначе повтор невозможен', async () => {
    const { svc, sessions } = build();
    generateVideos.mockRejectedValue(new Error('Veo недоступен'));
    await expect(svc.generateVideo('s1')).rejects.toThrow();
    expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'generate');
  });

  it('уже записанный идущий рендер возвращается без замка', async () => {
    // Быстрый путь Б-2.3 остаётся: если рендер записан, повтор получает
    // его же — и замок для этого не нужен.
    const { svc, sessions } = build({
      ...readySession(),
      generatedVideo: {
        status: GenerationStatus.PROCESSING,
        veoOperationName: 'operations/veo-0',
      },
    });
    const r = await svc.generateVideo('s1');
    expect(r.veoOperationName).toBe('operations/veo-0');
    expect(sessions.claimWork).not.toHaveBeenCalled();
  });

  it('строка расхода записана ДО того, как метод вернул ответ', async () => {
    // В-2.1: на Vercel функция не обязана дожить до конца промиса,
    // который отпустила без await. Расход — то, по чему считается
    // суточный потолок; не дождаться его — значит не иметь потолка.
    const { svc, aiUsage } = build();
    let recorded = false;
    aiUsage.record.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            recorded = true;
            resolve();
          }, 20),
        ),
    );
    await svc.generateVideo('s1');
    expect(recorded).toBe(true);
  });

  it('полная модель Veo закрыта для Lite, как и чужой формат кадра', async () => {
    // В-2.6: `quality` приходил телом запроса и не проверялся ничем —
    // 2,7× к цене рендера от кого угодно.
    const { svc, plans } = build();
    plans.accessOf.mockResolvedValue({
      plan: 'LITE',
      isBlocked: false,
      blockedReason: null,
    });
    await expect(svc.generateVideo('s1', 'standard')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(generateVideos).not.toHaveBeenCalled();
    // Lite-модель Lite-пакету доступна.
    await expect(
      svc.generateVideo('s1', 'fast', '9:16'),
    ).resolves.toBeDefined();
  });
});

describe('GenerationService.fetchReference — вторая линия защиты от SSRF (В-6.10)', () => {
  // Комментарий в коде называет проверку у самого `fetch` «единственной,
  // которую нельзя обойти, добавив новый маршрут записи» — и до этого
  // этапа её удаление не роняло ни одного теста.
  const ref = (over: Record<string, unknown>) => ({
    index: 1,
    kind: 'character',
    label: 'Аня',
    mimeType: 'image/png',
    pathname: null,
    url: null,
    ...over,
  });

  afterEach(() => jest.restoreAllMocks());

  it('свой путь читается из хранилища напрямую, без сети', async () => {
    const { svc, blob } = build();
    const bytes = await (svc as any).fetchReference(
      ref({ pathname: 'sessions/s1/characters/c1.png' }),
    );
    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'sessions/s1/characters/c1.png',
    );
    expect(Buffer.isBuffer(bytes)).toBe(true);
  });

  it('чужой URL отклоняется ДО обращения к сети', async () => {
    // Снимок манифеста мог быть записан до валидатора DTO или прийти
    // любым другим путём; скачивает картинку именно этот код.
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    const { svc } = build();
    await expect(
      (svc as any).fetchReference(
        ref({ url: 'https://evil.example/sessions/s1/c1.png' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      (svc as any).fetchReference(
        ref({
          url: 'http://x.public.blob.vercel-storage.com/sessions/s1/c1.png',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('свой URL скачивается; не-2xx — понятный отказ', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as never);
    const { svc } = build();
    const own = 'https://x.public.blob.vercel-storage.com/sessions/s1/c1.png';
    const bytes = await (svc as any).fetchReference(ref({ url: own }));
    expect(fetchSpy).toHaveBeenCalledWith(own);
    expect([...bytes]).toEqual([1, 2, 3]);

    fetchSpy.mockResolvedValue({ ok: false, status: 404 } as never);
    await expect(
      (svc as any).fetchReference(ref({ url: own })),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('ни пути, ни адреса — отказ, а не пустая картинка в Veo', async () => {
    const { svc } = build();
    await expect((svc as any).fetchReference(ref({}))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
