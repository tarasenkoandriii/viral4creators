import axios from 'axios';
import { GrokBatchService } from './grok-batch.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GrokBatchService', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    delete process.env.GROK_API_KEY;
  });

  const withKey = () => {
    process.env.GROK_API_KEY = 'test-key';
    return new GrokBatchService();
  };

  describe('без ключа', () => {
    it('submitBatch — понятная ошибка, ни одного HTTP-вызова', async () => {
      const r = await new GrokBatchService().submitBatch('test', [
        { batchRequestId: '1', model: 'grok-4-fast', messages: [] },
      ]);
      expect(r).toEqual({ error: 'GROK_API_KEY не задан' });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('getBatchStatus — null, без HTTP-вызова', async () => {
      expect(await new GrokBatchService().getBatchStatus('b1')).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('getBatchResults — пустой объект, без HTTP-вызова', async () => {
      expect(await new GrokBatchService().getBatchResults('b1')).toEqual({});
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('isConfigured — false', () => {
      expect(new GrokBatchService().isConfigured()).toBe(false);
    });
  });

  describe('submitBatch', () => {
    it('пустой список запросов — ошибка без HTTP-вызова', async () => {
      const r = await withKey().submitBatch('test', []);
      expect(r).toEqual({ error: 'пустой список запросов для пачки' });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('счастливый путь: создаёт пачку, затем добавляет запросы в правильном формате xAI', async () => {
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { id: 'batch_123' } })
        .mockResolvedValueOnce({ status: 200, data: { added: 1 } });

      const r = await withKey().submitBatch('перевод статьи X', [
        {
          batchRequestId: 'translation-1',
          model: 'grok-4-fast',
          messages: [{ role: 'user', content: 'Translate into German' }],
          responseFormat: { type: 'json_object' },
        },
      ]);

      expect(r).toEqual({ xaiBatchId: 'batch_123' });
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      const [createUrl, createBody] = mockedAxios.post.mock.calls[0];
      expect(createUrl).toBe('https://api.x.ai/v1/batches');
      expect(createBody).toEqual({ name: 'перевод статьи X' });

      const [addUrl, addBody] = mockedAxios.post.mock.calls[1];
      expect(addUrl).toBe('https://api.x.ai/v1/batches/batch_123/requests');
      expect(addBody).toEqual({
        batch_requests: [
          {
            batch_request_id: 'translation-1',
            batch_request: {
              chat_get_completion: {
                model: 'grok-4-fast',
                response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: 'Translate into German' }],
              },
            },
          },
        ],
      });
    });

    it('принимает и "batch_id" вместо "id" в ответе создания пачки', async () => {
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { batch_id: 'b2' } })
        .mockResolvedValueOnce({ status: 200, data: {} });
      const r = await withKey().submitBatch('t', [
        { batchRequestId: '1', model: 'grok-4-fast', messages: [] },
      ]);
      expect(r).toEqual({ xaiBatchId: 'b2' });
    });

    it('HTTP-ошибка при создании пачки — понятный error, вторым запросом не идёт', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        status: 401,
        data: { error: 'invalid api key' },
      });
      const r = await withKey().submitBatch('t', [
        { batchRequestId: '1', model: 'grok-4-fast', messages: [] },
      ]);
      expect(r).toEqual({
        error: expect.stringContaining('статус 401'),
      });
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('ответ без id и без batch_id — понятная ошибка', async () => {
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: {} });
      const r = await withKey().submitBatch('t', [
        { batchRequestId: '1', model: 'grok-4-fast', messages: [] },
      ]);
      expect(r).toEqual({
        error: expect.stringContaining('не содержит ни "id", ни "batch_id"'),
      });
    });

    it('HTTP-ошибка при добавлении запросов — понятный error', async () => {
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { id: 'b3' } })
        .mockResolvedValueOnce({ status: 500, data: 'oops' });
      const r = await withKey().submitBatch('t', [
        { batchRequestId: '1', model: 'grok-4-fast', messages: [] },
      ]);
      expect(r).toEqual({ error: expect.stringContaining('статус 500') });
    });

    it('сетевой сбой — error, не бросает исключение', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      const r = await withKey().submitBatch('t', [
        { batchRequestId: '1', model: 'grok-4-fast', messages: [] },
      ]);
      expect(r).toEqual({ error: 'ETIMEDOUT' });
    });
  });

  describe('getBatchStatus', () => {
    it('готовность определяется через num_pending, а не через сравнение num_success с num_requests', async () => {
      // Часть запросов упала с ошибкой (num_error: 2) — num_success (8)
      // никогда не сравняется с num_requests (10), но батч уже готов,
      // потому что num_pending === 0. Это ровно та ловушка, которую
      // комментарий в grok-batch.service.ts предупреждает не повторять.
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          state: {
            num_requests: 10,
            num_success: 8,
            num_pending: 0,
            num_error: 2,
          },
        },
      });
      const status = await withKey().getBatchStatus('b1');
      expect(status).toEqual({
        totalCount: 10,
        completedCount: 8,
        pendingCount: 0,
        errorCount: 2,
      });
    });

    it('нет поля state вообще — не бросает, но и готовности не выдумывает', async () => {
      // Прежняя редакция этого теста требовала здесь `pendingCount: 0`
      // — и тем закрепляла находку аудита 24.09.2026: ноль означает «в
      // очереди никого, пачка готова», по нему вызывающий идёт забирать
      // результаты, получает пустой список и помечает ВСЮ оплаченную
      // пачку провалившейся. Одна неожиданная форма ответа xAI (батч в
      // queued/validating/expired, иное именование полей) — и пачка
      // потеряна целиком, с записью расхода на каждый элемент.
      //
      // Исходное намерение теста («не бросает») сохранено: метод
      // по-прежнему возвращает объект, а не исключение. Изменилось одно
      // — «xAI не сказал» перестало выдавать себя за «готово».
      mockedAxios.get.mockResolvedValueOnce({ status: 200, data: {} });
      expect(await withKey().getBatchStatus('b1')).toEqual({
        totalCount: 0,
        completedCount: 0,
        pendingCount: null,
        errorCount: 0,
      });
    });

    it('num_pending не число — тоже «не сказал», а не ноль', async () => {
      // Строка, null, отсутствующий ключ — всё это одно и то же: поля
      // нет. Проверка на `typeof === 'number'`, а не на truthiness:
      // иначе настоящий ноль («готова») превратился бы в `null`.
      for (const num_pending of [undefined, null, '0', {}]) {
        mockedAxios.get.mockResolvedValueOnce({
          status: 200,
          data: { state: { num_requests: 3, num_pending } },
        });
        const status = await withKey().getBatchStatus('b1');
        expect(status?.pendingCount).toBeNull();
      }
      // А ноль остаётся нулём — иначе готовая пачка не забиралась бы
      // никогда.
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { state: { num_requests: 3, num_pending: 0 } },
      });
      expect((await withKey().getBatchStatus('b1'))?.pendingCount).toBe(0);
    });

    it('HTTP-ошибка — null, не бросает', async () => {
      mockedAxios.get.mockResolvedValueOnce({ status: 404, data: {} });
      expect(await withKey().getBatchStatus('b1')).toBeNull();
    });

    it('сетевой сбой — null, не бросает', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('ECONNRESET'));
      expect(await withKey().getBatchStatus('b1')).toBeNull();
    });
  });

  describe('getBatchResults', () => {
    it('разбирает вложенный chat_get_completion.choices[0].message.content, ключ — batch_request_id', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          results: [
            {
              batch_request_id: 'translation-1',
              batch_result: {
                response: {
                  chat_get_completion: {
                    choices: [
                      {
                        message: {
                          content: '{"title":"Titel","bodyHtml":"<p>x</p>"}',
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      });
      const results = await withKey().getBatchResults('b1');
      expect(results).toEqual({
        'translation-1': '{"title":"Titel","bodyHtml":"<p>x</p>"}',
      });
    });

    it('элемент без batch_request_id/custom_id/id — пропускается', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { results: [{ batch_result: {} }] },
      });
      expect(await withKey().getBatchResults('b1')).toEqual({});
    });

    it('постранично идёт по pagination_token и останавливается, когда его больше нет', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              {
                batch_request_id: '1',
                batch_result: {
                  response: {
                    chat_get_completion: {
                      choices: [{ message: { content: 'first' } }],
                    },
                  },
                },
              },
            ],
            pagination_token: 'page2',
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              {
                batch_request_id: '2',
                batch_result: {
                  response: {
                    chat_get_completion: {
                      choices: [{ message: { content: 'second' } }],
                    },
                  },
                },
              },
            ],
          },
        });

      const results = await withKey().getBatchResults('b1');
      expect(results).toEqual({ '1': 'first', '2': 'second' });
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      const secondCallParams = mockedAxios.get.mock.calls[1][1]?.params;
      expect(secondCallParams).toEqual({
        limit: 100,
        pagination_token: 'page2',
      });
    });

    it('HTTP-ошибка на странице — останавливается с тем, что уже собрано', async () => {
      mockedAxios.get.mockResolvedValueOnce({ status: 500, data: {} });
      expect(await withKey().getBatchResults('b1')).toEqual({});
    });

    it('сетевой сбой — пустой объект, не бросает', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      expect(await withKey().getBatchResults('b1')).toEqual({});
    });
  });
});
