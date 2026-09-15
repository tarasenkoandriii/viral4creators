/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { ResembleService } from './resemble.service';

const KEYS = ['RESEMBLE_API_KEY', 'RESEMBLE_VOICE_ID'] as const;

function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return new ResembleService();
}

function mockFetch(impl: jest.Mock) {
  (global as any).fetch = impl;
  return impl;
}

describe('ResembleService (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md)', () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it('providerKey — "resemble"', () => {
    expect(new ResembleService().providerKey).toBe('resemble');
  });

  it('без ключа — пропуск, а не ошибка, и без сетевого вызова', async () => {
    const fetchMock = mockFetch(jest.fn());
    const svc = withEnv({});
    expect(svc.configured()).toBe(false);
    const r = await svc.synthesize({ text: 'привіт' });
    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: expect.stringContaining('RESEMBLE_API_KEY'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пустой текст — тоже пропуск', async () => {
    const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
    const r = await svc.synthesize({ text: '   ' });
    expect(r).toMatchObject({ ok: false, skipped: true });
  });

  it('нет голоса ни от бренда, ни от окружения — пропуск, а не выдуманный ID', async () => {
    // В отличие от ElevenLabs, у Resemble нет универсального голоса
    // по умолчанию — придумывать ID было бы хуже честного пропуска.
    const fetchMock = mockFetch(jest.fn());
    const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
    const r = await svc.synthesize({ text: 'x' });
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect((r as { reason: string }).reason).toContain('голос');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('успех декодирует base64-аудио и не передаёт project_uuid', async () => {
    const fetchMock = mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          audio_content: Buffer.from([1, 2, 3]).toString('base64'),
        }),
      }),
    );
    const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
    const r = await svc.synthesize({
      text: 'Привіт, світ',
      voiceId: 'brand-voice',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toEqual(Buffer.from([1, 2, 3]));
    expect(r.mimeType).toBe('audio/mpeg');
    expect(r.characters).toBe('Привіт, світ'.length);
    expect(r.voiceId).toBe('brand-voice');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://f.cluster.resemble.ai/synthesize');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      voice_uuid: 'brand-voice',
      data: 'Привіт, світ',
    });
    expect(body).not.toHaveProperty('project_uuid');
  });

  it('голос из RESEMBLE_VOICE_ID используется, когда бренд не задал свой', async () => {
    const fetchMock = mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          audio_content: Buffer.from([1]).toString('base64'),
        }),
      }),
    );
    const svc = withEnv({
      RESEMBLE_API_KEY: 'k',
      RESEMBLE_VOICE_ID: 'env-voice',
    });
    const r = await svc.synthesize({ text: 'x' });
    expect(r.ok && r.voiceId).toBe('env-voice');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).voice_uuid).toBe(
      'env-voice',
    );
  });

  it('HTTP-ошибка — сбой, а не пропуск', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    );
    const svc = withEnv({ RESEMBLE_API_KEY: 'bad', RESEMBLE_VOICE_ID: 'v' });
    const r = await svc.synthesize({ text: 'x' });
    expect(r).toMatchObject({ ok: false, skipped: false });
    expect((r as { reason: string }).reason).toContain('401');
  });

  it('success: false в теле ответа — тоже сбой', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false }),
      }),
    );
    const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
    const r = await svc.synthesize({ text: 'x' });
    expect(r).toMatchObject({ ok: false, skipped: false });
  });

  it('не-JSON ответ — сбой, а не падение процесса', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
    const r = await svc.synthesize({ text: 'x' });
    expect(r).toMatchObject({ ok: false, skipped: false });
  });

  it('сетевой сбой не бросает исключение', async () => {
    mockFetch(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
    await expect(svc.synthesize({ text: 'x' })).resolves.toMatchObject({
      ok: false,
      skipped: false,
    });
  });

  it('пустой audio_content — сбой', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, audio_content: '' }),
      }),
    );
    const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
    const r = await svc.synthesize({ text: 'x' });
    expect(r).toMatchObject({ ok: false, skipped: false });
  });

  it('слишком длинный текст режется до 3000 символов, а не роняет запрос', async () => {
    const fetchMock = mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          audio_content: Buffer.from([1]).toString('base64'),
        }),
      }),
    );
    const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
    const r = await svc.synthesize({ text: 'а'.repeat(5000) });
    expect(r.ok && r.characters).toBe(3000);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).data).toHaveLength(3000);
  });

  describe('тайминг: audio_timestamps в том же ответе (не отдельный вызов)', () => {
    it('timestamps: true разбирает graph_chars/graph_times в alignment', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            audio_content: Buffer.from([1, 2, 3]).toString('base64'),
            audio_timestamps: {
              graph_chars: ['п', 'р', 'и'],
              graph_times: [
                [0, 0.1],
                [0.1, 0.2],
                [0.2, 0.3],
              ],
            },
          }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
      const r = await svc.synthesize({ text: 'при', timestamps: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.alignment).toEqual({
        characters: ['п', 'р', 'и'],
        starts: [0, 0.1, 0.2],
        ends: [0.1, 0.2, 0.3],
      });
    });

    it('без timestamps: true — alignment не строится, даже если провайдер прислал тайминг', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            audio_content: Buffer.from([1]).toString('base64'),
            audio_timestamps: { graph_chars: ['x'], graph_times: [[0, 1]] },
          }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
      const r = await svc.synthesize({ text: 'x' });
      expect(r.ok && r.alignment).toBeUndefined();
    });

    it('несовпадение длины graph_chars/graph_times — синтез успешен, alignment пуст', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            audio_content: Buffer.from([1]).toString('base64'),
            audio_timestamps: {
              graph_chars: ['a', 'b'],
              graph_times: [[0, 1]],
            },
          }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
      const r = await svc.synthesize({ text: 'x', timestamps: true });
      expect(r.ok).toBe(true);
      expect(r.ok && r.alignment).toBeUndefined();
    });

    it('элемент graph_times не пара из двух чисел — синтез успешен, alignment пуст', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            audio_content: Buffer.from([1]).toString('base64'),
            audio_timestamps: { graph_chars: ['a'], graph_times: [[0]] },
          }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
      const r = await svc.synthesize({ text: 'x', timestamps: true });
      expect(r.ok).toBe(true);
      expect(r.ok && r.alignment).toBeUndefined();
    });

    it('отсутствие audio_timestamps в ответе не роняет успешный синтез', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            audio_content: Buffer.from([1]).toString('base64'),
          }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k', RESEMBLE_VOICE_ID: 'v' });
      const r = await svc.synthesize({ text: 'x', timestamps: true });
      expect(r.ok).toBe(true);
      expect(r.ok && r.alignment).toBeUndefined();
    });
  });

  describe('каталог голосов — GET на другом хосте, чем синтез', () => {
    it('без ключа — пустой список с причиной', async () => {
      const svc = withEnv({});
      const r = await svc.voices();
      expect(r).toEqual({
        voices: [],
        error: expect.stringContaining('RESEMBLE_API_KEY'),
      });
    });

    it('пустой каталог объясняет себя причиной', async () => {
      mockFetch(
        jest
          .fn()
          .mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.voices();
      expect(r.voices).toEqual([]);
      expect(r.error).toContain('0 голосов');
    });

    it('каталог отдаёт голоса без дублей, читает и items, и voices', async () => {
      const fetchMock = mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            items: [
              { uuid: 'a', name: 'Аня', language: 'uk' },
              { uuid: 'a', name: 'Аня (дубль)' },
              { id: 'b', name: 'Богдан' },
            ],
          }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.voices();
      expect(r.voices.map((v) => v.voiceId)).toEqual(['a', 'b']);
      expect(r.voices[0]).toMatchObject({
        name: 'Аня',
        accent: 'uk',
        previewUrl: null,
      });
      // `page` обязателен у Resemble (без него 400, 15.09.2026).
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://app.resemble.ai/api/v2/voices?page=1&page_size=1000',
      );
    });

    it('HTTP-ошибка при запросе каталога — пустой список с причиной, не падение', async () => {
      mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 500 }));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.voices();
      expect(r.voices).toEqual([]);
      expect(r.error).toContain('500');
    });

    it('сетевой сбой при запросе каталога не бросает исключение', async () => {
      mockFetch(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(svc.voices()).resolves.toMatchObject({ voices: [] });
    });
  });

  // Этап 73 (TODO п.32) — клонирование, отдельные методы от TtsProvider.
  describe('cloneVoice — POST /api/v2/voices, ответ приходит сразу с uuid', () => {
    it('без ключа — отказ без сетевого вызова', async () => {
      const fetchMock = mockFetch(jest.fn());
      const svc = withEnv({});
      const r = await svc.cloneVoice('Мой голос', 'https://blob/x.mp3');
      expect(r).toEqual({
        ok: false,
        reason: expect.stringContaining('RESEMBLE_API_KEY'),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('успех читает uuid из тела ответа и передаёт callback_uri', async () => {
      const fetchMock = mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ uuid: 'voice-uuid-1', status: 'pending' }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.cloneVoice(
        'Мой голос',
        'https://blob/x.mp3',
        'https://app.example/voices/webhook?secret=s',
      );
      expect(r).toEqual({ ok: true, resembleVoiceId: 'voice-uuid-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://app.resemble.ai/api/v2/voices');
      const body = JSON.parse((init as { body: string }).body);
      expect(body).toEqual({
        name: 'Мой голос',
        dataset_url: 'https://blob/x.mp3',
        callback_uri: 'https://app.example/voices/webhook?secret=s',
      });
    });

    it('успех также читает uuid из-под ключа item (защитный разбор)', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ item: { id: 'voice-uuid-2' } }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.cloneVoice('Голос', 'https://blob/x.mp3');
      expect(r).toEqual({ ok: true, resembleVoiceId: 'voice-uuid-2' });
    });

    it('HTTP-ошибка — отказ с причиной, не падение', async () => {
      mockFetch(
        jest
          .fn()
          .mockResolvedValue({ ok: false, status: 402, text: async () => '' }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.cloneVoice('Голос', 'https://blob/x.mp3');
      expect(r).toEqual({ ok: false, reason: expect.stringContaining('402') });
    });

    it('нет uuid в ответе — явный отказ, не тихая ложь', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      const r = await svc.cloneVoice('Голос', 'https://blob/x.mp3');
      expect(r).toEqual({ ok: false, reason: expect.stringContaining('uuid') });
    });

    it('сетевой сбой не бросает исключение', async () => {
      mockFetch(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(
        svc.cloneVoice('Голос', 'https://blob/x.mp3'),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  describe('getVoiceStatus — poll-фоллбек готовности (§5.4)', () => {
    it('без ключа — undefined, без сетевого вызова', async () => {
      const fetchMock = mockFetch(jest.fn());
      const svc = withEnv({});
      await expect(svc.getVoiceStatus('u1')).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('читает status из ответа', async () => {
      const fetchMock = mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: 'finished' }),
        }),
      );
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(svc.getVoiceStatus('u1')).resolves.toEqual({
        status: 'finished',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://app.resemble.ai/api/v2/voices/u1',
      );
    });

    it('HTTP-ошибка или нештатная форма ответа — undefined, не падение', async () => {
      mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 404 }));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(svc.getVoiceStatus('u1')).resolves.toBeUndefined();
    });

    it('сетевой сбой — undefined, не исключение', async () => {
      mockFetch(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(svc.getVoiceStatus('u1')).resolves.toBeUndefined();
    });
  });

  describe('deleteVoice — лучшее старание, никогда не бросает', () => {
    it('без ключа — тихо ничего не делает', async () => {
      const fetchMock = mockFetch(jest.fn());
      const svc = withEnv({});
      await expect(svc.deleteVoice('u1')).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('успех шлёт DELETE на нужный URL', async () => {
      const fetchMock = mockFetch(jest.fn().mockResolvedValue({ ok: true }));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await svc.deleteVoice('u1');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://app.resemble.ai/api/v2/voices/u1',
      );
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
    });

    it('HTTP-ошибка не бросает исключение', async () => {
      mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 500 }));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(svc.deleteVoice('u1')).resolves.toBeUndefined();
    });

    it('сетевой сбой не бросает исключение', async () => {
      mockFetch(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
      const svc = withEnv({ RESEMBLE_API_KEY: 'k' });
      await expect(svc.deleteVoice('u1')).resolves.toBeUndefined();
    });
  });
});
