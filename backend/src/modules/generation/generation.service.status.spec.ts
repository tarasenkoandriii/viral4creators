/**
 * Переход PROCESSING → COMPLETE (Б-5.15).
 *
 * `getVideoStatus` — единственный путь, по которому оплаченный рендер
 * превращается в файл у пользователя: разбор ответа операции Veo, оба
 * `markFailed`, скачивание у Google и заливка в наш Blob, передача в
 * постобработку. До этого файла из всего перехода не исполнялась ни одна
 * строка — а именно на этом стыке жили две главные находки первого аудита.
 *
 * Опрос статуса и скачивание идут сырым REST (`fetch`), а не через
 * `@google/genai`: SDK-метод `operations.getVideosOperation()` рассчитан на
 * живой объект операции от предыдущего вызова SDK (несёт приватный метод
 * `_fromAPIResponse`), а сессия между запросами хранит только строку
 * `veoOperationName` — реконструированный из неё голый `{ name }` этого
 * метода не имеет, и SDK падает на КАЖДОМ опросе (`TypeError:
 * operation._fromAPIResponse is not a function`, см. прод-логи). Поэтому
 * здесь мокается `global.fetch`, а не `@google/genai`.
 *
 * Цена ошибки здесь несимметрична. Рендер уже оплачен: любая ветка,
 * которая по недоразумению помечает его FAILED (например, обычный сетевой
 * сбой при опросе), выбрасывает деньги; любая ветка, которая молча
 * возвращает PROCESSING на завершившейся операции, оставляет клиента в
 * вечном опросе. Поэтому проверки ниже держат ровно границу между «ещё
 * рендерится», «упало» и «готово».
 *
 * Соседний `generation.service.spec.ts` держит денежный шлюз ПЕРЕД Veo;
 * здесь — всё, что после.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateVideos: jest.fn() },
  })),
  VideoGenerationReferenceType: { ASSET: 'ASSET' },
}));

import { NotFoundException } from '@nestjs/common';
import {
  GenerationService,
  RENDER_DEADLINE_MS,
  renderExpired,
} from './generation.service';
import {
  GeneratedVideo,
  GenerationStatus,
} from '../../common/types/generation.types';
import { SessionStatus } from '../../common/types/session.types';

const keyBefore = process.env.GOOGLE_GEMINI_API_KEY;
beforeAll(() => {
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = keyBefore;
});

const fetchMock = jest.fn();
const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

/** Ролик, за который уже заплачено и который ещё рендерится. */
const inFlight = (over: Partial<GeneratedVideo> = {}): GeneratedVideo => ({
  generatedVideoId: 'v1',
  pathname: 'sessions/s1/generated.mp4',
  fileName: 'generated.mp4',
  mimeType: 'video/mp4',
  status: GenerationStatus.PROCESSING,
  // Свежий старт: дедлайн рендера (этап 52) считается от этой метки.
  initiatedAt: new Date(),
  veoOperationName: 'operations/veo-1',
  quality: 'fast',
  aspectRatio: '9:16',
  renderedAspectRatio: '9:16',
  reframePending: false,
  ...over,
});

function build(generatedVideo: GeneratedVideo | null = inFlight()) {
  let state: Record<string, unknown> | null = {
    sessionId: 's1',
    userId: 'u1',
    ...(generatedVideo ? { generatedVideo } : {}),
  };
  const sessions = {
    getSession: jest.fn(async () => (state ? { ...state } : null)),
    updateSession: jest.fn(async (_id: string, patch: object) => {
      state = { ...(state ?? {}), ...patch };
    }),
  };
  const blob = {
    downloadBuffer: jest.fn(),
    uploadBuffer: jest.fn().mockResolvedValue({
      url: 'https://blob.test/sessions/s1/generated.mp4',
    }),
  };
  const plans = {
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
    accessOf: jest.fn(),
  };
  const aiUsage = { record: jest.fn() };
  // Постобработка возвращает СВОЙ объект — так видно, что наружу уходит
  // именно её результат, а не наш «до».
  const postprod = {
    start: jest.fn(async (_id: string, video: GeneratedVideo) => ({
      ...video,
      postProduction: { status: 'pending' },
    })),
    poll: jest.fn(async (_id: string, video: GeneratedVideo) => ({
      ...video,
      postProduction: { status: 'polled' },
    })),
  };
  // ТЗ §28: провал рендера уходит тревогой в служебный канал.
  const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };
  // Этап 60: счётчик конверсии страницы шеринга — best-effort, мок молчит.
  const sharedVideos = {
    markConverted: jest.fn().mockResolvedValue(undefined),
  };
  // Этап 62: возврат кредита при провале рендера — best-effort, мок молчит.
  const creditLedger = {
    reserveForGeneration: jest.fn().mockResolvedValue(false),
    refundIfReserved: jest.fn().mockResolvedValue(undefined),
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
  );
  return {
    svc,
    sessions,
    blob,
    postprod,
    sharedVideos,
    creditLedger,
    read: () => state,
  };
}

/** Ответ REST `fetch` со статусом операции (`res.json()`), не сама операция. */
const jsonRes = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

/** Ответ REST `fetch` на скачивание видеофайла по `uri` (`res.arrayBuffer()`). */
const bufRes = (bytes: string, ok = true, status = 200) => ({
  ok,
  status,
  arrayBuffer: async () => new TextEncoder().encode(bytes).buffer,
});

/** Сырой конверт REST-ответа Veo о завершённой операции со ссылкой на файл. */
const doneWithUri = (uri = 'https://veo.googleapis/tmp/1') => ({
  done: true,
  response: {
    generateVideoResponse: {
      generatedSamples: [{ video: { uri } }],
    },
  },
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('getVideoStatus — рендер ещё идёт', () => {
  it('операция не завершена: состояние не меняется и ничего не заливается', async () => {
    // Опрос идёт раз в несколько секунд. Запись в сессию и лишний
    // uploadBuffer на каждом «ещё рендерится» — это трафик и мусор в
    // хранилище на ровном месте.
    const { svc, sessions, blob, postprod } = build();
    fetchMock.mockResolvedValueOnce(jsonRes({ done: false }));

    const result = await svc.getVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.PROCESSING);
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
    expect(postprod.start).not.toHaveBeenCalled();
  });

  it('сбой связи при опросе НЕ хоронит оплаченный рендер', async () => {
    // Самая дорогая ошибка в этом методе: пометить FAILED из-за сетевой
    // икоты — значит выбросить уже оплаченный ролик, который у Google
    // спокойно дорендерится. Возвращаем прежнее состояние и ждём
    // следующего опроса.
    const { svc, sessions } = build();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await svc.getVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.PROCESSING);
    expect(result.error).toBeUndefined();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('без имени операции опрашивать нечего — Veo не дёргается', async () => {
    const { svc } = build(inFlight({ veoOperationName: undefined }));
    const result = await svc.getVideoStatus('s1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe(GenerationStatus.PROCESSING);
  });

  it('операция адресуется по имени, сохранённому при запуске', async () => {
    // Имя — единственная ниточка к оплаченному рендеру: потеряв её,
    // забрать результат нельзя ничем.
    const { svc } = build();
    fetchMock.mockResolvedValueOnce(jsonRes({ done: false }));
    await svc.getVideoStatus('s1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/operations/veo-1',
      { headers: { 'x-goog-api-key': 'test-key' } },
    );
  });
});

describe('getVideoStatus — дедлайн рендера (этап 52, В-2.8)', () => {
  const stale = () =>
    inFlight({ initiatedAt: new Date(Date.now() - RENDER_DEADLINE_MS - 1000) });

  it('рендер старше дедлайна закрывается сбоем, Veo не опрашивается', async () => {
    // До этого любая ошибка опроса возвращала PROCESSING, и сессия висела в
    // GENERATING_VIDEO до самого TTL — «разрешение» выглядело как
    // исчезновение сессии под пользователем.
    const { svc, read } = build(stale());
    const result = await svc.getVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error?.code).toBe('VIDEO_GENERATION_TIMEOUT');
    // Повтор законен: разбор и промпт живы.
    expect(result.error?.retryable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const state = read() as { status: string };
    expect(state.status).toBe(SessionStatus.ERROR);
  });

  it('до дедлайна сетевая икота по-прежнему не хоронит рендер', async () => {
    const { svc } = build(
      inFlight({
        initiatedAt: new Date(Date.now() - RENDER_DEADLINE_MS + 60_000),
      }),
    );
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await svc.getVideoStatus('s1');
    expect(result.status).toBe(GenerationStatus.PROCESSING);
  });

  it('дата из JSON приходит строкой — дедлайн всё равно считается', () => {
    expect(
      renderExpired({
        initiatedAt: new Date(
          Date.now() - RENDER_DEADLINE_MS - 1,
        ).toISOString() as never,
      }),
    ).toBe(true);
    expect(renderExpired({ initiatedAt: new Date() })).toBe(false);
    // Мусор в поле — не повод хоронить рендер.
    expect(renderExpired({ initiatedAt: 'когда-то' as never })).toBe(false);
  });
});

describe('getVideoStatus — оба markFailed', () => {
  it('Veo сообщил об ошибке: ролик FAILED, сессия ERROR, причина сохранена', async () => {
    // Без этой ветки экран остаётся в «идёт рендер» навсегда, а причина
    // отказа (обычно — политика контента) не доходит до пользователя.
    const { svc, read, postprod, blob, creditLedger } = build();
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        done: true,
        error: { message: 'Prompt rejected by safety filters' },
      }),
    );

    const result = await svc.getVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error).toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      message: 'Prompt rejected by safety filters',
      retryable: true,
    });
    expect(read()).toMatchObject({ status: SessionStatus.ERROR });
    // Ни скачивания, ни постобработки: скачивать нечего.
    expect(blob.uploadBuffer).not.toHaveBeenCalled();
    expect(postprod.start).not.toHaveBeenCalled();
    // Этап 62: неудача рендера возвращает кредит, если он был потрачен
    // (сервис сам решает, был ли резерв — здесь мок best-effort).
    expect(creditLedger.refundIfReserved).toHaveBeenCalledWith('v1');
  });

  it('операция завершилась, но видео в ответе нет — тоже честный отказ', async () => {
    // Второй markFailed. Ветка выглядит невозможной, но именно она
    // отделяет «Veo сказал done и ничего не дал» от падения по
    // `undefined` где-нибудь в downloadVeoVideo.
    const { svc, read } = build();
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        done: true,
        response: { generateVideoResponse: { generatedSamples: [] } },
      }),
    );

    const result = await svc.getVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error?.code).toBe('VIDEO_GENERATION_NO_OUTPUT');
    expect(read()).toMatchObject({ status: SessionStatus.ERROR });
  });

  it('упавший рендер второй раз не опрашивается', async () => {
    const { svc } = build(inFlight({ status: GenerationStatus.FAILED }));
    const result = await svc.getVideoStatus('s1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe(GenerationStatus.FAILED);
  });
});

describe('getVideoStatus — забрать файл у Google и положить к себе', () => {
  it('операция готова: файл качается по ссылке (REST + ключ) и уходит в Blob по пути сессии', async () => {
    // Путь файла зафиксирован при запуске генерации; залив по другому
    // пути, мы бы получили ролик, которого не найдёт ни уборка сессий,
    // ни метла — то есть вечный мусор с чужой ссылкой в сессии.
    const { svc, blob, read } = build();
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(doneWithUri('https://veo.googleapis/tmp/1')),
      )
      .mockResolvedValueOnce(bufRes('содержимое ролика'));

    const result = await svc.getVideoStatus('s1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://veo.googleapis/tmp/1',
      { headers: { 'x-goog-api-key': 'test-key' } },
    );
    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      'sessions/s1/generated.mp4',
      Buffer.from('содержимое ролика'),
      'video/mp4',
    );
    expect(result.status).toBe(GenerationStatus.COMPLETE);
    expect(result.downloadUrl).toBe(
      'https://blob.test/sessions/s1/generated.mp4',
    );
    expect(result.fileSize).toBe(Buffer.from('содержимое ролика').length);
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(read()).toMatchObject({ status: SessionStatus.VIDEO_COMPLETE });
  });

  it('скачивание не удалось — ролик FAILED с кодом VIDEO_DOWNLOAD_FAILED', async () => {
    const { svc, read, postprod } = build();
    fetchMock
      .mockResolvedValueOnce(jsonRes(doneWithUri()))
      .mockRejectedValueOnce(new Error('403 от Google'));

    const result = await svc.getVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error).toMatchObject({
      code: 'VIDEO_DOWNLOAD_FAILED',
      message: '403 от Google',
      retryable: true,
    });
    expect(read()).toMatchObject({ status: SessionStatus.ERROR });
    expect(postprod.start).not.toHaveBeenCalled();
  });

  it('заливка в Blob не удалась — сессия не объявляется готовой', async () => {
    // Ролик, помеченный COMPLETE без файла в хранилище, — это ссылка в
    // никуда: пользователь видит «готово» и получает 404 при скачивании.
    const { svc, blob, read, postprod } = build();
    fetchMock
      .mockResolvedValueOnce(jsonRes(doneWithUri()))
      .mockResolvedValueOnce(bufRes('ролик'));
    blob.uploadBuffer.mockRejectedValue(new Error('blob: quota exceeded'));

    const result = await svc.getVideoStatus('s1');

    expect(result.status).toBe(GenerationStatus.FAILED);
    expect(result.error?.code).toBe('VIDEO_DOWNLOAD_FAILED');
    expect(read()).toMatchObject({ status: SessionStatus.ERROR });
    expect(postprod.start).not.toHaveBeenCalled();
  });
});

describe('getVideoStatus — передача в постобработку (§15.4/§16.1)', () => {
  it('готовый ролик уходит в postprod.start, и наружу идёт ЕЁ результат', async () => {
    // Постобработка (обрезка кадра, своя озвучка) навешивает на ответ
    // своё состояние. Вернув объект «до», мы бы отдали клиенту ролик без
    // признака идущей доводки — и он показал бы исходный кадр как
    // окончательный.
    const { svc, postprod } = build(
      inFlight({
        aspectRatio: '4:5',
        renderedAspectRatio: '9:16',
        reframePending: true,
      }),
    );
    fetchMock
      .mockResolvedValueOnce(jsonRes(doneWithUri()))
      .mockResolvedValueOnce(bufRes('ролик'));

    const result = await svc.getVideoStatus('s1');

    expect(postprod.start).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        status: GenerationStatus.COMPLETE,
        downloadUrl: 'https://blob.test/sessions/s1/generated.mp4',
        reframePending: true,
      }),
    );
    expect(
      (result as GeneratedVideo & { postProduction: { status: string } })
        .postProduction.status,
    ).toBe('pending');
  });

  it('сессия сохраняется ДО постобработки — её сбой не теряет готовый ролик', async () => {
    // Порядок здесь и есть смысл: ролик уже у пользователя, и запуск
    // доводки не может ничего сломать только потому, что COMPLETE уже
    // записан в сессию.
    const order: string[] = [];
    const { svc, sessions, postprod } = build();
    fetchMock
      .mockResolvedValueOnce(jsonRes(doneWithUri()))
      .mockResolvedValueOnce(bufRes('ролик'));
    const realUpdate = sessions.updateSession.getMockImplementation()!;
    sessions.updateSession.mockImplementation(async (id, patch) => {
      order.push('сессия');
      return realUpdate(id, patch);
    });
    postprod.start.mockImplementation(((_id: string, v: unknown) => {
      order.push('постобработка');
      return Promise.resolve(v);
    }) as never);

    await svc.getVideoStatus('s1');

    expect(order).toEqual(['сессия', 'постобработка']);
  });

  it('уже готовый ролик опрашивает постобработку, а не Veo', async () => {
    // Veo-операция живёт ограниченное время, и второй опрос уже
    // завершённой генерации — это лишний вызов к оплачиваемому API.
    const { svc, postprod } = build(
      inFlight({
        status: GenerationStatus.COMPLETE,
        downloadUrl: 'https://blob.test/sessions/s1/generated.mp4',
      }),
    );

    const result = await svc.getVideoStatus('s1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(postprod.poll).toHaveBeenCalledWith('s1', expect.any(Object));
    expect(
      (result as GeneratedVideo & { postProduction: { status: string } })
        .postProduction.status,
    ).toBe('polled');
  });
});

describe('getVideoStatus — чего нет, того нет', () => {
  it('нет сессии — 404, а не пустой ответ', async () => {
    const { svc, sessions } = build();
    sessions.getSession.mockResolvedValue(null);
    await expect(svc.getVideoStatus('s1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('генерация не запускалась — 404 вместо выдуманного статуса', async () => {
    const { svc } = build(null);
    await expect(svc.getVideoStatus('s1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
