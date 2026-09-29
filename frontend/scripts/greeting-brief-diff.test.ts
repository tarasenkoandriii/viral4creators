// Plain assertions runnable with `npx tsx scripts/greeting-brief-diff.test.ts`.
//
// Этап C ТЗ Greeting 2.0 (§3.6): после старта сессии бриф уходит только
// изменёнными полями.

import { changedBriefFields } from '../src/lib/greeting-brief-diff';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
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

const base = {
  occasion: 'BIRTHDAY',
  recipientName: 'Марина',
  senderName: null,
  presenterProvider: 'hedra',
  scriptLanguage: 'ru',
};

check('без правок — пустое тело', () => {
  eq(changedBriefFields(base, { ...base }), {});
});

check(
  'опечатка в имени не тащит за собой провайдера (тариф не перепроверяется)',
  () => {
    eq(changedBriefFields(base, { ...base, recipientName: 'Марине' }), {
      recipientName: 'Марине',
    });
  }
);

check('очистка поля — это правка, и уходит как null', () => {
  eq(changedBriefFields({ ...base, senderName: 'Андрей' }, { ...base }), {
    senderName: null,
  });
});

check('язык отправляется, только если его сменили', () => {
  eq(changedBriefFields(base, { ...base, scriptLanguage: 'de' }), {
    scriptLanguage: 'de',
  });
});

console.log(failed ? `\n${failed} провалено` : '\n4 проверок пройдено');
if (failed) process.exit(1);
