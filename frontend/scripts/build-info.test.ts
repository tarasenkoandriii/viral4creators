import assert from 'node:assert/strict';
import { describeBuild } from '../src/lib/build-info';

// Дата впереди: строки сортируются как текст, и тикеты за разные дни
// выстраиваются сами. «Что новее» — первый вопрос к двум тикетам.
assert.equal(
  describeBuild({ sha: 'a1b2c3d4e5f6', date: '2026.09.25' }),
  '2026.09.25-a1b2c3d'
);
assert.equal(describeBuild({ sha: 'a1b2c3d4e5f6', date: null }), 'a1b2c3d');
assert.equal(describeBuild({ sha: null, date: '2026.09.25' }), '2026.09.25');

// Пустота в тикете читается как потерянное поле, а не как неопознанная
// сборка.
assert.equal(describeBuild({ sha: null, date: null }), 'dev');
assert.equal(describeBuild({ sha: '', date: '' }), 'dev');
assert.equal(describeBuild({ sha: '   ', date: '   ' }), 'dev');

// Строка «undefined» приезжает, когда переменную подставили шаблоном;
// обрезанная до семи символов, она стала бы «undefi».
assert.equal(describeBuild({ sha: 'undefined', date: null }), 'dev');
assert.equal(describeBuild({ sha: 'abc', date: null }), 'dev');

// Одна сборка не должна выглядеть двумя из-за регистра.
assert.equal(describeBuild({ sha: 'A1B2C3D4', date: null }), 'a1b2c3d');

// Сортируемость — то, ради чего дата впереди.
const days = ['2026.09.24', '2026.09.25', '2026.10.01'].map((date) =>
  describeBuild({ sha: 'a1b2c3d4', date })
);
assert.deepEqual([...days].sort(), days);

console.log('build-info: ok');
