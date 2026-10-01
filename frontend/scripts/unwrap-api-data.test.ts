import assert from 'node:assert/strict';
import { unwrapApiData } from '../src/lib/unwrap-api-data';

// Обычный конверт: { success, data } → data.
assert.deepEqual(
  unwrapApiData<{ video: number }>({ data: { video: 1 } }, 'x'),
  { video: 1 }
);
// Двойной конверт (контроллер завернул сам, интерсептор — ещё раз):
// «Перерендерить» до 01.10.2026 читал `.video` у внутреннего конверта.
assert.deepEqual(
  unwrapApiData<{ video: number }>(
    { data: { success: true, data: { video: 2 } } },
    'x'
  ),
  { video: 2 }
);
// Данные, у которых есть своё поле `success`, но не true, — не трогаем.
assert.deepEqual(unwrapApiData({ data: { success: false, data: 1 } }, 'x'), {
  success: false,
  data: 1,
});
let thrown = '';
try {
  unwrapApiData({}, 'переозвучка');
} catch (e) {
  thrown = (e as Error).message;
}
assert.equal(thrown, 'Пустой ответ: переозвучка');
console.log('unwrap-api-data: ok');
