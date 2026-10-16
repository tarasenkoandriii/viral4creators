/**
 * HedraClientService — по образцу ffmpeg-api.service.spec.ts (тот же
 * класс внешнего API: submit/status, повтор на 429/5xx, отказ на 4xx).
 * Отличия проверяются отдельно: ответ НЕ завёрнут в `data`, создание
 * задачи ждёт 202 (не только 200), словарь статусов Hedra свой.
 */

import { HedraClientService } from './hedra-client.service';

const SUBMIT_OPTS = {
  prompt: 'персонаж держит товар и говорит о нём',
  startImage: 'https://blob.test/brand/character.png',
  audioUrl: 'https://blob.test/sessions/s1/avatar-voiceover.mp3',
  aspectRatio: '9:16',
  resolution: '720p' as const,
};

const ok = (status: number, data: unknown) =>
  ({
    ok: true,
    status,
    text: async () => JSON.stringify(data),
  }) as unknown as Response;

const fail = (status: number, body = 'ой') =>
  ({
    ok: false,
    status,
    text: async () => body,
  }) as unknown as Response;

const envBefore = process.env.HEDRA_API_KEY;
const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.HEDRA_API_KEY = 'ключ';
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
  if (envBefore === undefined) delete process.env.HEDRA_API_KEY;
  else process.env.HEDRA_API_KEY = envBefore;
});

const headersOf = (call: number) =>
  (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<
    string,
    string
  >;

describe('HedraClientService.configured', () => {
  it('без HEDRA_API_KEY — не настроен', () => {
    delete process.env.HEDRA_API_KEY;
    expect(new HedraClientService().configured()).toBe(false);
  });

  it('пустой ключ считается незаданным', () => {
    process.env.HEDRA_API_KEY = '   ';
    expect(new HedraClientService().configured()).toBe(false);
  });

  it('заданный ключ — настроен', () => {
    expect(new HedraClientService().configured()).toBe(true);
  });
});

describe('HedraClientService.submit', () => {
  beforeEach(() => {
    jest
      .spyOn(HedraClientService.prototype, 'uploadMedia')
      .mockImplementation(
        async (_url, kind) => `https://uploads.hedra.com/${kind}`,
      );
  });
  afterEach(() => jest.restoreAllMocks());
  it('без ключа запрос не уходит вовсе', async () => {
    delete process.env.HEDRA_API_KEY;
    const svc = new HedraClientService();
    await expect(svc.submit(SUBMIT_OPTS)).rejects.toThrow(/HEDRA_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('тело, адрес и заголовки — те, которых ждёт Character-3 (§3.2 ТЗ)', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(ok(202, { job_id: 'job1' }));

    await svc.submit(SUBMIT_OPTS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.hedra.com/v3/models/hedra-character-3');
    expect(init.method).toBe('POST');
    expect(headersOf(0).Authorization).toBe('Key ключ');
    expect(JSON.parse(init.body as string)).toEqual({
      input: {
        prompt: SUBMIT_OPTS.prompt,
        start_image: { source: 'url', url: 'https://uploads.hedra.com/image' },
        audio: { source: 'url', url: 'https://uploads.hedra.com/audio' },
        aspect_ratio: SUBMIT_OPTS.aspectRatio,
        resolution: SUBMIT_OPTS.resolution,
      },
    });
  });

  it('allows an explicit Kling pro benchmark without changing the default', async () => {
    fetchMock.mockResolvedValue(ok(202, { job_id: 'kling1' }));
    await new HedraClientService().submit({
      ...SUBMIT_OPTS,
      model: 'kling-ai-avatar-v2',
      quality: 'pro',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.hedra.com/v3/models/kling-ai-avatar-v2',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input.quality).toBe(
      'pro',
    );
  });

  it('rejects unsupported model options before media upload or generation', async () => {
    await expect(
      new HedraClientService().submit({ ...SUBMIT_OPTS, quality: 'pro' }),
    ).rejects.toThrow(/Quality tier/);
    await expect(
      new HedraClientService().submit({
        ...SUBMIT_OPTS,
        model: 'kling-ai-avatar-v2',
        resolution: '1080p',
      }),
    ).rejects.toThrow(/720p/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(HedraClientService.prototype.uploadMedia).not.toHaveBeenCalled();
  });

  it('202 (не только 200) принимается как успех создания задачи', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(ok(202, { job_id: 'job1' }));
    await expect(svc.submit(SUBMIT_OPTS)).resolves.toEqual({ jobId: 'job1' });
  });

  it('id принимается в трёх написаниях', async () => {
    for (const [field, value] of [
      ['job_id', 'a'],
      ['jobId', 'b'],
      ['id', 'c'],
    ] as const) {
      const svc = new HedraClientService();
      fetchMock.mockResolvedValue(ok(202, { [field]: value }));
      await expect(svc.submit(SUBMIT_OPTS)).resolves.toEqual({ jobId: value });
    }
  });

  it('ответ без id задачи — внятная ошибка', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(ok(202, { status: 'queued' }));
    await expect(svc.submit(SUBMIT_OPTS)).rejects.toThrow(
      /не содержит id задачи/,
    );
  });

  it('4xx не повторяется', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(fail(400, 'bad request'));
    await expect(svc.submit(SUBMIT_OPTS)).rejects.toThrow(/hedra api 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429/5xx повторяются, попыток не больше трёх', async () => {
    const svc = new HedraClientService();
    fetchMock
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(ok(202, { job_id: 'job1' }));
    await expect(svc.submit(SUBMIT_OPTS)).resolves.toEqual({ jobId: 'job1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('HedraClientService.status', () => {
  it('IN_QUEUE/IN_PROGRESS — ещё идёт', async () => {
    const svc = new HedraClientService();
    for (const raw of ['IN_QUEUE', 'IN_PROGRESS']) {
      fetchMock.mockResolvedValue(ok(200, { status: raw }));
      await expect(svc.status('job1')).resolves.toMatchObject({
        status: 'pending',
      });
    }
  });

  it('незнакомый статус считается «ещё идёт», не провалом', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(ok(200, { status: 'SOMETHING_NEW' }));
    await expect(svc.status('job1')).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('COMPLETED с outputs — готово, url и длительность разобраны', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(
      ok(200, {
        status: 'COMPLETED',
        outputs: [
          {
            status: 'complete',
            url: 'https://hedra.test/out.mp4',
            duration_ms: 8000,
          },
        ],
        cost: 0.5,
        currency: 'USD',
      }),
    );
    const status = await svc.status('job1');
    expect(status).toEqual({
      status: 'completed',
      outputs: [{ url: 'https://hedra.test/out.mp4', durationMs: 8000 }],
      error: undefined,
      costMicroUsd: 500000,
    });
  });

  it('FAILED — провал с текстом причины', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(
      ok(200, { status: 'FAILED', error: 'model refused input' }),
    );
    await expect(svc.status('job1')).resolves.toMatchObject({
      status: 'failed',
      error: 'model refused input',
    });
  });

  it('COMPLETED без outputs — outputs undefined, не пустой массив', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(ok(200, { status: 'COMPLETED', outputs: [] }));
    await expect(svc.status('job1')).resolves.toMatchObject({
      outputs: undefined,
    });
  });

  it('id задачи экранируется в адресе', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue(ok(200, { status: 'IN_PROGRESS' }));
    await svc.status('job/1 2');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.hedra.com/v3/jobs/job%2F1%202',
    );
  });

  it('не-JSON в ответе — внятная ошибка', async () => {
    const svc = new HedraClientService();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>502</html>',
    } as unknown as Response);
    await expect(svc.status('job1')).rejects.toThrow(/вернул не-JSON/);
  });
});

it('reads the spendable API wallet from the official balance endpoint', async () => {
  fetchMock.mockResolvedValue(ok(200, { balance: 0 }));
  expect(await new HedraClientService().balanceUsd()).toBe(0);
  expect(fetchMock.mock.calls[0][0]).toBe('https://api.hedra.com/v3/balance');
  expect(headersOf(0).Authorization).toBe('Key ключ');
});
it('does not interpret a malformed balance response as available money', async () => {
  fetchMock.mockResolvedValue(ok(200, {}));
  await expect(new HedraClientService().balanceUsd()).rejects.toThrow(
    'balance response',
  );
});

describe('Hedra media transport', () => {
  it('uploads service media as multipart and returns the provider URL', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2]), {
          headers: { 'content-type': 'audio/wav' },
        }),
      )
      .mockResolvedValueOnce(
        ok(201, { url: 'https://uploads.hedra.com/portrait' }),
      );
    await expect(
      new HedraClientService().uploadMedia(
        'https://store.public.blob.vercel-storage.com/virtual-studio/studio/imports/voice.wav',
        'audio',
      ),
    ).resolves.toBe('https://uploads.hedra.com/portrait');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toEqual({ Authorization: 'Key ключ' });
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(((init.body as FormData).get('file') as File).name).toBe(
      'voice.wav',
    );
  });
  it('rejects external sources before fetching', async () => {
    await expect(
      new HedraClientService().uploadMedia(
        'https://example.com/photo.jpg',
        'image',
      ),
    ).rejects.toThrow(/service storage/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects the wrong media type before uploading', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('html', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      new HedraClientService().uploadMedia(
        'https://store.public.blob.vercel-storage.com/sessions/s1/photo.jpg',
        'image',
      ),
    ).rejects.toThrow(/media type/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
