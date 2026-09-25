/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import {
  ElevenLabsService,
  elevenLabsLanguageCode,
} from './elevenlabs.service';

const KEYS = ['VOICE_API_KEY', 'VOICE_ID', 'VOICE_MODEL'] as const;

function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return new ElevenLabsService();
}

function mockFetch(impl: jest.Mock) {
  (global as any).fetch = impl;
  return impl;
}

describe('ElevenLabsService (ТЗ §15.3)', () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it('без ключа — пропуск, а не ошибка, и без сетевого вызова', async () => {
    // Не настроенный TTS это состояние стенда: ролик у пользователя есть,
    // говорит в нём голос Veo, продукт работает как раньше.
    const fetchMock = mockFetch(jest.fn());
    const svc = withEnv({});
    expect(svc.configured()).toBe(false);
    const r = await svc.synthesize({ text: 'привет' });
    expect(r).toEqual({
      ok: false,
      skipped: true,
      reason: expect.stringContaining('VOICE_API_KEY'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пустой текст — тоже пропуск', async () => {
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    const r = await svc.synthesize({ text: '   ' });
    expect(r).toMatchObject({ ok: false, skipped: true });
  });

  it('успех отдаёт байты, голос, модель и число символов', async () => {
    const fetchMock = mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    const r = await svc.synthesize({ text: 'Привет, мир' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio.length).toBe(3);
    expect(r.characters).toBe('Привет, мир'.length);
    // Этап 138: длительность измеряется по байтам. Три байта — не mp3,
    // и это `null`, а не ноль: «не смогли измерить» и «нулевая длина» —
    // разные вещи (см. `common/mp3-duration.ts`).
    expect(r.durationSeconds).toBeNull();
    expect(r.model).toBe('eleven_multilingual_v2');
    expect(r.voiceId).toBe('EXAVITQu4vr4xnSDxMaL');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/text-to-speech/EXAVITQu4vr4xnSDxMaL');
    expect(init.headers['xi-api-key']).toBe('k');
    expect(JSON.parse(init.body)).toMatchObject({
      text: 'Привет, мир',
      model_id: 'eleven_multilingual_v2',
      output_format: 'mp3_44100_128',
    });
  });

  it('голос бренда и модель из настроек перекрывают умолчания', async () => {
    const fetchMock = mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k', VOICE_ID: 'env-voice' });
    const r = await svc.synthesize({ text: 'x', voiceId: 'brand-voice' });
    expect(r.ok && r.voiceId).toBe('brand-voice');
    expect(fetchMock.mock.calls[0][0]).toContain('/brand-voice');
  });

  it('ошибка провайдера — это сбой, а не пропуск', async () => {
    // Разница важна: пропуск интерфейс показывает спокойной пометкой,
    // сбой — причиной, с которой можно идти разбираться.
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'bad' });
    const r = await svc.synthesize({ text: 'x' });
    expect(r).toMatchObject({ ok: false, skipped: false });
    expect((r as { reason: string }).reason).toContain('401');
  });

  it('сетевой сбой не бросает исключение', async () => {
    // Единственный способ уронить генерацию из-за необязательного
    // улучшения — бросить отсюда.
    mockFetch(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    await expect(svc.synthesize({ text: 'x' })).resolves.toMatchObject({
      ok: false,
      skipped: false,
    });
  });

  it('пустой ответ провайдера считается сбоем', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    expect(await svc.synthesize({ text: 'x' })).toMatchObject({
      ok: false,
      skipped: false,
    });
  });

  it('слишком длинный текст режется, а не роняет запрос', async () => {
    const fetchMock = mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    const r = await svc.synthesize({ text: 'а'.repeat(9000) });
    expect(r.ok && r.characters).toBe(5000);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toHaveLength(5000);
  });

  describe('субтитры: /with-timestamps (этап 67)', () => {
    it('timestamps: true уходит на другой путь и разбирает alignment', async () => {
      const fetchMock = mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            audio_base64: Buffer.from([1, 2, 3]).toString('base64'),
            normalized_alignment: {
              characters: ['п', 'р', 'и'],
              character_start_times_seconds: [0, 0.1, 0.2],
              character_end_times_seconds: [0.1, 0.2, 0.3],
            },
          }),
        }),
      );
      const svc = withEnv({ VOICE_API_KEY: 'k' });
      const r = await svc.synthesize({ text: 'при', timestamps: true });

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.audio.length).toBe(3);
      expect(r.alignment).toEqual({
        characters: ['п', 'р', 'и'],
        starts: [0, 0.1, 0.2],
        ends: [0.1, 0.2, 0.3],
      });
      expect(fetchMock.mock.calls[0][0]).toContain('/with-timestamps');
    });

    it('обычный запрос (без timestamps) не трогает /with-timestamps и не даёт alignment', async () => {
      const fetchMock = mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        }),
      );
      const svc = withEnv({ VOICE_API_KEY: 'k' });
      const r = await svc.synthesize({ text: 'x' });
      expect(fetchMock.mock.calls[0][0]).not.toContain('with-timestamps');
      expect(r.ok && r.alignment).toBeUndefined();
    });

    it('не-JSON ответ на /with-timestamps — сбой, а не падение процесса', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => {
            throw new Error('not json');
          },
        }),
      );
      const svc = withEnv({ VOICE_API_KEY: 'k' });
      const r = await svc.synthesize({ text: 'x', timestamps: true });
      expect(r).toMatchObject({ ok: false, skipped: false });
    });

    it('ответ без audio_base64 — сбой с внятной причиной', async () => {
      mockFetch(
        jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );
      const svc = withEnv({ VOICE_API_KEY: 'k' });
      const r = await svc.synthesize({ text: 'x', timestamps: true });
      expect(r).toMatchObject({ ok: false, skipped: false });
      expect((r as { reason: string }).reason).toContain('audio_base64');
    });

    it('пустое выравнивание в ответе не роняет успешный синтез', async () => {
      // alignment необязателен — отсутствие normalized_alignment не должно
      // превращать успешный синтез в сбой, только оставлять субтитры без
      // реального тайминга (эвристика подхватит выше по стеку).
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            audio_base64: Buffer.from([9]).toString('base64'),
          }),
        }),
      );
      const svc = withEnv({ VOICE_API_KEY: 'k' });
      const r = await svc.synthesize({ text: 'x', timestamps: true });
      expect(r.ok).toBe(true);
      expect(r.ok && r.alignment).toBeUndefined();
    });
  });

  it('пустой каталог голосов объясняет себя причиной', async () => {
    // «Ничего не нашлось» без причины оператор прочитает как поломку.
    mockFetch(
      jest
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ voices: [] }) }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    const r = await svc.voices('ru');
    expect(r.voices).toEqual([]);
    expect(r.error).toContain('0 голосов');
  });

  it('каталог отдаёт голоса без дублей', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          voices: [
            { voice_id: 'a', name: 'Аня', preview_url: 'u1' },
            { voice_id: 'a', name: 'Аня (дубль)' },
            { voiceId: 'b', name: 'Богдан' },
          ],
        }),
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    const r = await svc.voices();
    expect(r.voices.map((v) => v.voiceId)).toEqual(['a', 'b']);
    expect(r.voices[0]).toMatchObject({ name: 'Аня', previewUrl: 'u1' });
  });
});

describe('elevenLabsLanguageCode', () => {
  it('нормализует код языка для моделей, которые его принимают', () => {
    expect(elevenLabsLanguageCode('uk-UA', 'eleven_v3')).toBe('uk');
    expect(elevenLabsLanguageCode('RU', 'eleven_flash_v2_5')).toBe('ru');
  });

  it('multilingual_v2 параметр игнорирует — не шлём', () => {
    expect(
      elevenLabsLanguageCode('uk', 'eleven_multilingual_v2'),
    ).toBeUndefined();
  });

  it('пустой или непонятный язык — не шлём', () => {
    expect(elevenLabsLanguageCode(null, 'eleven_v3')).toBeUndefined();
    expect(elevenLabsLanguageCode('Ukrainian', 'eleven_v3')).toBeUndefined();
  });
});

/**
 * Длительность синтезированной дорожки (этап 138, §5 ТЗ
 * TZ-Multilingual-YouTube.md).
 *
 * Провайдер её не отдаёт — она меряется по самим байтам. Проверяется
 * здесь, а не только в тесте разборщика, потому что смысл имеет ровно
 * связка: дорожка вернулась из синтеза уже со своей длиной, и звать
 * что-то отдельно вызывающему не нужно.
 */
describe('ElevenLabsService — длительность дорожки', () => {
  /** Кадр MPEG1 Layer III, стерео, 128 кбит/с, 44,1 кГц — 0,0261 с. */
  const frame = () =>
    Buffer.concat([
      Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      Buffer.alloc(Math.floor((144 * 128000) / 44100) - 4),
    ]);

  it('успех несёт измеренную длительность, а не оценку по символам', async () => {
    const mp3 = Buffer.concat(Array.from({ length: 80 }, frame));
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength),
      }),
    );
    const svc = withEnv({ VOICE_API_KEY: 'k' });
    const r = await svc.synthesize({ text: 'Привет' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 80 кадров × 1152 сэмпла / 44100 Гц ≈ 2,09 с. Оценка по символам
    // («Привет» — шесть знаков) дала бы 0,4 с: разница, из-за которой
    // проверка «дорожка примерно той же длины, что ролик» и заводится.
    expect(r.durationSeconds).toBeCloseTo((80 * 1152) / 44100, 1);
  });
});
