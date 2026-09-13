/**
 * AnalysisService — транзитная копия референса и кеш библиотеки (Б-5.12).
 *
 * До этого файла в сервисе не исполнялась ни одна строка: 120 операторов
 * на нуле. Цена этого нуля видна из шапки самого сервиса: загруженный
 * файл — ВРЕМЕННАЯ копия, она уходит в Gemini и обязана быть удалена и у
 * нас (Vercel Blob), и у Google. Путей удаления три, и каждый из них
 * можно было убрать, не уронив ни одного из 755 тестов:
 *
 *  1. кеш библиотеки попал по хешу файла — блоб удаляется ДО applyCached;
 *  2. Gemini не принял файл — блоб удаляется в `catch` и ошибка летит выше;
 *  3. разбор состоялся (или упал) — `cleanup()` в `finally` удаляет и файл
 *     Gemini, и блоб.
 *
 * Утечка здесь не заметна ни пользователю, ни логу: ролики просто
 * копятся в хранилище и на стороне Google, а найти их потом нечем —
 * сессия к тому времени истекла. Ровно поэтому проверки ниже написаны
 * «на удаление», а не «на успех разбора».
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent },
  })),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { GEMINI_MODEL } from '../../common/gemini-model';
import {
  AnalysisStatus,
  VideoAnalysis,
} from '../../common/types/analysis.types';
import { SessionStatus } from '../../common/types/session.types';
import { VideoSourceType } from '../../common/types/video.types';

// Сервис отказывается собираться без ключа, а тесты здесь про удаление
// файлов, а не про ключ. Ставим и убираем за собой: process.env общий на
// весь воркер jest.
const keyBefore = process.env.GOOGLE_GEMINI_API_KEY;
beforeAll(() => {
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = keyBefore;
});

const BLOB_PATH = 'sessions/s1/original.mp4';

/** Референс-загрузка: транзитная копия лежит в нашем хранилище. */
const uploaded = () => ({
  sourceType: VideoSourceType.UPLOAD as const,
  blobPathname: BLOB_PATH,
  fileName: 'ref.mp4',
  fileSize: 1024,
  mimeType: 'video/mp4',
  uploadedAt: new Date(),
});

/** Референс-ссылка: у нас не лежит ничего, удалять нечего. */
const youtube = () => ({
  sourceType: VideoSourceType.YOUTUBE as const,
  youtubeUrl: 'https://youtu.be/abcdefghijk',
  registeredAt: new Date(),
});

/** Ответ Gemini в том виде, в каком его ждёт parseAnalysisResponse. */
const geminiText = (frame?: string) =>
  JSON.stringify({
    sceneBreakdown: 'Хук, проблема, решение',
    ...(frame
      ? { frame: { orientation: 'vertical', aspectRatio: frame } }
      : {}),
    characters: [],
    scenes: [],
    extras: [],
  });

const storedAnalysis = (): VideoAnalysis =>
  ({
    analysisId: 'из-библиотеки',
    analyzedAt: new Date('2026-01-01T00:00:00Z'),
    status: AnalysisStatus.COMPLETE,
    sceneBreakdown: 'разбор из библиотеки',
    frame: { aspectRatio: '9:16', source: 'gemini' },
  }) as unknown as VideoAnalysis;

function build(
  over: {
    originalVideo?: unknown;
    userId?: string | null;
    cached?: VideoAnalysis | null;
  } = {},
) {
  // Сессия живая: performAnalysis перечитывает её после каждой записи,
  // и подменять getSession одним значением нельзя — тест разошёлся бы с
  // реальным поведением.
  let state: Record<string, unknown> | null = {
    sessionId: 's1',
    userId: 'userId' in over ? over.userId : 'u1',
    originalVideo: 'originalVideo' in over ? over.originalVideo : uploaded(),
  };
  const sessionService = {
    getSession: jest.fn(async () => (state ? { ...state } : null)),
    updateSession: jest.fn(async (_id: string, patch: object) => {
      state = { ...(state ?? {}), ...patch };
    }),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const blobService = {
    downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('байты ролика')),
    deleteBlob: jest.fn().mockResolvedValue(undefined),
  };
  const geminiFilesService = {
    uploadAndWaitActive: jest.fn().mockResolvedValue({
      name: 'files/veo-ref-1',
      uri: 'https://generativelanguage.googleapis.com/files/veo-ref-1',
      mimeType: 'video/mp4',
    }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const library = {
    findAnalysis: jest.fn().mockResolvedValue(over.cached ?? null),
    markUsed: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const aiUsage = { recordGemini: jest.fn().mockResolvedValue(undefined) };
  const plans = { assertCanSpendUser: jest.fn().mockResolvedValue(undefined) };
  const legal = { assertAccepted: jest.fn().mockResolvedValue(undefined) };
  const svc = new AnalysisService(
    blobService as never,
    geminiFilesService as never,
    library as never,
    sessionService as never,
    aiUsage as never,
    plans as never,
    legal as never,
  );
  return {
    svc,
    sessionService,
    blobService,
    geminiFilesService,
    library,
    aiUsage,
    plans,
    legal,
    read: () => state,
  };
}

beforeEach(() => {
  generateContent.mockReset();
  generateContent.mockResolvedValue({
    text: geminiText(),
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  });
});

describe('AnalysisService — транзитная копия удаляется на всех трёх путях', () => {
  it('успешный разбор: удаляются И блоб, И файл на стороне Gemini', async () => {
    // Забыть любой из двух — утечка, которую никто не заметит: у нас
    // растёт счёт за хранилище, у Google файл живёт 48 часов сам по себе,
    // а путь к нему после истечения сессии взять уже неоткуда.
    const { svc, blobService, geminiFilesService } = build();

    await svc.analyzeVideo('s1');

    expect(blobService.deleteBlob).toHaveBeenCalledWith(BLOB_PATH);
    expect(geminiFilesService.deleteFile).toHaveBeenCalledWith(
      'files/veo-ref-1',
    );
  });

  it('удаление идёт ПОСЛЕ generateContent, а не до него', async () => {
    // Порядок — не косметика: удалив файл раньше, мы выдернули бы
    // ссылку из-под уже отправленного запроса, и Gemini вернул бы отказ
    // на каждом разборе загруженного файла.
    const order: string[] = [];
    const { svc, blobService, geminiFilesService } = build();
    generateContent.mockImplementation(async () => {
      order.push('gemini');
      return { text: geminiText() };
    });
    blobService.deleteBlob.mockImplementation(async () => {
      order.push('удалён блоб');
    });
    geminiFilesService.deleteFile.mockImplementation(async () => {
      order.push('удалён файл gemini');
    });

    await svc.analyzeVideo('s1');

    expect(order[0]).toBe('gemini');
    expect(order).toContain('удалён блоб');
    expect(order).toContain('удалён файл gemini');
  });

  it('Gemini не принял файл — блоб всё равно удаляется, а ошибка летит выше', async () => {
    // Второй путь удаления (`catch` вокруг загрузки). Без него мёртвая
    // загрузка остаётся в хранилище навсегда только потому, что Gemini
    // отказался её обрабатывать.
    const { svc, blobService, geminiFilesService } = build();
    geminiFilesService.uploadAndWaitActive.mockRejectedValue(
      new Error('Timed out waiting for Gemini to process the video'),
    );

    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(blobService.deleteBlob).toHaveBeenCalledWith(BLOB_PATH);
    // Файла у Gemini не появилось — удалять нечего, и звать удаление с
    // undefined было бы ошибкой.
    expect(geminiFilesService.deleteFile).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('скачивание транзитной копии не удалось — блоб тоже удаляется', async () => {
    // Тот же `catch`, но раньше: битую копию, которую мы не смогли даже
    // прочитать, держать в хранилище незачем.
    const { svc, blobService } = build();
    blobService.downloadBuffer.mockRejectedValue(new Error('blob 404'));

    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(blobService.deleteBlob).toHaveBeenCalledWith(BLOB_PATH);
  });

  it('разбор упал у Gemini — `finally` всё равно убирает оба файла', async () => {
    // Третий путь. Именно он самый ценный: ошибка разбора — обычное
    // дело, и если убирать только на успешной ветке, хранилище копит
    // мусор ровно от неудачных попыток.
    const { svc, blobService, geminiFilesService } = build();
    generateContent.mockRejectedValue(new Error('500 from Gemini'));

    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(blobService.deleteBlob).toHaveBeenCalledWith(BLOB_PATH);
    expect(geminiFilesService.deleteFile).toHaveBeenCalledWith(
      'files/veo-ref-1',
    );
  });

  it('ссылка на YouTube: удалять нечего — ни блоба, ни файла Gemini', async () => {
    // У ссылки нет `blobPathname`; вызов deleteBlob здесь означал бы
    // удаление по undefined — в лучшем случае ошибка, в худшем чужой файл.
    const { svc, blobService, geminiFilesService } = build({
      originalVideo: youtube(),
    });

    await svc.analyzeVideo('s1');

    expect(blobService.deleteBlob).not.toHaveBeenCalled();
    expect(blobService.downloadBuffer).not.toHaveBeenCalled();
    expect(geminiFilesService.uploadAndWaitActive).not.toHaveBeenCalled();
    expect(geminiFilesService.deleteFile).not.toHaveBeenCalled();
    // Gemini скачивает ролик сам — ссылка уходит как есть.
    expect(generateContent.mock.calls[0][0].contents[0]).toEqual({
      fileData: { fileUri: 'https://youtu.be/abcdefghijk' },
    });
  });
});

describe('AnalysisService — кеш библиотеки экономит самый дорогой вызов (§21)', () => {
  it('ссылка уже разобрана: Gemini не вызывается вовсе', async () => {
    // Ключ ссылки известен до всякой работы, поэтому попадание в кеш
    // обязано остановить поток ДО загрузки файлов и до платного вызова.
    const { svc, library, geminiFilesService } = build({
      originalVideo: youtube(),
      cached: storedAnalysis(),
    });

    const result = await svc.analyzeVideo('s1');

    expect(generateContent).not.toHaveBeenCalled();
    expect(geminiFilesService.uploadAndWaitActive).not.toHaveBeenCalled();
    expect(library.findAnalysis).toHaveBeenCalledWith('yt:abcdefghijk');
    expect(result.status).toBe(AnalysisStatus.COMPLETE);
  });

  it('взятый из библиотеки разбор помечен fromLibrary и получает СВОЙ analysisId', async () => {
    // `fromLibrary` — то, по чему интерфейс отличает «посчитано для вас»
    // от «взято готовое»; чужой analysisId в сессии сломал бы опрос
    // статуса, который ведётся по идентификатору этой сессии.
    const { svc, sessionService, library, read } = build({
      originalVideo: youtube(),
      cached: storedAnalysis(),
    });

    const result = await svc.analyzeVideo('s1');

    const stored = (read() as { videoAnalysis: VideoAnalysis }).videoAnalysis;
    expect(stored.fromLibrary).toBe(true);
    expect(stored.sceneBreakdown).toBe('разбор из библиотеки');
    expect(stored.analysisId).not.toBe('из-библиотеки');
    expect(result.analysisId).toBe(stored.analysisId);
    // Счётчик использований — то, на чём стоят рекомендации (§21).
    expect(library.markUsed).toHaveBeenCalledWith('yt:abcdefghijk');
    expect(sessionService.updateSession).toHaveBeenCalledWith('s1', {
      librarySourceKey: 'yt:abcdefghijk',
    });
    expect(read()).toMatchObject({
      status: SessionStatus.ANALYSIS_COMPLETE,
    });
  });

  it('загрузка совпала по хешу: блоб удаляется, а Gemini не платится', async () => {
    // Первый из трёх путей удаления. У загрузки ключ — sha256 самих
    // байтов, поэтому кеш проверяется уже после скачивания, но всё ещё
    // ДО загрузки файла в Gemini и до платного вызова.
    const { svc, blobService, geminiFilesService, library } = build({
      cached: storedAnalysis(),
    });

    await svc.analyzeVideo('s1');

    expect(blobService.deleteBlob).toHaveBeenCalledWith(BLOB_PATH);
    expect(geminiFilesService.uploadAndWaitActive).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    // Ключ считается от содержимого, а не от имени файла: два одинаковых
    // ролика с разными именами обязаны попасть в одну запись.
    const key = library.findAnalysis.mock.calls[0][0] as string;
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('промах кеша ведёт к настоящему разбору и запись уходит в библиотеку', async () => {
    // Обратная половина: без неё «кеш всегда пуст» тоже прошло бы тесты
    // выше, а библиотека перестала бы наполняться — и каждый следующий
    // пользователь того же ролика платил бы заново.
    const { svc, library } = build({ originalVideo: youtube() });

    await svc.analyzeVideo('s1');

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(library.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'yt:abcdefghijk',
        sourceType: 'youtube',
        sourceUrl: 'https://youtu.be/abcdefghijk',
        sessionId: 's1',
        userId: 'u1',
      }),
    );
  });

  it('нераспознанная ссылка не кладётся в библиотеку под пустым ключом', async () => {
    // sourceKeyOf вернёт null — запись под null затёрла бы чужую строку
    // или упала бы на уникальном индексе.
    const { svc, library } = build({
      originalVideo: {
        sourceType: VideoSourceType.YOUTUBE as const,
        youtubeUrl: 'https://example.com/не-youtube',
        registeredAt: new Date(),
      },
    });

    await svc.analyzeVideo('s1');

    expect(library.findAnalysis).not.toHaveBeenCalled();
    expect(library.save).not.toHaveBeenCalled();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('AnalysisService — деньги и согласие проверяются до Gemini', () => {
  it('блокировка или исчерпанный лимит останавливают разбор до любой работы', async () => {
    // Разбор — самый дорогой из текстовых вызовов: в него уходит всё
    // видео целиком (§26). Проверка после старта уже ничего не спасает.
    const { svc, plans, sessionService, blobService } = build();
    plans.assertCanSpendUser.mockRejectedValue(
      new ForbiddenException('Платные операции приостановлены'),
    );

    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(generateContent).not.toHaveBeenCalled();
    expect(blobService.downloadBuffer).not.toHaveBeenCalled();
    // Сессия не помечена ANALYZING: статус без идущего разбора — тупик,
    // из которого интерфейсом не выйти.
    expect(sessionService.updateSession).not.toHaveBeenCalled();
  });

  it('без принятого соглашения разбор не начинается (§20)', async () => {
    // На согласии стоят права сервиса на разбор и легитимность общей
    // Библиотеки — проверка не может жить только в интерфейсе.
    const { svc, legal, blobService } = build();
    legal.assertAccepted.mockRejectedValue(
      new ForbiddenException('Требуется согласие'),
    );

    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(generateContent).not.toHaveBeenCalled();
    expect(blobService.downloadBuffer).not.toHaveBeenCalled();
  });

  it('права спрашиваются у ВЛАДЕЛЬЦА сессии, а не у предъявителя', async () => {
    // Маршрут открыт и предъявителем считает UUID сессии (§7.8).
    const { svc, plans, legal } = build({ userId: 'владелец' });
    await svc.analyzeVideo('s1');
    expect(plans.assertCanSpendUser).toHaveBeenCalledWith('владелец');
    expect(legal.assertAccepted).toHaveBeenCalledWith('владелец');
  });

  it('расход пишется сразу после ответа Gemini, до разбора текста', async () => {
    // §26: деньги уже потрачены, даже если парсер ниже споткнётся —
    // невидимый расход превращает бюджетный отчёт в фантазию.
    const order: string[] = [];
    const { svc, aiUsage, sessionService } = build({
      originalVideo: youtube(),
    });
    aiUsage.recordGemini.mockImplementation(async () => {
      order.push('расход');
    });
    const realUpdate = sessionService.updateSession.getMockImplementation()!;
    sessionService.updateSession.mockImplementation(async (id, patch) => {
      order.push('запись сессии');
      return realUpdate(id, patch);
    });

    await svc.analyzeVideo('s1');

    expect(aiUsage.recordGemini).toHaveBeenCalledWith(expect.anything(), {
      operation: 'analysis',
      // По имени константы, не жёсткой строкой — тест не должен ломаться
      // каждый раз, когда Google меняет доступность модели по умолчанию
      // (найдено по реальной ошибке 404 в проде, 2026-09-13).
      model: GEMINI_MODEL,
      sessionId: 's1',
    });
    // Первая запись сессии — статус ANALYZING, дальше расход, и только
    // потом запись результата.
    expect(order).toEqual([
      'запись сессии',
      'расход',
      'запись сессии',
      'запись сессии',
    ]);
  });
});

describe('AnalysisService — провал разбора виден пользователю', () => {
  it('сессия помечается FAILED/ERROR с текстом причины, а не молча зависает', async () => {
    // Без этой ветки экран остаётся в PROCESSING навсегда: клиент
    // опрашивает статус, который уже никогда не изменится.
    const { svc, read } = build({ originalVideo: youtube() });
    generateContent.mockRejectedValue(new Error('quota exceeded'));

    await expect(svc.analyzeVideo('s1')).rejects.toThrow(/quota exceeded/);

    const state = read() as {
      videoAnalysis: VideoAnalysis;
      status: SessionStatus;
    };
    expect(state.videoAnalysis.status).toBe(AnalysisStatus.FAILED);
    expect(state.videoAnalysis.error?.code).toBe('ANALYSIS_FAILED');
    expect(state.videoAnalysis.error?.message).toContain('quota exceeded');
    expect(state.status).toBe(SessionStatus.ERROR);
  });

  it('нет сессии или нет референса — отказ до любых денег', async () => {
    const missing = build({ originalVideo: undefined });
    await expect(missing.svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(missing.plans.assertCanSpendUser).not.toHaveBeenCalled();
  });
});

describe('AnalysisService — формат кадра (§16)', () => {
  it('точный размер, снятый из файла, не затирается оценкой модели', async () => {
    // Браузер читает ширину и высоту у самого файла; Gemini лишь
    // угадывает по картинке. Перезапись «file» на «gemini» испортила бы
    // формат готового ролика — и это видно только на выходе Veo.
    const { svc, read } = build({
      originalVideo: {
        ...uploaded(),
        frame: {
          width: 1080,
          height: 1920,
          aspectRatio: '9:16',
          source: 'file' as const,
        },
      },
    });
    generateContent.mockResolvedValue({ text: geminiText('16:9') });

    await svc.analyzeVideo('s1');

    const state = read() as { originalVideo: { frame: { source: string } } };
    expect(state.originalVideo.frame).toEqual({
      width: 1080,
      height: 1920,
      aspectRatio: '9:16',
      source: 'file',
    });
  });

  it('у ссылки формата взять неоткуда — его сообщает Gemini', async () => {
    const { svc, read } = build({ originalVideo: youtube() });
    generateContent.mockResolvedValue({ text: geminiText('16:9') });

    await svc.analyzeVideo('s1');

    const state = read() as { originalVideo: { frame: unknown } };
    expect(state.originalVideo.frame).toEqual({
      width: null,
      height: null,
      aspectRatio: '16:9',
      source: 'gemini',
    });
  });
});

describe('AnalysisService — чтение и правка результата', () => {
  it('статус до старта разбора — честная ошибка, а не пустой объект', async () => {
    const { svc } = build();
    await expect(svc.getAnalysisStatus('s1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('правка пользователя ложится рядом с разбором, не вместо него', async () => {
    // `userEdits` — отдельное поле: затерев им sceneBreakdown, мы бы
    // потеряли исходный разбор, на который опирается генерация промпта.
    const { svc, read } = build({ originalVideo: youtube() });
    await svc.analyzeVideo('s1');

    const updated = await svc.updateAnalysis('s1', 'мой вариант');

    expect(updated.userEdits).toBe('мой вариант');
    expect(updated.sceneBreakdown).toBe('Хук, проблема, решение');
    expect(
      (read() as { videoAnalysis: VideoAnalysis }).videoAnalysis.userEdits,
    ).toBe('мой вариант');
  });
});

describe('AnalysisService — замок разбора (этап 47, В-2.3)', () => {
  it('занятый замок — 409 до скачивания и до Gemini', async () => {
    const { svc, sessionService, blobService, aiUsage } = build();
    sessionService.claimWork.mockResolvedValue(false);

    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sessionService.claimWork).toHaveBeenCalledWith(
      's1',
      'analyze',
      expect.any(Number),
    );
    expect(blobService.downloadBuffer).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
    // Не свой замок — не снимаем.
    expect(sessionService.releaseWork).not.toHaveBeenCalled();
    // И PROCESSING поверх чужого разбора не пишется.
    expect(sessionService.updateSession).not.toHaveBeenCalled();
  });

  it('замок занимается ПОСЛЕ проверок денег и согласия, снимается всегда', async () => {
    // Порядок важен: отказ по лимиту не должен оставлять замок, который
    // потом три минуты мешает законному запуску.
    const { svc, sessionService, plans } = build();
    plans.assertCanSpendUser.mockRejectedValue(new ForbiddenException('нет'));
    await expect(svc.analyzeVideo('s1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sessionService.claimWork).not.toHaveBeenCalled();

    const ok = build();
    await ok.svc.analyzeVideo('s1');
    expect(ok.sessionService.releaseWork).toHaveBeenCalledWith('s1', 'analyze');

    const bad = build({ originalVideo: youtube() });
    generateContent.mockRejectedValue(new Error('quota exceeded'));
    await expect(bad.svc.analyzeVideo('s1')).rejects.toThrow();
    expect(bad.sessionService.releaseWork).toHaveBeenCalledWith(
      's1',
      'analyze',
    );
  });

  it('провал не затирает чужой готовый разбор', async () => {
    // Сценарий из аудита: пока этот разбор шёл, сессию успел получить
    // другой результат (например, из библиотеки). Писать поверх него
    // FAILED — значит сказать заплатившему «не удалось».
    const { svc, sessionService, read } = build({ originalVideo: youtube() });
    generateContent.mockImplementation(async () => {
      // Кто-то записал готовый разбор, пока мы ждали модель.
      await sessionService.updateSession('s1', {
        videoAnalysis: {
          analysisId: 'чужой-готовый',
          status: AnalysisStatus.COMPLETE,
          sceneBreakdown: 'готово',
        },
        status: SessionStatus.ANALYSIS_COMPLETE,
      });
      throw new Error('quota exceeded');
    });

    await expect(svc.analyzeVideo('s1')).rejects.toThrow(/quota exceeded/);

    const state = read() as { videoAnalysis: VideoAnalysis; status: string };
    expect(state.videoAnalysis.analysisId).toBe('чужой-готовый');
    expect(state.videoAnalysis.status).toBe(AnalysisStatus.COMPLETE);
    expect(state.status).toBe(SessionStatus.ANALYSIS_COMPLETE);
  });

  it('расход записан до того, как метод вернул ответ (В-2.1)', async () => {
    const { svc, aiUsage } = build({ originalVideo: youtube() });
    let recorded = false;
    aiUsage.recordGemini.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            recorded = true;
            resolve();
          }, 20),
        ),
    );
    await svc.analyzeVideo('s1');
    expect(recorded).toBe(true);
  });
});
