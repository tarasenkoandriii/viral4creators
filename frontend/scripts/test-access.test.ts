// Plain assertions runnable with `npx tsx scripts/test-access.test.ts`.

import {
  TEST_SCENARIO_ORDER,
  showsTestAccess,
  testScenarioLabels,
} from '../src/lib/test-access';
import ru from '../src/dictionaries/ru.json';

const labels = ru.accountNotice.testAccess.scenarios as Record<string, string>;

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
function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} ожидалось ${b}, получено ${a}`);
}

check('каждый код сценария переведён — иначе бесплатное молча пропадёт', () => {
  for (const code of TEST_SCENARIO_ORDER) {
    if (!labels[code]) throw new Error(`нет подписи для ${code}`);
  }
});

check('порядок списка не зависит от порядка в ответе сервера', () => {
  eq(
    testScenarioLabels(['GREETING_VIDEO', 'PRODUCT_VIDEO'], labels),
    [labels.PRODUCT_VIDEO, labels.GREETING_VIDEO],
  );
});

check('незнакомый код пропускается, а не показывается сырым', () => {
  // Сценарии заводятся на бэкенде, интерфейс может отстать на деплой.
  // Непереведённый `SOMETHING_NEW` в списке читается как ошибка.
  eq(testScenarioLabels(['PRODUCT_VIDEO', 'SOMETHING_NEW'], labels), [
    labels.PRODUCT_VIDEO,
  ]);
});

check('плашки нет без флага тестового аккаунта', () => {
  eq(
    showsTestAccess(
      { isTestUser: false, freeScenarios: ['PRODUCT_VIDEO'] },
      labels,
    ),
    false,
  );
});

check('плашки нет, если не открыт ни один сценарий', () => {
  // Флаг без галочек работает как обычный аккаунт; благодарить за
  // бесплатный проход, которого нет, — обман.
  eq(showsTestAccess({ isTestUser: true, freeScenarios: [] }, labels), false);
  eq(
    showsTestAccess({ isTestUser: true, freeScenarios: ['НЕТ_ТАКОГО'] }, labels),
    false,
  );
});

check('плашка есть, когда открыт хотя бы один сценарий', () => {
  eq(
    showsTestAccess(
      { isTestUser: true, freeScenarios: ['CLIENT_SITE'] },
      labels,
    ),
    true,
  );
});

check('анонимный путь плашки не получает', () => {
  eq(showsTestAccess(null, labels), false);
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n7 проверок пройдено');
