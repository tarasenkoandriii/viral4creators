import { FakeSoniox } from '../testing/fake-soniox.testing';
import { SiteSonioxTts, ttsLanguage, voicesFrom } from './soniox-tts.client';

describe('SiteSonioxTts (Э5)', () => {
  const make = (
    fake: FakeSoniox,
    env: NodeJS.ProcessEnv = { SONIOX_API_KEY: 'sx' },
  ) => {
    const t = new SiteSonioxTts();
    t.fetch = fake.fetch;
    t.env = env;
    return t;
  };

  it('синтез: модель, язык, голос по умолчанию (env → Maya), mp3; символы — после обрезки', async () => {
    const fake = new FakeSoniox();
    const r = await make(fake, {
      SONIOX_API_KEY: 'sx',
      ASSIST_TTS_VOICE: 'Adrian',
    }).synthesize({ text: '  Привіт  ', voice: null, lang: null });
    expect(r).toMatchObject({
      ok: true,
      mime: 'audio/mpeg',
      characters: 6,
      voice: 'Adrian',
      lang: 'uk',
    });
    expect(fake.calls[0]).toMatchObject({
      method: 'POST',
      path: 'tts:/tts',
      body: {
        model: 'tts-rt-v2',
        language: 'uk',
        voice: 'Adrian',
        audio_format: 'mp3',
        text: 'Привіт',
      },
    });
    expect(
      make(fake, {
        SONIOX_API_KEY: 'sx',
        ASSIST_TTS_VOICE: 'x"y',
      }).defaultVoice(),
    ).toBe('Maya');
  });

  it('без ключа / пустой текст / отказ провайдера — ok:false без исключения', async () => {
    const fake = new FakeSoniox();
    expect(
      await make(fake, {}).synthesize({ text: 'a', voice: null, lang: 'uk' }),
    ).toEqual({ ok: false, reason: 'no_key' });
    expect(
      await make(fake).synthesize({ text: '  ', voice: null, lang: 'uk' }),
    ).toEqual({ ok: false, reason: 'empty' });
    fake.tts = 'fail';
    expect(
      await make(fake).synthesize({ text: 'a', voice: null, lang: 'uk' }),
    ).toEqual({ ok: false, reason: 'error' });
  });

  it('язык: явный → по буквам → украинский', () => {
    expect(ttsLanguage('ru-RU', 'Привіт')).toBe('ru');
    expect(ttsLanguage(null, 'Привіт, як справи?')).toBe('uk');
    expect(ttsLanguage(null, 'Привет, это ёлка')).toBe('ru');
    expect(ttsLanguage(null, 'Hello there')).toBe('en');
    expect(ttsLanguage(null, '123')).toBe('uk');
  });

  it('справочник голосов: модель синтеза, имена — только безопасные, кэш на час', async () => {
    expect(
      voicesFrom({
        models: [
          {
            id: 'tts-rt-v2',
            voices: [{ id: 'Maya', gender: 'female' }, { id: '<b>x' }, {}],
          },
        ],
      }),
    ).toEqual([{ id: 'Maya', gender: 'female', description: null }]);
    const fake = new FakeSoniox();
    const t = make(fake);
    expect((await t.voices(1_000)).map((v) => v.id)).toEqual([
      'Maya',
      'Adrian',
    ]);
    await t.voices(2_000);
    expect(fake.count('GET', '/tts-models')).toBe(1);
    await t.voices(1_000 + 3_600_001);
    expect(fake.count('GET', '/tts-models')).toBe(2);
  });
});

describe('Soniox delayed response deadline', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  function client(delay: number) {
    jest.useFakeTimers();
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        ms,
      );
      return controller.signal;
    });
    const t = new SiteSonioxTts();
    t.env = { SONIOX_API_KEY: 'test' };
    t.fetch = jest.fn(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(new Uint8Array([1, 2, 3]))),
            delay,
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    return t;
  }
  it('keeps a response arriving after the previous 20-second deadline', async () => {
    const t = client(25_000);
    const pending = t.synthesize({
      text: 'Long response',
      voice: null,
      lang: 'en',
    });
    await jest.advanceTimersByTimeAsync(25_000);
    expect(await pending).toMatchObject({
      ok: true,
      audio: Buffer.from([1, 2, 3]),
    });
  });
  it('still aborts a stalled provider rather than waiting indefinitely', async () => {
    const t = client(120_000);
    const pending = t.synthesize({
      text: 'Long response',
      voice: null,
      lang: 'en',
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual({ ok: false, reason: 'error' });
  });
});
