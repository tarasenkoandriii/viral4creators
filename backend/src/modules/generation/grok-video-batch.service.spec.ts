/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники: подставляем заглушки на месте зависимостей, форму которых тест не проверяет */
import axios from 'axios';
import { GrokVideoBatchService } from './grok-video-batch.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GrokVideoBatchService', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    delete process.env.GROK_API_KEY;
  });

  const withKey = () => {
    process.env.GROK_API_KEY = 'test-key';
    return new GrokVideoBatchService();
  };

  describe('без ключа', () => {
    it('submitBatch — понятная ошибка, ни одного HTTP-вызова', async () => {
      const r = await new GrokVideoBatchService().submitBatch('test', [
        {
          batchRequestId: '1',
          prompt: 'a cat',
          durationSeconds: 8,
          aspectRatio: '9:16',
          resolution: '480p',
        },
      ]);
      expect(r).toEqual({ error: 'GROK_API_KEY не задан' });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('getBatchStatus — null, без HTTP-вызова', async () => {
      expect(await new GrokVideoBatchService().getBatchStatus('b1')).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('getBatchResults — пустой объект, без HTTP-вызова', async () => {
      expect(await new GrokVideoBatchService().getBatchResults('b1')).toEqual(
        {},
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('isConfigured — false', () => {
      expect(new GrokVideoBatchService().isConfigured()).toBe(false);
    });
  });

  describe('submitBatch', () => {
    it('пустой список запросов — ошибка без HTTP-вызова', async () => {
      const r = await withKey().submitBatch('test', []);
      expect(r).toEqual({ error: 'пустой список запросов для пачки' });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('imageUrl и referenceImageUrls одновременно — ошибка без HTTP-вызова (§15 ТЗ)', async () => {
      const r = await withKey().submitBatch('test', [
        {
          batchRequestId: 'v1',
          prompt: 'a cat',
          imageUrl: 'https://blob.test/product.png',
          referenceImageUrls: ['https://blob.test/char.png'],
          durationSeconds: 8,
          aspectRatio: '9:16',
          resolution: '480p',
        },
      ]);
      expect(r.error).toMatch(/взаимоисключающие/);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('счастливый путь: создаёт пачку, затем добавляет видео-запросы', async () => {
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { id: 'batch_456' } })
        .mockResolvedValueOnce({ status: 200, data: { added: 1 } });

      const r = await withKey().submitBatch('каталог: 3 ролика', [
        {
          batchRequestId: 'gen-1',
          prompt: 'A product on a table',
          imageUrl: 'https://blob.test/product.png',
          durationSeconds: 8,
          aspectRatio: '9:16',
          resolution: '480p',
        },
      ]);

      expect(r).toEqual({ xaiBatchId: 'batch_456' });
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      const [addUrl, addBody] = mockedAxios.post.mock.calls[1];
      expect(addUrl).toBe('https://api.x.ai/v1/batches/batch_456/requests');
      expect(addBody).toEqual({
        batch_requests: [
          {
            batch_request_id: 'gen-1',
            batch_request: {
              // Ключ — `{service}_{rpc}` по аналогии с подтверждённым
              // `chat_get_completion`; тело — по proto GenerateVideoRequest
              // (`image: { url }`, не `image_url`). См. доккомментарий класса.
              video_generation: {
                model: 'grok-imagine-video-1.5',
                prompt: 'A product on a table',
                image: { url: 'https://blob.test/product.png' },
                duration: 8,
                aspect_ratio: '9:16',
                resolution: '480p',
              },
            },
          },
        ],
      });
    });

    it('reference_images — массив объектов {url}, не голых строк', async () => {
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { id: 'batch_789' } })
        .mockResolvedValueOnce({ status: 200, data: { added: 1 } });

      await withKey().submitBatch('reference-to-video пачка', [
        {
          batchRequestId: 'gen-2',
          prompt: 'A character walks',
          referenceImageUrls: [
            'https://blob.test/a.png',
            'https://blob.test/b.png',
          ],
          durationSeconds: 8,
          aspectRatio: '9:16',
          resolution: '720p',
        },
      ]);

      const [, addBody] = mockedAxios.post.mock.calls[1];
      expect(
        (addBody as any).batch_requests[0].batch_request.video_generation
          .reference_images,
      ).toEqual([
        { url: 'https://blob.test/a.png' },
        { url: 'https://blob.test/b.png' },
      ]);
    });

    it('ошибка при создании пачки — не идёт дальше добавления запросов', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 500,
        data: { error: 'server error' },
      });
      const r = await withKey().submitBatch('test', [
        {
          batchRequestId: '1',
          prompt: 'x',
          durationSeconds: 8,
          aspectRatio: '9:16',
          resolution: '480p',
        },
      ]);
      expect(r.error).toMatch(/500/);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBatchStatus', () => {
    it('готовность — pendingCount, не success vs total (тот же принцип, что у GrokBatchService)', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          state: {
            num_requests: 5,
            num_success: 3,
            num_pending: 0,
            num_error: 2,
          },
        },
      });
      const status = await withKey().getBatchStatus('batch_1');
      expect(status).toEqual({
        totalCount: 5,
        completedCount: 3,
        pendingCount: 0,
        errorCount: 2,
      });
    });

    it('HTTP-ошибка — null, не бросает', async () => {
      mockedAxios.get.mockResolvedValueOnce({ status: 404, data: {} });
      expect(await withKey().getBatchStatus('missing')).toBeNull();
    });
  });

  describe('getBatchResults', () => {
    it('достаёт video.url по batch_request_id из ответа', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          results: [
            {
              batch_request_id: 'gen-1',
              batch_result: {
                response: {
                  // Имя oneof-ключа в REST не подтверждено — парсер
                  // ищет любой объект с `video.url`.
                  video_response: {
                    video: { url: 'https://vidgen.x.ai/result-1.mp4' },
                  },
                },
              },
            },
          ],
        },
      });
      const results = await withKey().getBatchResults('batch_1');
      expect(results).toEqual({ 'gen-1': 'https://vidgen.x.ai/result-1.mp4' });
    });

    it('элемент без url — пропускается, не падает', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          results: [{ batch_request_id: 'gen-failed', batch_result: {} }],
        },
      });
      const results = await withKey().getBatchResults('batch_1');
      expect(results).toEqual({});
    });

    it('пагинация — следует pagination_token до пустого', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              {
                batch_request_id: 'gen-1',
                batch_result: {
                  response: {
                    video_generation: { video: { url: 'https://x/1.mp4' } },
                  },
                },
              },
            ],
            pagination_token: 'page-2',
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              {
                batch_request_id: 'gen-2',
                batch_result: {
                  response: {
                    video_generation: { video: { url: 'https://x/2.mp4' } },
                  },
                },
              },
            ],
          },
        });
      const results = await withKey().getBatchResults('batch_1');
      expect(results).toEqual({
        'gen-1': 'https://x/1.mp4',
        'gen-2': 'https://x/2.mp4',
      });
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });
  });
});

// Доп. запрос владельца продукта (14.09.2026): транспорт Grok = batch
// для одиночных роликов — расширение цепочки тоже пачкой.
describe('GrokVideoBatchService — расширение и ошибки (одиночные ролики)', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    process.env.GROK_API_KEY = 'test-key';
  });

  it('submitExtendBatch — video_extension_request по proto: video.url + duration, без формата/разрешения', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ status: 200, data: { batch_id: 'batch_ext' } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const r = await new GrokVideoBatchService().submitExtendBatch('ext', [
      {
        batchRequestId: 'gen-1-ext-1',
        prompt: 'continue',
        videoUrl: 'https://blob.test/seg1.mp4',
        durationSeconds: 5,
      },
    ]);

    expect(r).toEqual({ xaiBatchId: 'batch_ext' });
    const [, addBody] = mockedAxios.post.mock.calls[1];
    expect(addBody).toEqual({
      batch_requests: [
        {
          batch_request_id: 'gen-1-ext-1',
          batch_request: {
            video_extension: {
              // Расширение — отдельной моделью (у -1.5 не поддерживается).
              model: 'grok-imagine-video',
              prompt: 'continue',
              video: { url: 'https://blob.test/seg1.mp4' },
              duration: 5,
            },
          },
        },
      ],
    });
  });

  it('getBatchResultsDetailed — ошибка запроса (google.rpc.Status) отделена от успехов', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [
          {
            batch_request_id: 'ok',
            batch_result: {
              response: {
                video_generation: { video: { url: 'https://x/ok.mp4' } },
              },
            },
          },
          {
            batch_request_id: 'bad',
            batch_result: { error: { code: 3, message: 'content moderated' } },
          },
        ],
      },
    });
    const r = await new GrokVideoBatchService().getBatchResultsDetailed('b');
    expect(r.urlsByRequestId).toEqual({ ok: 'https://x/ok.mp4' });
    expect(r.errorsByRequestId).toEqual({ bad: 'content moderated (code 3)' });
  });
});

// М-6.7 седьмого аудита: xAI молча проигнорировал ключ запроса → в пачке
// 0 элементов; сверяем сразу после подачи и отменяем сироту.
describe('GrokVideoBatchService — сверка num_requests после подачи (М-6.7)', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    process.env.GROK_API_KEY = 'test-key';
  });

  it('число принятых запросов не совпадает — ошибка вместо 26-часового ожидания, пачка отменяется', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ status: 200, data: { id: 'b1' } }) // create
      .mockResolvedValueOnce({ status: 200, data: {} }) // add
      .mockResolvedValueOnce({ status: 200, data: {} }); // cancel
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: {
        state: {
          num_requests: 0,
          num_pending: 0,
          num_success: 0,
          num_error: 0,
        },
      },
    });
    const r = await new GrokVideoBatchService().submitBatch('x', [
      {
        batchRequestId: 'g1',
        prompt: 'p',
        durationSeconds: 8,
        aspectRatio: '9:16',
        resolution: '480p',
      },
    ]);
    expect(r.error).toMatch(/принял 0 из 1/);
    expect(mockedAxios.post.mock.calls[2][0]).toBe(
      'https://api.x.ai/v1/batches/b1/cancel',
    );
  });

  it('число совпало — пачка считается поданной', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ status: 200, data: { id: 'b1' } })
      .mockResolvedValueOnce({ status: 200, data: {} });
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: {
        state: {
          num_requests: 1,
          num_pending: 1,
          num_success: 0,
          num_error: 0,
        },
      },
    });
    const r = await new GrokVideoBatchService().submitBatch('x', [
      {
        batchRequestId: 'g1',
        prompt: 'p',
        durationSeconds: 8,
        aspectRatio: '9:16',
        resolution: '480p',
      },
    ]);
    expect(r).toEqual({ xaiBatchId: 'b1' });
  });
});
