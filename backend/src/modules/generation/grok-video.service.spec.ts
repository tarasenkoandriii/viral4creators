import axios from 'axios';

jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({
    grok: { apiKey: 'test-grok-key', videoModel: 'grok-imagine-video-1.5' },
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

  it('404 (старая ошибка, воспроизведена намеренно) — не падает, возвращает done: false с ошибкой', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 404,
      data: { code: 'Some requested entity was not found' },
    });
    const svc = new GrokVideoService();
    const result = await svc.getStatus('req-123');
    expect(result.done).toBe(false);
    expect(result.error).toContain('404');
  });
});
