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

  it('generate_audio: false уходит в тело, когда просим немой ролик', async () => {
    // docs.x.ai, Video Generation: «Generated videos include an audio
    // track by default. Pass `generate_audio=False` to request a silent
    // video». Нужно поздравлению: реплику озвучиваем мы, и дорожка
    // модели с той же репликой легла бы второй речью поверх нашей.
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r1' },
    });
    const svc = new GrokVideoService();
    await svc.startGeneration({
      prompt: 'p',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '480p',
      generateAudio: false,
    });
    const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.generate_audio).toBe(false);
  });

  it('звук нужен — поле не шлётся вовсе, чужое умолчание у себя не фиксируем', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r1' },
    });
    const svc = new GrokVideoService();
    for (const generateAudio of [true, undefined]) {
      mockedAxios.post.mockClear();
      await svc.startGeneration({
        prompt: 'p',
        durationSeconds: 8,
        aspectRatio: '9:16',
        resolution: '480p',
        ...(generateAudio === undefined ? {} : { generateAudio }),
      });
      const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
      expect(body).not.toHaveProperty('generate_audio');
    }
  });

  it('пресетный голос уходит как reference_audios: [{ voice_id }]', async () => {
    // docs.x.ai, Reference-to-Video: «give your subject a voice by
    // passing up to 3 preset voices with reference_audios»; каждая
    // запись — объект с `voice_id`, а не голая строка (тот же приём,
    // что у `reference_images` с `{ url }`).
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r1' },
    });
    const svc = new GrokVideoService();
    await svc.startGeneration({
      prompt: 'p <AUDIO_0>',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '480p',
      referenceAudioVoiceIds: ['eve'],
    });
    const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.reference_audios).toEqual([{ voice_id: 'eve' }]);
  });

  it('голосов не передали — поля нет вовсе', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { request_id: 'r1' },
    });
    const svc = new GrokVideoService();
    await svc.startGeneration({
      prompt: 'p',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '480p',
      referenceAudioVoiceIds: [],
    });
    const body = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('reference_audios');
  });

  it('больше трёх голосов — отказ до сетевого вызова', async () => {
    // «Max 3 voices per request» (docs.x.ai). Платить за заведомо
    // отклонённый запрос незачем.
    const svc = new GrokVideoService();
    mockedAxios.post.mockClear();
    await expect(
      svc.startGeneration({
        prompt: 'p',
        durationSeconds: 8,
        aspectRatio: '9:16',
        resolution: '480p',
        referenceAudioVoiceIds: ['eve', 'leo', 'ara', 'rex'],
      }),
    ).rejects.toThrow(/reference_audios/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
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

describe('GrokVideoService.listPresetVoices', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
  });

  it('читает роестр у провайдера, а не держит копию у себя', async () => {
    // Роестр пополняется без нас: на 22.09.2026 там 28 голосов.
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: {
        voices: [
          { voice_id: 'ara', name: 'Ara', language: 'multilingual' },
          { voice_id: 'eve', name: 'Eve', language: 'multilingual' },
        ],
      },
    });
    const svc = new GrokVideoService();
    await expect(svc.listPresetVoices()).resolves.toEqual([
      { voiceId: 'ara', name: 'Ara', language: 'multilingual' },
      { voiceId: 'eve', name: 'Eve', language: 'multilingual' },
    ]);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.x.ai/v1/tts/voices',
      expect.anything(),
    );
  });

  it('запись без voice_id пропускается — сослаться на неё в промпте нечем', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: { voices: [{ name: 'Безымянный' }, { voice_id: 'leo' }] },
    });
    const svc = new GrokVideoService();
    const voices = await svc.listPresetVoices();
    expect(voices).toEqual([{ voiceId: 'leo', name: 'leo', language: null }]);
  });

  it('провайдер ответил ошибкой — пустой список, а не исключение', async () => {
    // Без роестра экран покажет пустой выбор и предложит обычную
    // озвучку. Это хуже, но собрать ролик не мешает.
    mockedAxios.get.mockResolvedValue({ status: 500, data: {} });
    const svc = new GrokVideoService();
    await expect(svc.listPresetVoices()).resolves.toEqual([]);
  });

  it('голый массив вместо { voices } тоже читается', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: [{ voice_id: 'rex', name: 'Rex' }],
    });
    const svc = new GrokVideoService();
    await expect(svc.listPresetVoices()).resolves.toEqual([
      { voiceId: 'rex', name: 'Rex', language: null },
    ]);
  });
});
