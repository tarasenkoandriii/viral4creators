import assert from 'node:assert/strict';
import { parseJsonObject } from '../src/features/brand/json-object';

// Этап 56: сообщения об ошибках больше не зашиты в функции — она принимает
// их переведённым объектом (тем же способом, что lockLabel в lib/plan.ts).
// Для теста достаточно русских текстов из dictionaries/ru.json — сама
// логика от языка не зависит.
const t = {
  notAnObject: 'Нужен JSON-объект: { "ключ": значение }',
  tooLarge: 'Больше 16 КБ',
  invalidJson: 'Невалидный JSON',
};

assert.deepEqual(parseJsonObject('', t), { value: null, error: null });
assert.deepEqual(parseJsonObject('   ', t), { value: null, error: null });
assert.deepEqual(parseJsonObject('{"a":1}', t), {
  value: { a: 1 },
  error: null,
});
assert.equal(parseJsonObject('[1,2]', t).error, t.notAnObject);
assert.equal(parseJsonObject('null', t).error, t.notAnObject);
assert.equal(parseJsonObject('"str"', t).error, t.notAnObject);
assert.equal(parseJsonObject('{oops', t).error, t.invalidJson);
const big = JSON.stringify({ x: 'a'.repeat(16 * 1024) });
assert.equal(parseJsonObject(big, t).error, t.tooLarge);
console.log('json-object: 8 cases ok');
