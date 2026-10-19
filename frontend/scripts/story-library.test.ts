// Plain assertions runnable with `npx tsx scripts/story-library.test.ts`.
//
// Story‑Tales WP2: references library and editions registry helpers.

import {
  canRetryReference,
  editionOptionLabel,
  formatMicroUsd,
  parseUsdBudget,
  planBudget,
  referenceListPath,
  referencePlanPath,
  referenceSearchPath,
  referenceStatusLabel,
  storyTime,
} from '../src/features/stories/story-library';

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

check('timecodes are m:ss and never negative', () => {
  eq(storyTime(0), '0:00');
  eq(storyTime(65.9), '1:05');
  eq(storyTime(300), '5:00');
  eq(storyTime(-3), '0:00');
});

check('reserve is rounded up to the cent', () => {
  eq(formatMicroUsd(671_472), '$0.68');
  eq(formatMicroUsd(1_000_000), '$1.00');
  eq(formatMicroUsd(0), '$0.00');
});

check('list path omits empty filters and encodes the search', () => {
  eq(referenceListPath('', ''), '/story-gifts/references');
  eq(
    referenceListPath(' лес ', 'unknown'),
    '/story-gifts/references?query=%D0%BB%D0%B5%D1%81&status=unknown'
  );
  eq(referenceListPath('a&b', ''), '/story-gifts/references?query=a%26b');
});

check('plan and search paths carry only given parameters', () => {
  eq(
    referencePlanPath('Q1hbf5TrWCM', {
      editionId: 'turnip-ushinsky-ru-1949-v1',
      budgetUsd: '5',
      preambleText: '',
    }),
    '/story-gifts/references/Q1hbf5TrWCM/plan?editionId=turnip-ushinsky-ru-1949-v1&budgetUsd=5'
  );
  eq(
    referenceSearchPath('репка', 'ru'),
    '/story-gifts/references/youtube?q=%D1%80%D0%B5%D0%BF%D0%BA%D0%B0&language=ru'
  );
});

check('explicit retry only for unconfirmed results', () => {
  eq(canRetryReference({ status: 'unknown' }), true);
  eq(canRetryReference({ status: 'unavailable' }), true);
  eq(canRetryReference({ status: 'complete' }), false);
  eq(canRetryReference({ status: 'running' }), false);
  eq(canRetryReference({ status: 'unknown', retryAllowed: false }), false);
});

check('plan budget accepts 1..1000 with comma decimals', () => {
  eq(planBudget('5'), 5);
  eq(planBudget('2,5'), 2.5);
  eq(planBudget('0.5'), null);
  eq(planBudget('1001'), null);
  eq(planBudget('abc'), null);
  eq(planBudget('2.555'), null);
});
check('budget parser (S3-4): cents only, Russian messages', () => {
  eq(parseUsdBudget('2.50'), { value: 2.5, error: null });
  eq(parseUsdBudget(' 3,75 '), { value: 3.75, error: null });
  eq(parseUsdBudget('1000'), { value: 1000, error: null });
  eq(
    parseUsdBudget('2.555').error,
    'Бюджет — не больше двух знаков после запятой (центы)'
  );
  eq(parseUsdBudget('0.99').error, 'Бюджет — от $1 до $1000');
  eq(parseUsdBudget('').error, 'Бюджет — число от $1 до $1000');
  eq(parseUsdBudget('1e3').error, 'Бюджет — число от $1 до $1000');
});

check('labels', () => {
  eq(referenceStatusLabel('partial'), 'Частичный разбор · проверьте таймкоды');
  eq(referenceStatusLabel('weird'), 'weird');
  eq(
    editionOptionLabel({
      title: 'Рукавичка',
      kindLabel: 'адаптация',
      locale: 'uk',
    }),
    'Рукавичка · адаптация · UK'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
