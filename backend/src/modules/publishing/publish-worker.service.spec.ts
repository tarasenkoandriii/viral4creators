import { PublishWorkerService } from './publish-worker.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const configState = { cronBatch: 3, maxAttempts: 5 };
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ publishing: configState }),
}));

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req1',
    channelId: 'ch1',
    title: 'Товар',
    description: 'Описание',
    tags: ['tag1'],
    privacy: 'PRIVATE',
    videoUrl: 'https://blob.test/publications/req1/video.mp4',
    externalId: null,
    externalUrl: null,
    uploadJobId: null,
    attempts: 0,
    status: 'APPROVED',
    ...overrides,
  };
}

function setup(
  opts: {
    rows?: unknown[];
    claimCount?: number;
    /** Права подключённого канала (этап 137). */
    channelScopes?: string[];
    /** Сколько дорожек субтитров уже ушло за сутки (аудит субтитров). */
    captionsToday?: number;
  } = {},
) {
  const prisma = {
    publicationRequest: {
      findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      // Claim (Г-2.11) — по умолчанию всегда успешно захвачена, тест
      // гонки переопределяет через claimCount.
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      update: jest.fn().mockResolvedValue(undefined),
      // Счётчик суточного потолка субтитров (аудит субтитров этапа 137).
      count: jest.fn().mockResolvedValue(opts.captionsToday ?? 0),
    },
  };
  const channels = {
    ensureFreshToken: jest.fn().mockResolvedValue({
      accessToken: 'at-1',
      // Права канала (этап 137): по умолчанию расширенного согласия
      // НЕТ — как у всех каналов, подключённых до него.
      channel: { platform: 'YOUTUBE', scopes: opts.channelScopes ?? [] },
    }),
  };
  const youtube = {
    openSession: jest
      .fn()
      .mockResolvedValue('https://upload.example/session-1'),
    checkStatus: jest.fn(),
    uploadBytes: jest.fn().mockResolvedValue({
      externalId: 'yt-1',
      externalUrl: 'https://youtu.be/yt-1',
    }),
  };
  const tiktok = {
    init: jest.fn().mockResolvedValue({
      publishId: 'pub-1',
      uploadUrl: 'https://upload.example/tt-1',
    }),
    uploadBytes: jest.fn().mockResolvedValue(undefined),
    pollStatus: jest.fn(),
  };
  const translations = {
    translate: jest.fn().mockResolvedValue({}),
  };
  const captions = {
    insert: jest.fn().mockResolvedValue({ captionId: 'cap-1' }),
  };
  const service = new PublishWorkerService(
    prisma as never,
    channels as never,
    youtube as never,
    tiktok as never,
    translations as never,
    captions as never,
  );
  return { service, prisma, channels, youtube, tiktok, translations, captions };
}

describe('PublishWorkerService', () => {
  describe('runBatch — выборка', () => {
    it('пустая очередь — processed: 0 без обращений к каналам', async () => {
      const { service, channels } = setup({ rows: [] });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 0,
        published: 0,
        failed: 0,
        stillPending: 0,
      });
      expect(channels.ensureFreshToken).not.toHaveBeenCalled();
    });

    it('берёт не больше cronBatch заявок за прогон', async () => {
      const { service, prisma } = setup({ rows: [row()] });
      await service.runBatch();
      expect(prisma.publicationRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: configState.cronBatch }),
      );
    });
  });

  describe('YouTube', () => {
    it('успех: открывает сессию, грузит байты, помечает PUBLISHED', async () => {
      const { service, prisma, youtube } = setup({ rows: [row()] });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 1,
        published: 1,
        failed: 0,
        stillPending: 0,
      });
      expect(youtube.openSession).toHaveBeenCalledTimes(1);
      expect(youtube.checkStatus).not.toHaveBeenCalled(); // uploadJobId ещё нет
      expect(youtube.uploadBytes).toHaveBeenCalledWith(
        'https://upload.example/session-1',
        row().videoUrl,
        'at-1',
        0,
      );
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: { uploadJobId: 'https://upload.example/session-1' },
      });
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: {
          status: 'PUBLISHED',
          externalId: 'yt-1',
          externalUrl: 'https://youtu.be/yt-1',
          publishedAt: expect.any(Date),
          publishError: null,
          lockedUntil: null,
        },
      });
    });

    it('идемпотентность: externalId уже есть — не грузит повторно, просто фиксирует PUBLISHED', async () => {
      const { service, youtube } = setup({
        rows: [
          row({ externalId: 'yt-old', externalUrl: 'https://youtu.be/yt-old' }),
        ],
      });
      const result = await service.runBatch();
      expect(result.published).toBe(1);
      expect(youtube.openSession).not.toHaveBeenCalled();
      expect(youtube.uploadBytes).not.toHaveBeenCalled();
    });

    it('обрыв сети на PUT — ошибка попадает в backoff, попытка растёт', async () => {
      const { service, prisma, youtube } = setup({ rows: [row()] });
      youtube.uploadBytes.mockRejectedValueOnce(new Error('network drop'));
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 1,
        published: 0,
        failed: 1,
        stillPending: 0,
      });
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: {
          attempts: 1,
          publishError: 'network drop',
          status: 'APPROVED',
          nextAttemptAt: expect.any(Date),
          lockedUntil: null,
        },
      });
    });

    it('исчерпаны попытки — переводит в FAILED без nextAttemptAt', async () => {
      const { service, prisma, youtube } = setup({
        rows: [row({ attempts: configState.maxAttempts - 1 })],
      });
      youtube.openSession.mockRejectedValueOnce(new Error('quota exceeded'));
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: {
          attempts: configState.maxAttempts,
          publishError: 'quota exceeded',
          status: 'FAILED',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      });
    });
  });

  describe('YouTube — возобновление сессии вместо повторной заливки (Г-2.11)', () => {
    it('сохранённая сессия уже завершена — не грузит повторно, сразу PUBLISHED', async () => {
      const { service, prisma, youtube } = setup({
        rows: [row({ uploadJobId: 'https://upload.example/session-1' })],
      });
      youtube.checkStatus.mockResolvedValueOnce({
        done: true,
        externalId: 'yt-1',
        bytesUploaded: 0,
      });
      const result = await service.runBatch();
      expect(result.published).toBe(1);
      expect(youtube.openSession).not.toHaveBeenCalled();
      expect(youtube.uploadBytes).not.toHaveBeenCalled();
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: {
          status: 'PUBLISHED',
          externalId: 'yt-1',
          externalUrl: 'https://youtu.be/yt-1',
          publishedAt: expect.any(Date),
          publishError: null,
          lockedUntil: null,
        },
      });
    });

    it('сохранённая сессия принята частично — продолжает с сообщённого offset, новую сессию не открывает', async () => {
      const { service, youtube } = setup({
        rows: [row({ uploadJobId: 'https://upload.example/session-1' })],
      });
      youtube.checkStatus.mockResolvedValueOnce({
        done: false,
        bytesUploaded: 12345,
      });
      const result = await service.runBatch();
      expect(result.published).toBe(1);
      expect(youtube.openSession).not.toHaveBeenCalled();
      expect(youtube.uploadBytes).toHaveBeenCalledWith(
        'https://upload.example/session-1',
        row().videoUrl,
        'at-1',
        12345,
      );
    });

    it('сохранённая сессия просрочена (checkStatus кидает) — открывает новую с нуля', async () => {
      const { service, youtube } = setup({
        rows: [row({ uploadJobId: 'https://upload.example/session-stale' })],
      });
      youtube.checkStatus.mockRejectedValueOnce(
        Object.assign(new Error('session gone'), { status: 404 }),
      );
      const result = await service.runBatch();
      expect(result.published).toBe(1);
      expect(youtube.openSession).toHaveBeenCalledTimes(1);
      expect(youtube.uploadBytes).toHaveBeenCalledWith(
        'https://upload.example/session-1',
        row().videoUrl,
        'at-1',
        0,
      );
    });
  });

  describe('claim перед обработкой (Г-2.11)', () => {
    it('строка уже захвачена другим (перекрывающимся) тиком — пропускается без обращения к площадке', async () => {
      const { service, prisma, channels } = setup({
        rows: [row()],
        claimCount: 0,
      });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 1,
        published: 0,
        failed: 0,
        stillPending: 1,
      });
      expect(channels.ensureFreshToken).not.toHaveBeenCalled();
      expect(prisma.publicationRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'req1',
            status: 'APPROVED',
          }),
          data: { lockedUntil: expect.any(Date) },
        }),
      );
    });
  });

  describe('TikTok', () => {
    it('первый тик: init + uploadBytes, сохраняет publishId, ещё не PUBLISHED', async () => {
      const { service, prisma, tiktok, channels } = setup({
        rows: [row({ channelId: 'ch2' })],
      });
      channels.ensureFreshToken.mockResolvedValueOnce({
        accessToken: 'at-2',
        channel: { platform: 'TIKTOK' },
      });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 1,
        published: 0,
        failed: 0,
        stillPending: 1,
      });
      expect(tiktok.init).toHaveBeenCalledTimes(1);
      expect(tiktok.uploadBytes).toHaveBeenCalledWith(
        'https://upload.example/tt-1',
        row().videoUrl,
      );
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: { uploadJobId: 'pub-1' },
      });
      // Г-2.11: строка остаётся APPROVED (готовность на следующих тиках)
      // — лок снимается сразу, а не держится все 15 минут.
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: { lockedUntil: null },
      });
    });

    it('publish_id уже сохранён — не зовёт init повторно, только poll', async () => {
      const { service, tiktok, channels } = setup({
        rows: [row({ channelId: 'ch2', uploadJobId: 'pub-1' })],
      });
      channels.ensureFreshToken.mockResolvedValueOnce({
        accessToken: 'at-2',
        channel: { platform: 'TIKTOK' },
      });
      tiktok.pollStatus.mockResolvedValueOnce({
        status: 'processing',
        externalId: null,
        error: null,
      });
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 1,
        published: 0,
        failed: 0,
        stillPending: 1,
      });
      expect(tiktok.init).not.toHaveBeenCalled();
      expect(tiktok.pollStatus).toHaveBeenCalledWith('pub-1', 'at-2');
    });

    it('poll вернул published — фиксирует PUBLISHED без публичной ссылки', async () => {
      const { service, prisma, tiktok, channels } = setup({
        rows: [row({ channelId: 'ch2', uploadJobId: 'pub-1' })],
      });
      channels.ensureFreshToken.mockResolvedValueOnce({
        accessToken: 'at-2',
        channel: { platform: 'TIKTOK' },
      });
      tiktok.pollStatus.mockResolvedValueOnce({
        status: 'published',
        externalId: 'tt-real-id',
        error: null,
      });
      const result = await service.runBatch();
      expect(result.published).toBe(1);
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith({
        where: { id: 'req1' },
        data: {
          status: 'PUBLISHED',
          externalId: 'tt-real-id',
          externalUrl: null,
          publishedAt: expect.any(Date),
          publishError: null,
          lockedUntil: null,
        },
      });
    });

    it('poll вернул failed — уходит в backoff с текстом ошибки от TikTok', async () => {
      const { service, prisma, tiktok, channels } = setup({
        rows: [row({ channelId: 'ch2', uploadJobId: 'pub-1' })],
      });
      channels.ensureFreshToken.mockResolvedValueOnce({
        accessToken: 'at-2',
        channel: { platform: 'TIKTOK' },
      });
      tiktok.pollStatus.mockResolvedValueOnce({
        status: 'failed',
        externalId: null,
        error: 'video_too_short',
      });
      const result = await service.runBatch();
      expect(result.failed).toBe(1);
      expect(prisma.publicationRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ publishError: 'video_too_short' }),
        }),
      );
    });
  });

  describe('изоляция ошибок между заявками', () => {
    it('одна упавшая заявка не мешает следующей в том же тике', async () => {
      const { service, youtube } = setup({
        rows: [row({ id: 'a' }), row({ id: 'b' })],
      });
      youtube.openSession.mockRejectedValueOnce(new Error('boom on a'));
      const result = await service.runBatch();
      expect(result).toEqual({
        processed: 2,
        published: 1,
        failed: 1,
        stillPending: 0,
      });
    });
  });
});

/**
 * Локализации при загрузке (этап 137).
 *
 * Уезжают тем же запросом, что и `snippet`, — значит собираются ровно
 * перед открытием сессии и ровно один раз. Две границы, которые здесь
 * проверяются, стоят денег и публикаций: перевод не должен запускаться
 * повторно на возобновлённой сессии (там `snippet` площадкой уже
 * принят) и не должен ронять публикацию своим отказом.
 */
describe('PublishWorkerService — локализации ролика (этап 137)', () => {
  it('переводит с языка заявки и отдаёт переводы в openSession вместе с языком', async () => {
    const { service, youtube, translations } = setup({
      rows: [row({ language: 'uk', sessionId: 's1', userId: 'u1' })],
    });
    translations.translate.mockResolvedValue({
      en: { title: 'Steel mug', description: 'A mug' },
    });

    await service.runBatch();

    expect(translations.translate).toHaveBeenCalledWith(
      { title: 'Товар', description: 'Описание' },
      'uk',
      { sessionId: 's1', userId: 'u1' },
    );
    expect(youtube.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'uk',
        localizations: { en: { title: 'Steel mug', description: 'A mug' } },
      }),
      'at-1',
    );
  });

  it('язык из старой заявки (без колонки) превращается в умолчание продукта', async () => {
    const { service, youtube } = setup({ rows: [row({ language: null })] });
    await service.runBatch();
    expect(youtube.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'ru' }),
      'at-1',
    );
  });

  it('возобновлённая сессия переводит НЕ заново: snippet площадкой уже принят', async () => {
    const { service, youtube, translations } = setup({
      rows: [row({ uploadJobId: 'https://upload.example/session-1' })],
    });
    youtube.checkStatus.mockResolvedValue({ done: false, bytesUploaded: 10 });

    await service.runBatch();

    expect(translations.translate).not.toHaveBeenCalled();
    expect(youtube.openSession).not.toHaveBeenCalled();
  });

  it('отказ перевода публикацию не отменяет', async () => {
    // Приёмка этапа прямо это требует: локализация — украшение, а не
    // условие выгрузки.
    const { service, youtube, translations } = setup({ rows: [row()] });
    translations.translate.mockRejectedValue(new Error('gemini down'));

    const result = await service.runBatch();

    expect(result.published).toBe(1);
    expect(youtube.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ localizations: {} }),
      'at-1',
    );
  });
});

/**
 * Субтитры к опубликованному ролику (этап 137).
 *
 * Это единственное место всего ТЗ, которому нужен скоуп
 * `youtube.force-ssl`. Здесь проверяется, что без него ничего не
 * ломается, а с ним — уходит ровно то, что снято в заявку.
 */
const CAPTIONS_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nПривет\n';

describe('PublishWorkerService — субтитры (этап 137)', () => {
  it('у канала с расширенным согласием субтитры уходят после публикации', async () => {
    const { service, captions, prisma } = setup({
      rows: [row({ subtitlesSrt: SRT, language: 'uk' })],
      channelScopes: [
        'https://www.googleapis.com/auth/youtube.upload',
        CAPTIONS_SCOPE,
      ],
    });

    await service.runBatch();

    expect(captions.insert).toHaveBeenCalledWith(
      { videoId: 'yt-1', language: 'uk', name: 'Original', srt: SRT.trim() },
      'at-1',
    );
    const marked = prisma.publicationRequest.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.captionsUploadedAt);
    expect(marked).toBeTruthy();
  });

  it('у канала со старым согласием субтитры не грузятся, а причина записана', async () => {
    // Ролик при этом опубликован: отсутствие субтитров не повод
    // отменять публикацию.
    const { service, captions, prisma } = setup({
      rows: [row({ subtitlesSrt: SRT })],
    });

    const result = await service.runBatch();

    expect(result.published).toBe(1);
    expect(captions.insert).not.toHaveBeenCalled();
    const noted = prisma.publicationRequest.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.captionsError);
    expect(String(noted?.captionsError)).toMatch(/расширенного согласия/);
  });

  it('заявка без текста субтитров к площадке не обращается вовсе', async () => {
    const { service, captions } = setup({
      rows: [row()],
      channelScopes: [CAPTIONS_SCOPE],
    });
    await service.runBatch();
    expect(captions.insert).not.toHaveBeenCalled();
  });

  it('отказ площадки по субтитрам не отменяет публикацию', async () => {
    // Ролик уже на канале: вернуть заявку в очередь значило бы залить
    // его второй раз.
    const { service, prisma, captions } = setup({
      rows: [row({ subtitlesSrt: SRT })],
      channelScopes: [CAPTIONS_SCOPE],
    });
    captions.insert.mockRejectedValue(new Error('403 insufficient scope'));

    const result = await service.runBatch();

    expect(result.published).toBe(1);
    expect(
      prisma.publicationRequest.update.mock.calls.some(
        (c) => c[0].data.status === 'PUBLISHED',
      ),
    ).toBe(true);
    // Причина записана в заявку: «субтитров нет» должно иметь ответ в
    // базе, а не только в логе.
    const noted = prisma.publicationRequest.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.captionsError);
    expect(String(noted?.captionsError)).toMatch(/insufficient scope/);
  });

  it('суточный потолок держит субтитры: площадку не трогаем, причину пишем', async () => {
    // Дорожка субтитров стоит 400 единиц из 10 000 на весь проект в
    // сутки — потолок бережёт поиск референсов, блог и теги.
    const { service, captions, prisma } = setup({
      rows: [row({ subtitlesSrt: SRT })],
      channelScopes: [CAPTIONS_SCOPE],
      captionsToday: 10,
    });

    const result = await service.runBatch();

    expect(result.published).toBe(1);
    expect(captions.insert).not.toHaveBeenCalled();
    const noted = prisma.publicationRequest.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.captionsError);
    expect(String(noted?.captionsError)).toMatch(/потолок/);
  });

  it('под потолком считаются только сегодняшние дорожки', async () => {
    // Если считать за всё время, потолок сработает один раз и больше
    // субтитров не будет никогда.
    const { service, prisma } = setup({
      rows: [row({ subtitlesSrt: SRT })],
      channelScopes: [CAPTIONS_SCOPE],
    });

    await service.runBatch();

    const where = prisma.publicationRequest.count.mock.calls[0]?.[0]?.where as
      | { captionsUploadedAt?: { gte?: Date } }
      | undefined;
    const since = where?.captionsUploadedAt?.gte;
    expect(since).toBeInstanceOf(Date);
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    expect(since?.getTime()).toBe(midnight.getTime());
  });
});
