import {
  appendSoundCheck,
  parseSoundCheckResponse,
  soundCheckPrompt,
} from './sound-check';
import { SoundCheck } from './types/audit.types';

describe('soundCheckPrompt', () => {
  it('embeds the requested response language and the human/synthetic/ambiguous contract', () => {
    const p = soundCheckPrompt('German');
    expect(p).toContain('in German');
    expect(p).toContain('"verdict": "human" | "synthetic" | "ambiguous"');
    expect(p).toContain('ignore visual quality, lip-sync accuracy');
  });

  it('defaults to Russian when no language is given', () => {
    expect(soundCheckPrompt()).toContain('in Russian');
  });
});

describe('parseSoundCheckResponse', () => {
  it('parses a clean JSON verdict with notes, caps notes at 8', () => {
    const r = parseSoundCheckResponse(
      JSON.stringify({
        verdict: 'human',
        summary: 'Звучит как реальный человек',
        notes: Array.from({ length: 12 }, (_, i) => `наблюдение ${i}`),
      }),
    );
    expect(r.verdict).toBe('human');
    expect(r.summary).toBe('Звучит как реальный человек');
    expect(r.notes).toHaveLength(8);
    expect(r.notes[0]).toBe('наблюдение 0');
  });

  it('accepts the response wrapped in a ```json fence', () => {
    const r = parseSoundCheckResponse(
      '```json\n' +
        JSON.stringify({ verdict: 'synthetic', summary: 'Похоже на TTS' }) +
        '\n```',
    );
    expect(r).toEqual({
      verdict: 'synthetic',
      summary: 'Похоже на TTS',
      notes: [],
    });
  });

  it('unknown/garbage verdict value → "unknown", never throws', () => {
    const r = parseSoundCheckResponse(
      JSON.stringify({ verdict: 'robotic-ish', summary: 'неясно' }),
    );
    expect(r.verdict).toBe('unknown');
    expect(r.summary).toBe('неясно');
  });

  it('non-JSON text → unknown with the raw text as summary, never throws', () => {
    const r = parseSoundCheckResponse('The model rambled about the voice.');
    expect(r).toEqual({
      verdict: 'unknown',
      summary: 'The model rambled about the voice.',
      notes: [],
    });
  });

  it('empty text → locale-specific empty-response fallback', () => {
    expect(parseSoundCheckResponse('', 'ru').summary).toBe(
      'Пустой ответ модели',
    );
    expect(parseSoundCheckResponse('', 'en').summary).toBe(
      'Empty response from the model',
    );
    // неизвестная локаль → ru как дефолт
    expect(parseSoundCheckResponse('', 'fr').summary).toBe(
      'Пустой ответ модели',
    );
  });

  it('non-array notes are ignored rather than throwing', () => {
    const r = parseSoundCheckResponse(
      JSON.stringify({ verdict: 'ambiguous', notes: 'not an array' }),
    );
    expect(r.notes).toEqual([]);
  });
});

describe('appendSoundCheck', () => {
  const mk = (checkId: string): SoundCheck => ({
    checkId,
    subject: 'veo',
    requestedAt: new Date(),
    completedAt: new Date(),
    status: 'complete',
    verdict: 'human',
    summary: 'ok',
    notes: [],
  });

  it('prepends the new check (newest first) to an empty/undefined history', () => {
    const state = appendSoundCheck(undefined, mk('c1'));
    expect(state.history.map((c) => c.checkId)).toEqual(['c1']);
  });

  it('prepends to existing history without dropping older entries', () => {
    const first = appendSoundCheck(undefined, mk('c1'));
    const second = appendSoundCheck(first, mk('c2'));
    expect(second.history.map((c) => c.checkId)).toEqual(['c2', 'c1']);
  });

  it('caps history at 20 entries, dropping the oldest', () => {
    let state = appendSoundCheck(undefined, mk('seed'));
    for (let i = 0; i < 25; i++) {
      state = appendSoundCheck(state, mk(`c${i}`));
    }
    expect(state.history).toHaveLength(20);
    expect(state.history[0].checkId).toBe('c24');
    expect(state.history.map((c) => c.checkId)).not.toContain('seed');
  });
});
