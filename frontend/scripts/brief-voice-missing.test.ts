// Plain assertions runnable with `npx tsx scripts/brief-voice-missing.test.ts`.
//
// Аудит ветки K: после «Да» на карточке брифа помощник называет, чего не
// хватает для сохранения, а не зовёт к погашенной кнопке.

import { briefVoiceMissing } from '../src/lib/brief-voice-missing';
import { occasionFieldsComplete } from '../src/lib/greeting-occasion-fields';
import { GREETING_OCCASIONS } from '../src/types/project';
import { GREETING_REGISTER_ORDER } from '../src/lib/greeting-policy';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

check('обычный повод с получателем — всё есть', () => {
  eq(
    briefVoiceMissing(
      { occasion: 'BIRTHDAY', customOccasionText: '', mood: null },
      'Марина'
    ),
    []
  );
});

check('особый повод без настроения — вопрос о настроении', () => {
  eq(
    briefVoiceMissing(
      { occasion: 'OTHER', customOccasionText: 'новоселье', mood: null },
      'Марина'
    ),
    ['mood']
  );
});

check('особый повод без описания (пробелы) — описание', () => {
  eq(
    briefVoiceMissing(
      { occasion: 'OTHER', customOccasionText: '   ', mood: 'CELEBRATORY' },
      'Марина'
    ),
    ['customOccasion']
  );
});

check('пустой получатель (пробелы) — назвать получателя', () => {
  eq(
    briefVoiceMissing(
      { occasion: 'WEDDING', customOccasionText: '', mood: null },
      '  '
    ),
    ['recipient']
  );
});

check('всё сразу — в порядке полей на экране', () => {
  eq(
    briefVoiceMissing(
      { occasion: 'OTHER', customOccasionText: '', mood: null },
      ''
    ),
    ['customOccasion', 'mood', 'recipient']
  );
});

check('у повода из списка описание и настроение не требуются', () => {
  eq(
    briefVoiceMissing(
      { occasion: 'ANNIVERSARY', customOccasionText: '', mood: null },
      'Олег'
    ),
    []
  );
});

check('пусто ⇔ кнопка «Сохранить» активна (то же правило, что canSave)', () => {
  for (const occasion of GREETING_OCCASIONS) {
    for (const customOccasionText of ['', ' ', 'поминки']) {
      for (const mood of [null, ...GREETING_REGISTER_ORDER]) {
        for (const recipient of ['', ' ', 'Аня']) {
          const state = { occasion, customOccasionText, mood };
          const canSave =
            recipient.trim().length > 0 && occasionFieldsComplete(state);
          const empty = briefVoiceMissing(state, recipient).length === 0;
          if (canSave !== empty) {
            throw new Error(
              `${JSON.stringify(state)} «${recipient}»: canSave=${canSave}, missing пуст=${empty}`
            );
          }
        }
      }
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
