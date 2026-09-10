import assert from 'node:assert/strict';
import { detectLanguage, suggestDialogueLanguage } from '../src/lib/voiceover';

assert.equal(detectLanguage('Стальна термокружка, тримає тепло'), 'uk');
assert.equal(detectLanguage('Стальная термокружка, держит тепло'), 'ru');
assert.equal(detectLanguage('Steel travel mug'), 'en');
assert.equal(detectLanguage('Kubek termiczny ze stali, trzyma ciepło'), 'pl');
assert.equal(detectLanguage('12'), null);
assert.deepEqual(
  suggestDialogueLanguage({ chosen: 'en', countryLanguage: 'uk' }),
  { code: 'en', source: 'user' }
);
assert.deepEqual(
  suggestDialogueLanguage({ countryLanguage: 'uk', description: 'Steel mug' }),
  { code: 'uk', source: 'country' }
);
assert.deepEqual(suggestDialogueLanguage({ description: 'Стальная кружка' }), {
  code: 'ru',
  source: 'description',
});
assert.deepEqual(suggestDialogueLanguage({ description: '500' }), {
  code: 'en',
  source: 'default',
});
console.log('voiceover: 9 cases ok');
