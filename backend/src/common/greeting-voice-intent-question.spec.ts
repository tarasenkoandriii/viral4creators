/**
 * K4 (§4А.2 п.1, п.5): вопрос о шаге — закрытый набор тем, ответ из
 * фактов, без выдумок; отказ по тону помечается кодом, который помощник
 * объясняет голосом.
 */
import {
  REPLIES,
  VOICE_QUESTION_TOPICS,
  VoiceBriefState,
  VoiceUnderstandContext,
  buildUnderstandPrompt,
  normalizeModelAnswer,
  resolveIntent,
} from './greeting-voice-intent';
import { SUPPORTED_LOCALES } from './locale';

function brief(over: Partial<VoiceBriefState> = {}): VoiceBriefState {
  return {
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    occasionRegister: null,
    registerSource: null,
    userOccasionRegister: null,
    scriptLanguage: 'ru',
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    presenterProvider: 'grok',
    resolution: '720p',
    occasionDate: null,
    ...over,
  };
}

function ctx(
  over: Partial<VoiceUnderstandContext> = {},
): VoiceUnderstandContext {
  return {
    brief: brief(),
    presenters: ['grok'],
    maxResolution: '720p',
    scope: 'project',
    hasScript: false,
    screen: { step: 'brief' },
    pending: null,
    uiLocale: 'ru',
    replyLocale: 'ru',
    ...over,
  };
}

const question = (topic: unknown, confidence = 0.9) =>
  normalizeModelAnswer({ kind: 'question', topic, confidence });

describe('K4: темы вопросов — закрытый список', () => {
  it('четыре темы из ТЗ: фото, ожидание, что дальше, проверка сценария', () => {
    expect([...VOICE_QUESTION_TOPICS]).toEqual([
      'why-photo',
      'how-long',
      'what-next',
      'script-flagged',
    ]);
  });

  it('тема из списка читается, выдуманная — null', () => {
    expect(question('how-long').topic).toBe('how-long');
    expect(question('price').topic).toBeNull();
    expect(question(42).topic).toBeNull();
    expect(question(undefined).topic).toBeNull();
  });

  it('у прочих видов ответа поля topic нет вовсе (форма прежняя)', () => {
    const a = normalizeModelAnswer({
      kind: 'help',
      topic: 'how-long',
      confidence: 0.9,
    });
    expect('topic' in a).toBe(false);
  });

  it('инструкция модели называет все темы и запрещает отвечать самой', () => {
    const prompt = buildUnderstandPrompt('зачем фото?', ctx());
    for (const t of VOICE_QUESTION_TOPICS) expect(prompt).toContain(t);
    expect(prompt).toContain('- question —');
    expect(prompt).toMatch(/НЕ отвечай/);
  });
});

describe('K4: ответ на вопрос — только из фактов', () => {
  it('факт есть — ответ фактом, answered: true', () => {
    const asked: Array<[string, string]> = [];
    const r = resolveIntent(
      question('how-long'),
      'сколько ждать?',
      ctx({
        answerQuestion: (topic, locale) => {
          asked.push([topic, locale]);
          return 'Ролик обычно генерируется несколько минут.';
        },
      }),
    );
    expect(r.intent).toEqual({
      kind: 'question',
      topic: 'how-long',
      answered: true,
    });
    expect(r.reply).toBe('Ролик обычно генерируется несколько минут.');
    expect(asked).toEqual([['how-long', 'ru']]);
  });

  it('ответ — на языке реплики, а не интерфейса', () => {
    const asked: string[] = [];
    resolveIntent(
      question('why-photo'),
      'навіщо фото?',
      ctx({
        uiLocale: 'ru',
        replyLocale: 'uk',
        answerQuestion: (_t, locale) => {
          asked.push(locale);
          return 'x';
        },
      }),
    );
    expect(asked).toEqual(['uk']);
  });

  it('тема вне списка — «не знаю, посмотрите справку», answered: false', () => {
    const r = resolveIntent(
      question('price'),
      'сколько стоит?',
      ctx({ answerQuestion: () => 'не должен звучать' }),
    );
    expect(r.intent).toEqual({
      kind: 'question',
      topic: null,
      answered: false,
    });
    expect(r.reply).toBe(REPLIES.ru.questionUnknown);
  });

  it('факта нет — тоже «не знаю», а не пустота и не догадка', () => {
    const r = resolveIntent(
      question('what-next'),
      'что дальше?',
      ctx({ answerQuestion: () => null }),
    );
    expect(r.intent).toEqual({
      kind: 'question',
      topic: 'what-next',
      answered: false,
    });
    expect(r.reply).toBe(REPLIES.ru.questionUnknown);
  });

  it('без источника фактов — «не знаю»', () => {
    const r = resolveIntent(question('how-long'), 'сколько ждать?', ctx());
    expect(r.intent).toMatchObject({ kind: 'question', answered: false });
  });

  it('ниже порога уверенности — переспрос, вопрос не отвечается', () => {
    let called = false;
    const r = resolveIntent(
      question('how-long', 0.3),
      'сколько ждать?',
      ctx({
        answerQuestion: () => {
          called = true;
          return 'x';
        },
      }),
    );
    expect(r.intent).toEqual({ kind: 'unknown' });
    expect(called).toBe(false);
  });

  it('«не знаю» есть на всех пяти языках и без восклицаний', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(REPLIES[l].questionUnknown).toBeTruthy();
      expect(REPLIES[l].questionUnknown).not.toMatch(/[!¡]/);
    }
  });
});

describe('K4: отказ по тону помечается кодом', () => {
  const condolence = ctx({
    brief: brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
  });

  it('«веселее» на соболезновании — refusal: tone', () => {
    const r = resolveIntent(
      normalizeModelAnswer({
        kind: 'command',
        command: 'tone-lighter',
        confidence: 0.9,
      }),
      'сделай веселее',
      condolence,
    );
    expect(r.intent).toEqual({ kind: 'unknown' });
    expect(r.refusal).toBe('tone');
    expect(r.reply).toBeTruthy();
  });

  it('«тон с юмором» полем на соболезновании — refusal: tone', () => {
    const r = resolveIntent(
      normalizeModelAnswer({
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'tone', value: 'FUNNY' }],
      }),
      'тон с юмором',
      condolence,
    );
    expect(r.refusal).toBe('tone');
  });

  it('отказ не по тону (уже самый серьёзный) — без кода', () => {
    const r = resolveIntent(
      normalizeModelAnswer({
        kind: 'command',
        command: 'no-jokes',
        confidence: 0.9,
      }),
      'без шуток',
      condolence,
    );
    expect(r.intent).toEqual({ kind: 'unknown' });
    expect('refusal' in r).toBe(false);
  });

  it('допустимый тон — без кода', () => {
    const r = resolveIntent(
      normalizeModelAnswer({
        kind: 'fill',
        confidence: 0.9,
        fields: [{ target: 'tone', value: 'FUNNY' }],
      }),
      'тон с юмором',
      ctx(),
    );
    expect(r.intent.kind).toBe('fill');
    expect('refusal' in r).toBe(false);
  });
});
