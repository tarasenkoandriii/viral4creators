import {
  GREETING_VOICE_MAX_BYTES,
  LATIN_RETRY_SHARE,
  buildGreetingVoicePrompt,
  expectsCyrillic,
  latinShare,
  needsScriptRetry,
  stripNonSpeech,
  VOICE_UTTERANCE_MAX_MS,
  greetingVoiceMaxBytesFor,
  greetingVoiceTooLong,
  voiceLanguageHints,
} from './greeting-voice';

describe('voiceLanguageHints — порядок, а не один язык (§4А.3, сверено с DA)', () => {
  it('кириллический язык поздравления тянет за собой второй кириллический', () => {
    // Ровно правка редакции 1.6: у DA при известном ru передаются оба.
    expect(voiceLanguageHints('uk', 'uk')).toEqual(['uk', 'ru']);
    expect(voiceLanguageHints('ru', 'ru')).toEqual(['ru', 'uk']);
  });

  it('язык поздравления первым, язык интерфейса следом', () => {
    // Бабушка в Харькове, внук в Берлине: поздравление по-немецки,
    // команды мастеру — по-русски.
    expect(voiceLanguageHints('de', 'ru')).toEqual(['de', 'ru', 'uk']);
    expect(voiceLanguageHints('uk', 'en')).toEqual(['uk', 'en', 'ru']);
  });

  it('без кириллицы — без кириллических подсказок', () => {
    expect(voiceLanguageHints('de', 'de')).toEqual(['de']);
    expect(voiceLanguageHints('en', 'es')).toEqual(['en', 'es']);
  });

  it('языка поздравления нет — идёт язык интерфейса', () => {
    expect(voiceLanguageHints(null, 'uk')).toEqual(['uk', 'ru']);
  });

  it('не известно ничего — как у DA: аудитория ближе к ru/uk', () => {
    expect(voiceLanguageHints(null, null)).toEqual(['uk', 'ru']);
    expect(voiceLanguageHints('xx', 'zz-ZZ')).toEqual(['uk', 'ru']);
  });
});

describe('письменность ответа (§4А.3, строка «Ответ латиницей»)', () => {
  it('латиница считается только среди букв', () => {
    expect(latinShare('Марина')).toBe(0);
    expect(latinShare('Marina')).toBe(1);
    expect(latinShare('25 лет!')).toBe(0);
    expect(latinShare('')).toBe(0);
    expect(latinShare('ab вг')).toBe(0.5);
  });

  it('повтор — ровно с порога, не раньше', () => {
    const hints = ['ru', 'uk'];
    // Ровно половина — уже другая письменность.
    expect(needsScriptRetry('ab вг', hints)).toBe(true);
    expect(latinShare('ab вгд')).toBeLessThan(LATIN_RETRY_SHARE);
    expect(needsScriptRetry('ab вгд', hints)).toBe(false);
  });

  it('латинские вставки в кириллической фразе — не повод повторять', () => {
    expect(
      needsScriptRetry('поставь музыку как на YouTube', ['ru', 'uk']),
    ).toBe(false);
  });

  it('язык речи от провайдера важнее языка поздравления', () => {
    // Английское поздравление, а говорят по-русски — латиница подозрительна.
    expect(needsScriptRetry('seryoznee', ['en', 'ru', 'uk'], 'ru')).toBe(true);
    // Украинское поздравление, а сказана английская фраза — латиница законна.
    expect(needsScriptRetry('happy birthday', ['uk', 'ru'], 'en')).toBe(false);
    // Язык не сообщён — как раньше, по подсказкам.
    expect(needsScriptRetry('seryoznee', ['ru', 'uk'], null)).toBe(true);
  });

  it('язык поздравления не кириллический — латиница законна', () => {
    expect(expectsCyrillic(['en', 'ru', 'uk'])).toBe(false);
    expect(needsScriptRetry('Happy birthday Marina', ['en', 'ru', 'uk'])).toBe(
      false,
    );
  });
});

describe('stripNonSpeech — звуки не становятся текстом', () => {
  it('подписи звуков в квадратных скобках убираются целиком', () => {
    expect(stripNonSpeech('[смех] серьёзнее [music]')).toBe('серьёзнее');
  });
  it('круглые скобки — пунктуация, остаются', () => {
    expect(stripNonSpeech('от Андрея (и Оли)')).toBe('от Андрея (и Оли)');
  });
  it('одни подписи — это «не расслышал», а не текст', () => {
    expect(stripNonSpeech('[шум]')).toBeNull();
    expect(stripNonSpeech('   ')).toBeNull();
    expect(stripNonSpeech(null)).toBeNull();
  });
});

describe('buildGreetingVoicePrompt', () => {
  const base = { hints: ['uk', 'ru'] as const, names: ['Марина', null] };

  it('дословно — в отличие от описания товара', () => {
    const p = buildGreetingVoicePrompt({ ...base, hints: [...base.hints] });
    expect(p).toContain('ДОСЛОВНО');
    expect(p).not.toContain('Убери междометия');
  });

  it('языки — в порядке подсказки, английскими именами', () => {
    const p = buildGreetingVoicePrompt({ ...base, hints: ['uk', 'ru'] });
    const uk = p.indexOf('Ukrainian');
    const ru = p.indexOf('Russian');
    expect(uk).toBeGreaterThan(-1);
    expect(ru).toBeGreaterThan(uk);
  });

  it('смешанная речь не нормализуется — правило сказано прямо', () => {
    const p = buildGreetingVoicePrompt({ ...base, hints: ['uk', 'ru'] });
    expect(p).toContain('не приводи речь к одному литературному языку');
  });

  it('имена из брифа — в кавычках, пустые пропущены, кавычки внутри вычищены', () => {
    const p = buildGreetingVoicePrompt({
      hints: ['ru', 'uk'],
      names: ['Марина', '', '  ', 'Андрей «Дрон»\nИванов'],
    });
    expect(p).toContain('«Марина»');
    expect(p).toContain('«Андрей Дрон Иванов»');
    expect(p).not.toContain('«»');
  });

  it('без имён — строки про имена нет вовсе', () => {
    const p = buildGreetingVoicePrompt({ hints: ['ru', 'uk'], names: [null] });
    expect(p).not.toContain('имена');
  });

  it('повтор после латиницы — требование письменности идёт ПЕРВЫМ', () => {
    const p = buildGreetingVoicePrompt({
      ...base,
      hints: ['ru'],
      strictScript: true,
    });
    expect(p.startsWith('ВНИМАНИЕ')).toBe(true);
    const plain = buildGreetingVoicePrompt({ ...base, hints: ['ru'] });
    expect(plain).not.toContain('ВНИМАНИЕ');
  });
});

it('потолок реплики заметно ниже потолка диктовки товара', () => {
  // 15 МБ — описание товара; реплика мастера — команда или значение поля.
  expect(GREETING_VOICE_MAX_BYTES).toBeLessThan(15 * 1024 * 1024);
  expect(GREETING_VOICE_MAX_BYTES).toBeGreaterThan(0);
});

// Финальный аудит ветки K (30.09.2026), изменение контракта 4.

describe('потолок реплики — минута', () => {
  it('байты по типу: минута по щедрому битрейту, не больше общего потолка', () => {
    expect(VOICE_UTTERANCE_MAX_MS).toBe(60_000);
    // opus 192 кбит/с, AAC 256 кбит/с, mp3 320 кбит/с — ровно минута.
    expect(greetingVoiceMaxBytesFor('audio/webm')).toBe(1_440_000);
    expect(greetingVoiceMaxBytesFor('audio/webm;codecs=opus')).toBe(1_440_000);
    expect(greetingVoiceMaxBytesFor('AUDIO/OGG; codecs=opus')).toBe(1_440_000);
    expect(greetingVoiceMaxBytesFor('audio/mp4')).toBe(1_920_000);
    expect(greetingVoiceMaxBytesFor('audio/x-m4a')).toBe(1_920_000);
    expect(greetingVoiceMaxBytesFor('audio/mpeg')).toBe(2_400_000);
    // Несжатое упирается в общий потолок раньше минуты; неизвестное — он же.
    expect(greetingVoiceMaxBytesFor('audio/wav')).toBe(
      GREETING_VOICE_MAX_BYTES,
    );
    expect(greetingVoiceMaxBytesFor('audio/x-unknown')).toBe(
      GREETING_VOICE_MAX_BYTES,
    );
    expect(greetingVoiceMaxBytesFor(null)).toBe(GREETING_VOICE_MAX_BYTES);
  });

  it('длительность от провайдера главнее оценки по размеру', () => {
    const big = greetingVoiceMaxBytesFor('audio/webm') + 1;
    expect(
      greetingVoiceTooLong({
        bytes: 10,
        mimeType: 'audio/webm',
        durationMs: 60_001,
      }),
    ).toBe(true);
    expect(
      greetingVoiceTooLong({
        bytes: 10,
        mimeType: 'audio/webm',
        durationMs: 60_000,
      }),
    ).toBe(false);
    // Длительность есть — тяжёлая по байтам, но короткая запись проходит.
    expect(
      greetingVoiceTooLong({
        bytes: big,
        mimeType: 'audio/webm',
        durationMs: 5_000,
      }),
    ).toBe(false);
    // Нет длительности (или мусор) — оценка по размеру и типу.
    expect(greetingVoiceTooLong({ bytes: big, mimeType: 'audio/webm' })).toBe(
      true,
    );
    expect(
      greetingVoiceTooLong({
        bytes: big - 1,
        mimeType: 'audio/webm',
        durationMs: 0,
      }),
    ).toBe(false);
  });
});
