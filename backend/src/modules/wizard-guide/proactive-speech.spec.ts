/**
 * Проактивная речь (K4) — чистые правила: шаблоны на пяти языках,
 * «коротко» в траурном регистре, ключ кеша без личных данных.
 */
import { SUPPORTED_LOCALES } from '../../common/locale';
import { textFitsRegister } from '../../common/greeting-policy';
import { SOMBER_SPEECH_MAX, speechForRegister } from './hint-audio';
import {
  SPEECH_USER_TEXT_MAX,
  speakUserText,
  VOICE_QUESTION_TOPICS,
  VOICE_REFUSAL_CODES,
  chargeSpeech,
  consentSummarySpeech,
  lockedSpeech,
  quotaSpeech,
  speechCacheKey,
  toneRefusalSpeech,
  videoReadySpeech,
} from './proactive-speech';

describe('speechForRegister — «коротко» в траурном (§4А.4)', () => {
  const long =
    'Первая фраза спокойная и короткая. Вторая фраза тоже спокойная, но добавляет подробности про шаг. ' +
    'Третья фраза уже лишняя для траурного регистра и выводит реплику далеко за предел длины.';

  it('регистр неизвестен или праздничный — целиком', () => {
    expect(speechForRegister(null, long)).toBe(long);
    expect(speechForRegister('CELEBRATORY', long)).toBe(long);
    expect(speechForRegister('SOLEMN', long)).toBe(long);
  });

  it('траурный и деликатный — целые первые фразы в пределе', () => {
    for (const r of ['MOURNING', 'SENSITIVE'] as const) {
      const out = speechForRegister(r, long)!;
      expect(out.length).toBeLessThanOrEqual(SOMBER_SPEECH_MAX);
      expect(long.startsWith(out)).toBe(true);
      expect(out).toMatch(/\.$/);
      expect(out).toContain('Вторая фраза');
      expect(out).not.toContain('Третья');
    }
  });

  it('короткая реплика в траурном — целиком', () => {
    expect(speechForRegister('MOURNING', 'Спокойно заполните бриф.')).toBe(
      'Спокойно заполните бриф.',
    );
  });

  it('первая фраза длиннее предела — не звучит (обрывок хуже тишины)', () => {
    const one = `${'слово '.repeat(40).trim()}.`;
    expect(one.length).toBeGreaterThan(SOMBER_SPEECH_MAX);
    expect(speechForRegister('MOURNING', one)).toBeNull();
    expect(speechForRegister('CELEBRATORY', one)).toBe(one);
  });

  it('праздничная примета в траурном — не звучит, в праздничном — звучит', () => {
    expect(speechForRegister('MOURNING', 'Отлично!')).toBeNull();
    expect(speechForRegister('CELEBRATORY', 'Отлично!')).toBe('Отлично!');
  });

  it('пустое — null', () => {
    expect(speechForRegister(null, '   ')).toBeNull();
  });
});

describe('шаблоны речи — пять языков, спокойно', () => {
  const allTexts = (locale: (typeof SUPPORTED_LOCALES)[number]) => [
    videoReadySpeech(locale),
    toneRefusalSpeech(locale, ['RESPECTFUL', 'SUPPORTIVE']),
    toneRefusalSpeech(locale, null),
    quotaSpeech(locale),
    lockedSpeech(locale),
    consentSummarySpeech(locale, {
      recipient: 'Анна',
      occasion: 'CONDOLENCE',
      customOccasion: null,
      resolution: '720p',
      presenter: 'grok',
      charge: { kind: 'included' },
    })!,
  ];

  it('каждая фраза есть и годится траурному регистру (§3.7)', () => {
    for (const l of SUPPORTED_LOCALES) {
      for (const text of allTexts(l)) {
        expect(text).toBeTruthy();
        expect(textFitsRegister('MOURNING', text)).toBe(true);
      }
    }
  });

  it('короткие отказы укладываются в траурный предел целиком', () => {
    for (const l of SUPPORTED_LOCALES) {
      for (const text of [videoReadySpeech(l), lockedSpeech(l)]) {
        expect(speechForRegister('MOURNING', text)).toBe(text);
      }
    }
  });

  it('отказ по тону называет доступные тоны подписями экрана', () => {
    expect(toneRefusalSpeech('ru', ['RESPECTFUL', 'SUPPORTIVE'])).toBe(
      'Этот тон не подходит к поводу. Подойдут: «Уважительный, сдержанный», «Поддерживающий».',
    );
    // Нет брифа — без перечня: варианты наугад не называют.
    expect(toneRefusalSpeech('ru', null)).not.toContain('«');
    expect(toneRefusalSpeech('ru', ['UNKNOWN'])).not.toContain('«');
  });
});

describe('сводка перед согласием (§4А.7.4)', () => {
  const base = {
    recipient: 'Мама',
    occasion: 'BIRTHDAY',
    customOccasion: null,
    resolution: '1080p',
    presenter: 'hedra',
  };

  it('кому, повод, качество и цена — и фраза запуска', () => {
    expect(
      consentSummarySpeech('ru', {
        ...base,
        charge: { kind: 'credit', balance: 3 },
      }),
    ).toBe(
      'Проверьте: Мама, День рождения, 1080p, Говорящий аватар (Hedra). Спишется: одна генерация из 3 доступных. Чтобы запустить, скажите «генерируй» ещё раз.',
    );
  });

  it('без цены сводки нет — согласие без цены не согласие', () => {
    for (const reason of ['no-data', 'locked'] as const) {
      expect(
        consentSummarySpeech('ru', {
          ...base,
          charge: { kind: 'unknown', reason },
        }),
      ).toBeNull();
    }
    expect(chargeSpeech('ru', { kind: 'unknown', reason: 'locked' })).toBe(
      null,
    );
  });

  it('свой повод — его словами; без получателя сводки нет', () => {
    expect(
      consentSummarySpeech('ru', {
        ...base,
        occasion: 'OTHER',
        customOccasion: 'выход на пенсию папы',
        charge: { kind: 'included' },
      }),
    ).toContain('выход на пенсию папы');
    expect(
      consentSummarySpeech('ru', {
        ...base,
        recipient: ' ',
        charge: { kind: 'included' },
      }),
    ).toBeNull();
  });
});

describe('ключ речи в кеше', () => {
  it('только вид, код и язык — без личных данных', () => {
    expect(
      speechCacheKey({ kind: 'refusal', refusal: 'tone', locale: 'ru' }),
    ).toBe('speak|refusal|tone|ru');
    expect(speechCacheKey({ kind: 'consent-summary', locale: 'en' })).toBe(
      'speak|consent-summary||en',
    );
    expect(
      speechCacheKey({ kind: 'answer', topic: 'how-long', locale: 'de' }),
    ).toBe('speak|answer|how-long|de');
  });

  it('разные коды — разные ключи; не пересекается с ключами подсказок', () => {
    const keys = new Set<string>();
    for (const refusal of VOICE_REFUSAL_CODES) {
      keys.add(speechCacheKey({ kind: 'refusal', refusal, locale: 'ru' }));
    }
    for (const topic of VOICE_QUESTION_TOPICS) {
      keys.add(speechCacheKey({ kind: 'answer', topic, locale: 'ru' }));
    }
    expect(keys.size).toBe(
      VOICE_REFUSAL_CODES.length + VOICE_QUESTION_TOPICS.length,
    );
    for (const k of keys) expect(k.startsWith('GREETING_VIDEO|')).toBe(false);
  });
});

describe('CONTRACT5: чужой текст в речи и ведущий-персона', () => {
  it('до 60 знаков — как есть; длиннее — по слову, с многоточием', () => {
    expect(speakUserText('  Мама  ')).toBe('Мама');
    const exact = 'а'.repeat(SPEECH_USER_TEXT_MAX);
    expect(speakUserText(exact)).toBe(exact);
    const long = 'слово '.repeat(30);
    const cut = speakUserText(long);
    expect(cut.length).toBeLessThanOrEqual(SPEECH_USER_TEXT_MAX);
    expect(cut.endsWith('слово…')).toBe(true);
    const oneWord = 'я'.repeat(200);
    expect(speakUserText(oneWord).length).toBe(SPEECH_USER_TEXT_MAX);
  });

  it('свой повод в сводке тоже обрезается', () => {
    const text = consentSummarySpeech('ru', {
      recipient: 'Мама',
      occasion: 'OTHER',
      customOccasion: 'очень '.repeat(40),
      resolution: '720p',
      presenter: 'grok',
      charge: { kind: 'included' },
    })!;
    expect(text).toContain('…');
    expect(text).not.toContain('очень '.repeat(15));
  });

  it('персона в кадре — «вы в кадре» на пяти языках', () => {
    const labels = SUPPORTED_LOCALES.map((l) =>
      consentSummarySpeech(l, {
        recipient: 'A',
        occasion: 'BIRTHDAY',
        customOccasion: null,
        resolution: '720p',
        presenter: 'hedra',
        persona: true,
        charge: { kind: 'included' },
      }),
    );
    expect(labels[0]).toContain('вы в кадре');
    for (const t of labels) expect(t).not.toContain('Hedra');
  });

  it('ключ ответа без темы — свой, не пересекается с темами', () => {
    expect(speechCacheKey({ kind: 'answer', topic: null, locale: 'ru' })).toBe(
      'speak|answer|unknown|ru',
    );
  });
});
