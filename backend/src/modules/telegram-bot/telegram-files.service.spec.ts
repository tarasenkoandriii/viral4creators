import { TelegramFilesService } from './telegram-files.service';
import { TELEGRAM_FILE_LIMIT } from '../../common/test-ticket';

const OLD_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function build() {
  const uploadBuffer = jest
    .fn()
    .mockResolvedValue({ url: 'https://blob/test-tickets/x.jpg' });
  const service = new TelegramFilesService({ uploadBuffer } as never);
  return { service, uploadBuffer };
}

function okFetch(filePath = 'photos/file_1.jpg', fileSize = 1234) {
  return jest.fn().mockImplementation((url: string) => {
    if (String(url).includes('/getFile')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          result: { file_path: filePath, file_size: fileSize },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(fileSize),
    });
  });
}

describe('TelegramFilesService.store', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'T:token';
  });
  afterAll(() => {
    if (OLD_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = OLD_TOKEN;
  });

  it('скачивает и кладёт в хранилище', async () => {
    const { service, uploadBuffer } = build();
    global.fetch = okFetch() as never;
    const result = await service.store(
      [{ fileId: 'f1', kind: 'PHOTO', mimeType: 'image/jpeg' }],
      'u1/tickets/100',
    );
    expect(result.failures).toEqual([]);
    expect(result.stored).toEqual([
      {
        url: 'https://blob/test-tickets/x.jpg',
        kind: 'PHOTO',
        size: 1234,
        fileName: null,
        mimeType: 'image/jpeg',
      },
    ]);
    // Путь детерминированный и под ЧУЖИМ префиксом `users/` (аудит
    // этапа 157): метла обходит закрытый список областей и разбирает
    // пути как `<префикс>/<id>/…`. Под собственным префиксом эти файлы
    // не подбирал бы никто и никогда.
    expect(uploadBuffer.mock.calls[0][0]).toBe('users/u1/tickets/100-0.jpg');
  });

  it('заведомо большой файл не скачивается вовсе', async () => {
    // Запрос всё равно вернёт отказ — тратить на него время вебхука
    // незачем.
    const { service } = build();
    const fetchMock = okFetch();
    global.fetch = fetchMock as never;
    const result = await service.store(
      [{ fileId: 'f1', kind: 'VIDEO', size: TELEGRAM_FILE_LIMIT + 1 }],
      'u1-100',
    );
    expect(result.stored).toEqual([]);
    expect(result.failures).toEqual(['too-big']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('размер узнался только из getFile — всё равно отказываем', async () => {
    // `file_size` в самом сообщении необязателен.
    const { service, uploadBuffer } = build();
    global.fetch = okFetch('videos/f.mp4', TELEGRAM_FILE_LIMIT + 1) as never;
    const result = await service.store([{ fileId: 'f1', kind: 'VIDEO' }], 'k');
    expect(result.failures).toEqual(['failed']);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('Telegram отказал — тикет важнее вложения', async () => {
    const { service } = build();
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400 }) as never;
    const result = await service.store([{ fileId: 'f1', kind: 'PHOTO' }], 'k');
    expect(result).toEqual({ stored: [], failures: ['failed'] });
  });

  it('сеть упала — тоже не роняет приём', async () => {
    const { service } = build();
    global.fetch = jest.fn().mockRejectedValue(new Error('сеть')) as never;
    const result = await service.store([{ fileId: 'f1', kind: 'PHOTO' }], 'k');
    expect(result).toEqual({ stored: [], failures: ['failed'] });
  });

  it('тип угадывается по расширению, когда Telegram его не прислал', async () => {
    const { service, uploadBuffer } = build();
    global.fetch = okFetch('documents/console.log') as never;
    await service.store([{ fileId: 'f1', kind: 'DOCUMENT' }], 'k');
    expect(uploadBuffer.mock.calls[0][2]).toBe('text/plain');
  });

  it('расширения нет или оно странное — путь остаётся без него', async () => {
    const { service, uploadBuffer } = build();
    global.fetch = okFetch('documents/noext') as never;
    await service.store([{ fileId: 'f1', kind: 'DOCUMENT' }], 'k');
    expect(uploadBuffer.mock.calls[0][0]).toBe('users/k-0');
    expect(uploadBuffer.mock.calls[0][2]).toBe('application/octet-stream');
  });

  it('несколько файлов качаются разом, а не по очереди', async () => {
    // Три времени ожидания подряд внутри одного вебхука — это его
    // время жизни.
    const { service } = build();
    let running = 0;
    let peak = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (String(url).includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ result: { file_path: 'a/b.png' } }),
        };
      }
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(10) };
    }) as never;
    await service.store(
      [
        { fileId: 'a', kind: 'PHOTO' },
        { fileId: 'b', kind: 'PHOTO' },
        { fileId: 'c', kind: 'PHOTO' },
      ],
      'k',
    );
    expect(peak).toBeGreaterThan(1);
  });

  it('нечего качать — ни одного запроса', async () => {
    const { service } = build();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    expect(await service.store([], 'k')).toEqual({ stored: [], failures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('без токена бота ничего не качается', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { service } = build();
    const result = await service.store([{ fileId: 'f', kind: 'PHOTO' }], 'k');
    expect(result).toEqual({ stored: [], failures: ['failed'] });
  });
});
