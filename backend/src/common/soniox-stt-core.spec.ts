import {
  billedSeconds,
  dominantSonioxLanguage,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
  sonioxSpeechConfidence,
} from './soniox-stt-core';

// Копия этого спека проверяет копию модуля в sites-backend
// (scripts/sync-sites-shared.mjs); подробные ветки клиента —
// modules/voice/soniox-stt.client.spec.ts.
describe('soniox-stt-core', () => {
  it('тело транскрипции: модель, подсказки, строгость, термины', () => {
    expect(
      sonioxTranscriptionBody('f1', {
        languageHints: ['uk', 'ru'],
        strictLanguage: true,
        terms: [' Олена ', null, ''],
      }),
    ).toEqual({
      model: 'stt-async-v5',
      file_id: 'f1',
      language_hints: ['uk', 'ru'],
      language_hints_strict: true,
      enable_language_identification: true,
      enable_speaker_diarization: false,
      context: { terms: ['Олена'] },
    });
    expect(sonioxTranscriptionBody('f2', { languageHints: [] })).toEqual({
      model: 'stt-async-v5',
      file_id: 'f2',
      enable_language_identification: true,
      enable_speaker_diarization: false,
    });
  });

  it('текст без <end> и звуковых событий, язык по числу букв', () => {
    const r = sonioxTranscriptText({
      tokens: [
        { text: 'Привіт', language: 'uk', end_ms: 400 },
        { text: ' [сміх]', is_audio_event: true, end_ms: 900 },
        { text: ' ok', language: 'en', end_ms: 1500 },
        { text: '<end>', end_ms: 1600 },
      ],
    });
    expect(r).toEqual({ text: 'Привіт ok', seconds: 1.6, language: 'uk' });
    expect(dominantSonioxLanguage([])).toBeNull();
  });

  it('секунды счёта — по длительности Soniox, иначе по токенам', () => {
    expect(billedSeconds(2345, 1)).toBe(2.3);
    expect(billedSeconds(null, 1.5)).toBe(1.5);
  });
});

describe('speech confidence and service markers', () => {
  it('слабое слово не скрывается средней оценкой и служебными токенами', () => {
    expect(
      sonioxSpeechConfidence([
        { text: 'да', confidence: 0.3 },
        { text: ' верно', confidence: 0.99 },
        { text: '<end>', confidence: 0 },
      ]),
    ).toBe(0.3);
    expect(
      sonioxSpeechConfidence([
        { text: '[noise]', is_audio_event: true, confidence: 0 },
        { text: 'так', confidence: 0.9 },
      ]),
    ).toBe(0.9);
  });
  it('отсутствующая/невалидная метрика — null', () => {
    expect(
      sonioxSpeechConfidence([
        { text: 'да' },
        { text: 'да', confidence: NaN },
        { text: 'да', confidence: 2 },
      ]),
    ).toBeNull();
  });
  it('финализация не попадает в речь', () => {
    expect(
      sonioxTranscriptText({
        tokens: [{ text: 'назад' }, { text: '<fin>' }, { text: '<end>' }],
      }).text,
    ).toBe('назад');
  });
});
