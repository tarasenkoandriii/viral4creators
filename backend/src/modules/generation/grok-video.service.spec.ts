import axios from 'axios';

jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({
    grok: {
      apiKey: 'test-grok-key',
      videoModel: 'grok-imagine-video-1.5',
      videoExtendModel: 'grok-imagine-video',
    },
  }),
}));
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { GrokVideoService } from './grok-video.service';

// Найдено по реальному сбою в проде (2026-09-14, HTTP 404 "No handler
// found on route") — первая догадка об URL опроса статуса
// (`/v1/videos/generations/{id}`) оказалась неверной. Тест фиксирует
// подтверждённый официальной документацией путь
// (`docs.x.ai/developers/rest-api-reference/inference/videos`), чтобы
// не откатиться на прежнюю догадку при следующей правке.
describe('GrokVideoService.getStatus', () => {
  it('опрашивает /v1/videos/{id}, БЕЗ сегмента /generations/', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: { status: 'done', video: { url: 'https://vidgen.x.ai/x.mp4' } },
    });
    const svc = new GrokVideoService();
    await svc.getStatus('req-123');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/req-123',
      expect.anything(),
    );
  });

  it('реальная форма ответа (docs.x.ai) — status "done" + video.url разбираются верно', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: {
        status: 'done',
        video: {
          url: 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-cb3a83ec.mp4',
          duration: 1,
          respect_moderation: true,
        },
        model: 'grok-imagine-video',
        usage: { cost_in_usd_ticks: 500000000 },
        progress: 100,
      },
    });
    const svc = new GrokVideoService();
    const result = await svc.getStatus('req-123');
    expect(result).toEqual({
      done: true,
      videoUrl: 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-cb3a83ec.mp4',
    });
  });

  it('404 — постоянная ошибка (request_id неизвестен): done: true с ошибкой, а не бесконечный опрос (М-6.4)', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 404,
      data: { code: 'Some requested entity was not found' },
    });
    const svc = new GrokVideoService();
    const result = await svc.getStatus('req-123');
    expect(result.done).toBe(true);
    expect(result.error).toContain('404');
  });

  it('503 — транзиентно: done: false, опрос продолжается', async () => {
    mockedAxios.get.mockResolvedValue({ status: 503, data: {} });
    const result = await new GrokVideoService().getStatus('req-123');
    expect(result.done).toBe(false);
  });

  it('expired — терминальный статус с внятным текстом; error-объект разворачивается в message (М-6.4)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { status: 'expired' },
    });
    const svc = new GrokVideoService();
    expect(await svc.getStatus('r')).toEqual({
      done: true,
      error: 'xAI: запрос истёк (expired)',
    });
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { status: 'failed', error: { message: 'moderated' } },
    });
    expect(await svc.getStatus('r')).toEqual({
      done: true,
      error: 'moderated',
    });
  });
});

// Найдено по реальному сбою 14.09.2026 («при любой длительности — 8
// секунд»): продолжение цепочки слалось на `/v1/videos/generations` с
// несуществующим полем `video_url`, а базовый вызов всегда просил 8 с.
// Тесты фиксируют подтверждённую документацией форму
// (`docs.x.ai/developers/model-capabilities/video/extension`).
describe('GrokVideoService.startGeneration / extendVideo (длительность)', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
  });

  it('startGeneration передаёт нативную длительность, а не константу 8', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r1' },
    });
    const svc = new GrokVideoService();
    await svc.startGeneration({
      prompt: 'p',
      durationSeconds: 12,
      aspectRatio: '9:16',
      resolution: '480p',
    });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/generations',
      expect.objectContaining({ duration: 12 }),
      expect.anything(),
    );
  });

  it('image-to-video: картинка уходит как image: { url }, а не image_url (М-6.1 седьмого аудита)', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r1' },
    });
    const svc = new GrokVideoService();
    await svc.startGeneration({
      prompt: 'p',
      imageUrl: 'https://blob.test/product.png',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '480p',
    });
    const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.image).toEqual({ url: 'https://blob.test/product.png' });
    expect(body).not.toHaveProperty('image_url');
  });

  it('startGeneration отвергает длительность вне 1–15 с до вызова API', async () => {
    const svc = new GrokVideoService();
    await expect(
      svc.startGeneration({
        prompt: 'p',
        durationSeconds: 16,
        aspectRatio: '9:16',
        resolution: '480p',
      }),
    ).rejects.toThrow(/1–15/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('extendVideo идёт на /v1/videos/extensions с video: { url } и длиной хвоста', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r2' },
    });
    const svc = new GrokVideoService();
    const result = await svc.extendVideo({
      prompt: 'continue',
      videoUrl: 'https://blob.test/seg1.mp4',
      durationSeconds: 5,
    });
    expect(result).toEqual({ requestId: 'r2' });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.x.ai/v1/videos/extensions',
      {
        // Расширение — отдельной моделью (у -1.5 не поддерживается).
        model: 'grok-imagine-video',
        prompt: 'continue',
        duration: 5,
        video: { url: 'https://blob.test/seg1.mp4' },
      },
      expect.anything(),
    );
    const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('video_url');
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('resolution');
  });

  it('extendVideo отвергает хвост вне 2–10 с до вызова API', async () => {
    const svc = new GrokVideoService();
    await expect(
      svc.extendVideo({
        prompt: 'c',
        videoUrl: 'https://x/1.mp4',
        durationSeconds: 1,
      }),
    ).rejects.toThrow(/2–10/);
    await expect(
      svc.extendVideo({
        prompt: 'c',
        videoUrl: 'https://x/1.mp4',
        durationSeconds: 11,
      }),
    ).rejects.toThrow(/2–10/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
