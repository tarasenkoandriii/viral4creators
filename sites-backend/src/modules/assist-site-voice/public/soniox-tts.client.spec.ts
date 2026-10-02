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
