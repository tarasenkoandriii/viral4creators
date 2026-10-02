// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/soniox-stt-core.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import {
  billedSeconds,
  dominantSonioxLanguage,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
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
