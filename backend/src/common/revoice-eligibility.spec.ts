/**
 * Правило «можно ли переозвучить» — общее для списка «Постпрод» и
 * `reVoice()` (П-8). Зеркало на фронтенде проверяется своим тестом
 * (frontend/scripts/revoice-eligibility.test.ts) на тех же случаях.
 */
import { revoiceBlock, REVOICE_BLOCK_MESSAGE } from './revoice-eligibility';

describe('revoiceBlock', () => {
  const withBrand = { hasBrandSnapshot: true, hasGreetingSnapshot: false };

  it('voiceover/dub со снимком брендбука — можно', () => {
    expect(revoiceBlock({ voiceMode: 'voiceover', ...withBrand })).toBeNull();
    expect(revoiceBlock({ voiceMode: 'dub', ...withBrand })).toBeNull();
  });

  it('veo и мусор в режиме — голос вшит, дорожки нет', () => {
    expect(revoiceBlock({ voiceMode: 'veo', ...withBrand })).toBe('veo-voice');
    expect(revoiceBlock({ voiceMode: null, ...withBrand })).toBe('veo-voice');
    expect(revoiceBlock({ voiceMode: 'nonsense', ...withBrand })).toBe(
      'veo-voice',
    );
  });

  it('ни брендбука, ни брифа поздравления — голос негде взять', () => {
    expect(
      revoiceBlock({
        voiceMode: 'voiceover',
        hasBrandSnapshot: false,
        hasGreetingSnapshot: false,
      }),
    ).toBe('no-voice-settings');
  });

  it('поздравление без брендбука — можно (голос в снимке брифа)', () => {
    expect(
      revoiceBlock({
        voiceMode: 'dub',
        hasBrandSnapshot: false,
        hasGreetingSnapshot: true,
      }),
    ).toBeNull();
  });

  it('Veo без снимков — причина Veo, а не снимок (её человеку не исправить)', () => {
    expect(
      revoiceBlock({
        voiceMode: 'veo',
        hasBrandSnapshot: false,
        hasGreetingSnapshot: false,
      }),
    ).toBe('veo-voice');
  });

  it('у каждой причины есть текст отказа', () => {
    expect(REVOICE_BLOCK_MESSAGE['veo-voice']).toMatch(/голос ведёт сама Veo/);
    expect(REVOICE_BLOCK_MESSAGE['no-voice-settings']).toMatch(
      /нет снимка брендбука/,
    );
  });
});
