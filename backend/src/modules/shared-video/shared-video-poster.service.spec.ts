/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  POSTER_POLL_ATTEMPTS,
  SharedVideoPosterService,
} from './shared-video-poster.service';
import { POSTER_OUTPUT_NAME } from '../../common/poster-frame';

function build(
  over: {
    configured?: boolean;
    statuses?: Array<Record<string, unknown>>;
    fetchOk?: boolean;
  } = {},
) {
  const submit = jest.fn().mockResolvedValue({ jobId: 'j1', status: 'queued' });
  const queue = [...(over.statuses ?? [])];
  const status = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve(queue.shift() ?? { status: 'pending' }),
    );
  const ffmpeg = {
    configured: () => over.configured ?? true,
    submit,
    status,
  };
  const uploadBuffer = jest
    .fn()
    .mockResolvedValue({ url: 'https://blob.test/shared-videos/sv1/poster.jpg' });
  const blob = { uploadBuffer };
  const svc = new SharedVideoPosterService(ffmpeg as any, blob as any);
  // Ожидание между опросами в тесте не нужно — проверяется логика, а не
  // то, что `setTimeout` работает.
  (svc as any).sleep = () => Promise.resolve();
  (globalThis as any).fetch = jest.fn().mockResolvedValue({
    ok: over.fetchOk ?? true,
    status: over.fetchOk === false ? 500 : 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  return { svc, submit, status, uploadBuffer };
}

const done = (outputs: Record<string, string>) => ({
  status: 'completed',
  outputs,
});

describe('SharedVideoPosterService', () => {
  it('готовый кадр ложится в наш Blob по переданному пути', async () => {
    const { svc, uploadBuffer } = build({
      statuses: [done({ [POSTER_OUTPUT_NAME]: 'https://ff.test/out.jpg' })],
    });
    const got = await svc.capture(
      'https://blob.test/v.mp4',
      'shared-videos/sv1/poster.jpg',
    );
    expect(got).toEqual({
      url: 'https://blob.test/shared-videos/sv1/poster.jpg',
      pathname: 'shared-videos/sv1/poster.jpg',
    });
    expect(uploadBuffer).toHaveBeenCalledWith(
      'shared-videos/sv1/poster.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
  });

  it('сервис не настроен — задача даже не отправляется', async () => {
    // Стенд без FFMPEG_API_KEY — не сбой: страница просто выйдет без
    // постера и возьмёт запасную картинку.
    const { svc, submit } = build({ configured: false });
    expect(await svc.capture('https://blob.test/v.mp4', 'p.jpg')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('файл берётся ПО ИМЕНИ, а не «первый попавшийся выход»', async () => {
    // Имя выхода задаём мы сами. Взять чужой файл, если сервис однажды
    // вернёт их несколько, значило бы положить в постер неизвестно что.
    const { svc } = build({
      statuses: [done({ 'something-else.mp4': 'https://ff.test/other.mp4' })],
    });
    expect(await svc.capture('https://blob.test/v.mp4', 'p.jpg')).toBeNull();
  });

  it('задача отказала — постера нет, но и исключения нет', async () => {
    const { svc } = build({
      statuses: [{ status: 'failed', error: 'нет входа' }],
    });
    expect(await svc.capture('https://blob.test/v.mp4', 'p.jpg')).toBeNull();
  });

  it('не дождались — сдаёмся, а не ждём бесконечно', async () => {
    // Публикация — синхронное действие пользователя: держать её сколько
    // угодно ради картинки нельзя.
    const { svc, status } = build({ statuses: [] });
    expect(await svc.capture('https://blob.test/v.mp4', 'p.jpg')).toBeNull();
    expect(status).toHaveBeenCalledTimes(POSTER_POLL_ATTEMPTS);
  });

  it('скачивание не удалось — тоже null, а не падение', async () => {
    const { svc } = build({
      statuses: [done({ [POSTER_OUTPUT_NAME]: 'https://ff.test/out.jpg' })],
      fetchOk: false,
    });
    expect(await svc.capture('https://blob.test/v.mp4', 'p.jpg')).toBeNull();
  });

  it('сеть упала на отправке — публикация не должна об этом узнать', async () => {
    const { svc, submit } = build();
    submit.mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      svc.capture('https://blob.test/v.mp4', 'p.jpg'),
    ).resolves.toBeNull();
  });
});
