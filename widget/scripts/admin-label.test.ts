/**
 * Заход 10 (Ш6 (4), Р-З10-15): подпись кнопки «Админки» — атрибут
 * `data-label` тега. Текст ≤ 40 символов (не байт), без HTML и управляющих
 * символов; иначе — подпись по умолчанию на языке страницы. Кнопка рисуется
 * через textContent (экранирование не нужно), но «<b>» в подписи — признак
 * мусора, а не подписи: берётся запасная.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom } from './fake-dom';

installFakeDom();
const { adminLabel } = await import('../src/admin/index');

assert.equal(
  adminLabel('Помічник Viral4Creators', 'uk'),
  'Помічник Viral4Creators'
);
assert.equal(adminLabel('  Мій   помічник  ', 'uk'), 'Мій помічник', 'пробелы');
assert.equal(adminLabel(null, 'uk'), 'Помічник співробітника');
assert.equal(adminLabel('', 'ru'), 'Помощник сотрудника');
assert.equal(adminLabel('   ', 'en'), 'Staff assistant');
assert.equal(
  adminLabel('<img src=x onerror=1>', 'uk'),
  'Помічник співробітника'
);
assert.equal(adminLabel('a\u0000b', 'en'), 'Staff assistant');
assert.equal(adminLabel('я'.repeat(40), 'uk'), 'я'.repeat(40), '40 символов');
assert.equal(adminLabel('я'.repeat(41), 'uk'), 'Помічник співробітника');
assert.equal(adminLabel('ok', 'xx'), 'ok');
assert.equal(adminLabel(null, 'xx'), 'Помічник співробітника');

// Подпись — во всех трёх местах (кнопка, диалог, iframe), а не только кнопка.
const src = readFileSync(
  new URL('../src/admin/index.ts', import.meta.url),
  'utf8'
);
assert.ok(/btn\.textContent = label;/.test(src));
assert.ok(/aria-label', label\)/.test(src));
assert.ok(/frame\.title = label;/.test(src));
assert.ok(!/fetch\([^)]*label/i.test(src), 'без сетевого запроса до кнопки');

console.log('admin-label: ok');
