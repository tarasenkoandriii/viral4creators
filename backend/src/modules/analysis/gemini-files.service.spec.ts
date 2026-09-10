/**
 * GeminiFilesService — транзит референса через Files API (этап 53, В-6.15:
 * файл был не покрыт вовсе, а его конструктор читал ключ и никуда не
 * передавал).
 */
const upload = jest.fn();
const get = jest.fn();
const del = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: class {
    files = { upload, get, delete: del };
  },
  FileState: { PROCESSING: 'PROCESSING', ACTIVE: 'ACTIVE', FAILED: 'FAILED' },
}));

import { GeminiFilesService } from './gemini-files.service';

const keyBefore = process.env.GEMINI_API_KEY;
beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = keyBefore;
});
beforeEach(() => {
  upload.mockReset();
  get.mockReset();
  del.mockReset();
});

describe('GeminiFilesService.uploadAndWaitActive', () => {
  it('ACTIVE сразу — возвращает имя, uri и тип', async () => {
    upload.mockResolvedValue({
      name: 'files/x',
      state: 'ACTIVE',
      uri: 'https://g/files/x',
      mimeType: 'video/mp4',
    });
    const svc = new GeminiFilesService();
    const r = await svc.uploadAndWaitActive(Buffer.from('v'), 'video/mp4');
    expect(r).toEqual({
      name: 'files/x',
      uri: 'https://g/files/x',
      mimeType: 'video/mp4',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('PROCESSING → ACTIVE: дожидается через files.get', async () => {
    jest.useFakeTimers();
    upload.mockResolvedValue({ name: 'files/x', state: 'PROCESSING' });
    get
      .mockResolvedValueOnce({ name: 'files/x', state: 'PROCESSING' })
      .mockResolvedValueOnce({ name: 'files/x', state: 'ACTIVE', uri: 'u' });
    const svc = new GeminiFilesService();
    const p = svc.uploadAndWaitActive(Buffer.from('v'), 'video/mp4');
    await jest.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.uri).toBe('u');
    // Тип, если Google его не назвал, — наш исходный.
    expect(r.mimeType).toBe('video/mp4');
    expect(get).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('FAILED — ошибка с текстом провайдера', async () => {
    upload.mockResolvedValue({
      name: 'files/x',
      state: 'FAILED',
      error: { message: 'codec unsupported' },
    });
    await expect(
      new GeminiFilesService().uploadAndWaitActive(
        Buffer.from('v'),
        'video/mp4',
      ),
    ).rejects.toThrow(/codec unsupported/);
  });

  it('без имени файла или без uri — отказ, а не пустой референс в разбор', async () => {
    upload.mockResolvedValue({ state: 'ACTIVE', uri: 'u' });
    await expect(
      new GeminiFilesService().uploadAndWaitActive(
        Buffer.from('v'),
        'video/mp4',
      ),
    ).rejects.toThrow(/file name/);
    upload.mockResolvedValue({ name: 'files/x', state: 'ACTIVE' });
    await expect(
      new GeminiFilesService().uploadAndWaitActive(
        Buffer.from('v'),
        'video/mp4',
      ),
    ).rejects.toThrow(/URI/);
  });

  it('удаление файла у Google не бросает', async () => {
    del.mockRejectedValue(new Error('gone'));
    await expect(
      new GeminiFilesService().deleteFile('files/x'),
    ).resolves.toBeUndefined();
  });
});
