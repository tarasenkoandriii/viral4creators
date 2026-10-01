/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Аватар пользователя для плашек админки: выбор размера, 404-ветки,
 * кеш и то, что токен бота не утекает ни в ответ, ни в лог.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { Logger } from '@nestjs/common';
import {
  AdminUserAvatarService,
  AVATAR_CACHE_MAX,
  AVATAR_TTL_MS,
  pickPhotoSize,
} from './admin-user-avatar.service';

const TOKEN = '123456:SECRET-bot-token';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function size(side: number, id = `f${side}`) {
  return { file_id: id, width: side, height: side };
}

function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => 'application/json' },
  };
}

function file(type = 'image/jpeg', status = 200) {
  return {
    ok: status === 200,
    status,
    arrayBuffer: async () =>
      JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength),
    headers: { get: () => type },
  };
}

/** Telegram «как настоящий»: фото 160/320/640, getFile, файл. */
function telegram(
  over: Partial<Record<'photos' | 'getFile' | 'file', any>> = {},
) {
  return jest.fn(async (url: string) => {
    if (url.includes('/getUserProfilePhotos')) {
      return (
        over.photos ??
        json({
          ok: true,
          result: {
            total_count: 1,
            photos: [[size(640), size(160), size(320)]],
          },
        })
      );
    }
    if (url.includes('/getFile')) {
      return (
        over.getFile ??
        json({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
      );
    }
    return over.file ?? file();
  });
}

function build(telegramId: string | null = '4242') {
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(telegramId === null ? null : { telegramId }),
    },
  };
  return { svc: new AdminUserAvatarService(prisma as any), prisma };
}

describe('pickPhotoSize', () => {
  it('самый маленький из тех, что не меньше 96 px', () => {
    expect(pickPhotoSize([size(640), size(160), size(320)])?.width).toBe(160);
    expect(pickPhotoSize([size(96), size(160)])?.width).toBe(96);
  });

  it('все меньше 96 — самый большой, а не самый мелкий', () => {
    expect(pickPhotoSize([size(40), size(80), size(64)])?.width).toBe(80);
  });

  it('прямоугольник меряется по меньшей стороне', () => {
    // 100×50 по большей стороне прошёл бы порог и был бы «мельче» 150,
    // но в кружке он мылит по меньшей — берём 150.
    const wide = { file_id: 'w', width: 100, height: 50 };
    expect(pickPhotoSize([wide, size(150)])?.file_id).toBe('f150');
  });

  it('пусто — null', () => {
    expect(pickPhotoSize([])).toBeNull();
  });
});

describe('AdminUserAvatarService', () => {
  const env = { ...process.env };
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    fetchMock = telegram();
    (global as any).fetch = fetchMock;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    warn.mockRestore();
    error.mockRestore();
  });

  it('качает выбранный размер и отдаёт байты с типом', async () => {
    const { svc } = build();
    const photo = await svc.avatar('u1');
    expect(photo?.type).toBe('image/jpeg');
    expect(Buffer.compare(photo!.bytes, JPEG)).toBe(0);

    const [photosCall, fileCall, download] = fetchMock.mock.calls;
    expect(JSON.parse(photosCall[1].body)).toEqual({
      user_id: 4242,
      limit: 1,
    });
    // 160 — самый маленький ≥ 96; не оригинал 640.
    expect(JSON.parse(fileCall[1].body)).toEqual({ file_id: 'f160' });
    expect(download[0]).toBe(
      `https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`,
    );
    // Таймаут у каждого запроса — иначе зависший Telegram держит плашку.
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeDefined();
    }
  });

  it('файловый сервер без image/* в заголовке — отдаём image/jpeg', async () => {
    fetchMock = telegram({ file: file('application/octet-stream') });
    (global as any).fetch = fetchMock;
    const { svc } = build();
    expect((await svc.avatar('u1'))?.type).toBe('image/jpeg');
  });

  it('повторный запрос — из кеша, в Telegram не ходит', async () => {
    const { svc, prisma } = build();
    await svc.avatar('u1');
    const calls = fetchMock.mock.calls.length;
    await svc.avatar('u1');
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('через сутки кеш протухает и фото спрашивается заново', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const { svc } = build();
      await svc.avatar('u1');
      const calls = fetchMock.mock.calls.length;
      now.mockReturnValue(1_000_000 + AVATAR_TTL_MS - 1);
      await svc.avatar('u1');
      expect(fetchMock.mock.calls.length).toBe(calls);
      now.mockReturnValue(1_000_000 + AVATAR_TTL_MS + 1);
      await svc.avatar('u1');
      expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      now.mockRestore();
    }
  });

  it('«фото нет» тоже кешируется — пустые плашки не бьют Telegram', async () => {
    fetchMock = telegram({
      photos: json({ ok: true, result: { total_count: 0, photos: [] } }),
    });
    (global as any).fetch = fetchMock;
    const { svc } = build();
    expect(await svc.avatar('u1')).toBeNull();
    expect(await svc.avatar('u1')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('кеш не растёт больше потолка — старейшие вытесняются', async () => {
    const { svc } = build('dev-1'); // без Telegram: быстро и без fetch
    for (let i = 0; i <= AVATAR_CACHE_MAX; i++) await svc.avatar(`u${i}`);
    const cache = (svc as any).cache as Map<string, unknown>;
    expect(cache.size).toBe(AVATAR_CACHE_MAX);
    expect(cache.has('u0')).toBe(false);
    expect(cache.has(`u${AVATAR_CACHE_MAX}`)).toBe(true);
  });

  it('dev-/fixture-telegramId — null без обращения к Telegram', async () => {
    for (const id of ['dev-123', 'fixture-1']) {
      const { svc } = build(id);
      expect(await svc.avatar('u1')).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('неизвестный пользователь — null и не занимает кеш', async () => {
    const { svc } = build(null);
    expect(await svc.avatar('nope')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(((svc as any).cache as Map<string, unknown>).size).toBe(0);
  });

  it('бот не знает пользователя (400) — null, запоминается', async () => {
    fetchMock = telegram({
      photos: json(
        { ok: false, description: 'Bad Request: user not found' },
        400,
      ),
    });
    (global as any).fetch = fetchMock;
    const { svc } = build();
    expect(await svc.avatar('u1')).toBeNull();
    await svc.avatar('u1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getFile без пути — null', async () => {
    fetchMock = telegram({ getFile: json({ ok: true, result: {} }) });
    (global as any).fetch = fetchMock;
    const { svc } = build();
    expect(await svc.avatar('u1')).toBeNull();
  });

  it('5xx/429 — null, но НЕ кешируется: следующая попытка снова спросит', async () => {
    fetchMock = telegram({ photos: json({ ok: false }, 502) });
    (global as any).fetch = fetchMock;
    const { svc } = build();
    expect(await svc.avatar('u1')).toBeNull();
    await svc.avatar('u1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('без TELEGRAM_BOT_TOKEN — null без запросов', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { svc } = build();
    expect(await svc.avatar('u1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ошибка сети с токеном в тексте — токен вычищен из лога, уровень warn', async () => {
    fetchMock = jest.fn(async (url: string) => {
      throw new Error(`request to ${url} failed, reason: ECONNRESET`);
    });
    (global as any).fetch = fetchMock;
    const { svc } = build();
    expect(await svc.avatar('u1')).toBeNull();
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('SECRET');
    expect(error).not.toHaveBeenCalled();
  });
});
