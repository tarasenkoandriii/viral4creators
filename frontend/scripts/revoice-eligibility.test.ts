/**
 * Зеркало правила переозвучки (П-8) — те же случаи, что у бэкендового
 * backend/src/common/revoice-eligibility.spec.ts: разойтись правилам
 * значит снова показать кнопку, которую сервер отклонит.
 */
import assert from 'node:assert/strict';
import { revoiceBlock } from '../src/lib/revoice-eligibility';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const withBrand = { hasBrandSnapshot: true, hasGreetingSnapshot: false };
const bare = { hasBrandSnapshot: false, hasGreetingSnapshot: false };

console.log('revoice-eligibility');

it('voiceover/dub со снимком брендбука — можно', () => {
  assert.equal(revoiceBlock({ voiceMode: 'voiceover', ...withBrand }), null);
  assert.equal(revoiceBlock({ voiceMode: 'dub', ...withBrand }), null);
});

it('veo и пустой режим — дорожки нет', () => {
  assert.equal(revoiceBlock({ voiceMode: 'veo', ...withBrand }), 'veo-voice');
  assert.equal(revoiceBlock({ voiceMode: null, ...withBrand }), 'veo-voice');
  assert.equal(
    revoiceBlock({ voiceMode: undefined, ...withBrand }),
    'veo-voice'
  );
});

it('ЭТО И БЫЛА ОШИБКА: без снимков кнопка гаснет с причиной', () => {
  assert.equal(
    revoiceBlock({ voiceMode: 'voiceover', ...bare }),
    'no-voice-settings'
  );
});

it('поздравление без брендбука — можно', () => {
  assert.equal(
    revoiceBlock({
      voiceMode: 'dub',
      hasBrandSnapshot: false,
      hasGreetingSnapshot: true,
    }),
    null
  );
});

it('Veo без снимков — причина Veo', () => {
  assert.equal(revoiceBlock({ voiceMode: 'veo', ...bare }), 'veo-voice');
});

console.log(`  ${passed} passed`);
