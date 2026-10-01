import {
  SonioxTtsService,
  sonioxTtsLanguage,
  sonioxVoicesFrom,
} from './soniox-tts.service';

function mockFetch(res: {
  status?: number;
  bytes?: Buffer;
  json?: unknown;
  text?: string;
}) {
  const fn = jest.fn(async () => {
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => {
        const b = res.bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      json: async () => res.json ?? {},
      text: async () => res.text ?? '',
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('sonioxTtsLanguage — язык обязателен в запросе', () => {
  it('явный язык берётся как есть, с обрезкой региона', () => {
    expect(sonioxTtsLanguage('uk-UA', 'text')).toBe('uk');
  });
  it('не задан — по буквам текста', () => {
    expect(sonioxTtsLanguage(null, 'Вітаємо з днем народження, їжачку!')).toBe(
      'uk',
    );
  });
  it('ничего не понятно — русский', () => {
    expect(sonioxTtsLanguage(null, '12345')).toBe('ru');
  });
});

describe('sonioxVoicesFrom', () => {
  const data = {
    models: [
      {
        id: 'tts-rt-v2',
        languages: [
          { code: 'ru', name: 'Russian' },
          { code: 'uk', name: 'Ukrainian' },
        ],
        voices: [
          { id: 'Maya', gender: 'female', description: 'warm' },
          { description: 'без id — выбросить' },
        ],
      },
    ],
  };
  it('голоса активной модели, без записей без id', () => {
    expect(sonioxVoicesFrom(data, 'uk').voices).toEqual([
      {
        voiceId: 'Maya',
        name: 'Maya (female)',
        previewUrl: null,
        accent: 'warm',
      },
    ]);
  });
  it('язык, которого модель не знает, — пустой список с пояснением, а не чужая просодия', () => {
    const r = sonioxVoicesFrom(data, 'ja');
    expect(r.voices).toEqual([]);
    expect(r.error).toContain('ja');
  });
  it('моделей нет — пояснение', () => {
    expect(sonioxVoicesFrom({ models: [] }).error).toBeDefined();
  });
});

describe('SonioxTtsService.synthesize', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SONIOX_API_KEY = 'sk';
    delete process.env.SONIOX_TTS_VOICE;
  });
  afterAll(() => {
    process.env = saved;
  });

  it('нет ключа — пропуск, а не сбой; запроса нет', async () => {
    delete process.env.SONIOX_API_KEY;
    const fn = mockFetch({});
    const svc = new SonioxTtsService();
    expect(svc.configured()).toBe(false);
    const r = await svc.synthesize({ text: 'привет' });
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('тело запроса: модель, язык, голос по умолчанию, mp3; ответ — сырые байты', async () => {
    const fn = mockFetch({ bytes: Buffer.from('ID3fake') });
    const r = await new SonioxTtsService().synthesize({
      text: 'Вітаємо',
      language: 'uk',
    });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tts-rt.soniox.com/tts');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'tts-rt-v2',
      language: 'uk',
      voice: 'Maya',
      audio_format: 'mp3',
      text: 'Вітаємо',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk',
    );
    expect(r).toMatchObject({
      ok: true,
      mimeType: 'audio/mpeg',
      characters: 7,
      voiceId: 'Maya',
    });
  });

  it('голос бренда важнее голоса по умолчанию, тот — важнее Maya', async () => {
    process.env.SONIOX_TTS_VOICE = 'Adrian';
    const fn = mockFetch({ bytes: Buffer.from('x') });
    await new SonioxTtsService().synthesize({ text: 'a', voiceId: 'Brand' });
    await new SonioxTtsService().synthesize({ text: 'a' });
    const voices = fn.mock.calls.map(
      (c) =>
        JSON.parse(String((c as unknown as [string, RequestInit])[1].body))
          .voice,
    );
    expect(voices).toEqual(['Brand', 'Adrian']);
  });

  it('текст длиннее потолка — обрезается до 5000, в счёт идут отправленные символы', async () => {
    const fn = mockFetch({ bytes: Buffer.from('x') });
    const r = await new SonioxTtsService().synthesize({
      text: 'а'.repeat(6000),
    });
    const body = JSON.parse(
      String((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.text).toHaveLength(5000);
    expect(r).toMatchObject({ ok: true, characters: 5000 });
  });

  it('отказ провайдера — сбой с причиной, не пропуск', async () => {
    mockFetch({ status: 402, text: 'budget exhausted' });
    const r = await new SonioxTtsService().synthesize({ text: 'a' });
    expect(r).toMatchObject({ ok: false, skipped: false });
    expect((r as { reason: string }).reason).toContain('402');
  });

  it('пустой ответ — сбой', async () => {
    mockFetch({ bytes: Buffer.alloc(0) });
    expect(
      await new SonioxTtsService().synthesize({ text: 'a' }),
    ).toMatchObject({
      ok: false,
      skipped: false,
    });
  });
});

describe('SonioxTtsService.voices — справочник на API-хосте (01.10.2026)', () => {
  const prev = process.env.SONIOX_API_KEY;
  afterEach(() => {
    process.env.SONIOX_API_KEY = prev;
  });
  it('GET https://api.soniox.com/v1/tts-models с ключом', async () => {
    process.env.SONIOX_API_KEY = 'k';
    const fn = mockFetch({
      json: {
        models: [
          {
            id: 'tts-rt-v2',
            languages: [{ code: 'ru' }],
            voices: [{ id: 'Maya' }],
          },
        ],
      },
    });
    const out = await new SonioxTtsService().voices('ru');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.soniox.com/v1/tts-models');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer k',
    );
    expect(out.error).toBeUndefined();
    expect(out.voices).toHaveLength(1);
  });
});
