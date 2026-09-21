/**
 * Раскладка сегментов `Pills`.
 *
 * Дефект, который эти проверки закрывают: колонок было столько же,
 * сколько вариантов. На экране создания проекта вариантов четыре и у
 * каждого есть подпись — в телефонной ширине это ~70 пикселей на
 * карточку, и текст вываливался за фон кнопки («Ролик-поздравление»
 * обрезался краем экрана, описание уезжало под карточку).
 */
import assert from 'node:assert/strict';
import { pillColumns } from '../src/components/ui/pill-columns';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const plain = (n: number) => Array.from({ length: n }, () => ({}));
const withSub = (n: number) =>
  Array.from({ length: n }, () => ({ sub: 'описание' }));

console.log('pill-columns');

it('четыре варианта с подписями укладываются в две колонки', () => {
  // Ровно случай экрана создания проекта.
  assert.equal(pillColumns(withSub(4)), 2);
});

it('короткие варианты без подписей остаются в одну строку', () => {
  // Выбор пола в карточке аудитории: «Женщины / Мужчины / Любая / —».
  // Ломать их ради чужой беды незачем.
  assert.equal(pillColumns(plain(4)), 4);
});

it('достаточно подписи у ОДНОГО варианта', () => {
  assert.equal(pillColumns([{}, {}, { sub: 'x' }, {}]), 2);
});

it('два варианта с подписями остаются рядом', () => {
  assert.equal(pillColumns(withSub(2)), 2);
});

it('один вариант с подписью занимает одну колонку', () => {
  assert.equal(pillColumns(withSub(1)), 1);
});

it('явный columns сильнее правила', () => {
  assert.equal(pillColumns(withSub(4), 4), 4);
  assert.equal(pillColumns(plain(2), 1), 1);
});

it('пустой список даёт одну колонку, а не ноль', () => {
  // `repeat(0, …)` — невалидный CSS: сетка схлопнулась бы молча.
  assert.equal(pillColumns([]), 1);
  assert.equal(pillColumns([], 0), 1);
});

it('null в подписи не считается подписью', () => {
  assert.equal(pillColumns([{ sub: null }, { sub: null }, { sub: null }]), 3);
});

console.log(`pill-columns: ${passed} проверок пройдено`);
