import assert from 'node:assert/strict';
import {
  keepSecret,
  slotsLeft,
  sortKeys,
  statusOf,
  type ApiKeyView,
} from '../src/lib/api-keys';

const key = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: 'k1',
  name: 'CI релизов',
  webhookUrl: null,
  hint: 'v4c_abcd1234',
  createdAt: '2026-09-20T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

// Три состояния, а не два. «Ни разу не использован» — единственная
// подсказка человеку, что он сохранил ключ и забыл его куда-то
// вставить: с виду при этом всё в порядке.
assert.equal(statusOf(key()), 'unused');
assert.equal(
  statusOf(key({ lastUsedAt: '2026-09-21T10:00:00.000Z' })),
  'active'
);
assert.equal(
  statusOf(key({ revokedAt: '2026-09-22T10:00:00.000Z' })),
  'revoked'
);
// Отзыв сильнее использования: отозванный ключ не «работает».
assert.equal(
  statusOf(
    key({
      lastUsedAt: '2026-09-21T10:00:00.000Z',
      revokedAt: '2026-09-22T10:00:00.000Z',
    })
  ),
  'revoked'
);

// Живые сверху: список, где отозванный прошлогодний стоит над рабочим,
// заставляет искать глазами то, что и так на экране.
const sorted = sortKeys([
  key({
    id: 'old-revoked',
    createdAt: '2026-09-24T10:00:00.000Z',
    revokedAt: '2026-09-24T11:00:00.000Z',
  }),
  key({ id: 'older', createdAt: '2026-09-01T10:00:00.000Z' }),
  key({ id: 'newer', createdAt: '2026-09-23T10:00:00.000Z' }),
]);
assert.deepEqual(
  sorted.map((k) => k.id),
  ['newer', 'older', 'old-revoked']
);
// Исходный массив не переписан: он приходит из состояния запроса.
const input = [
  key({ id: 'a' }),
  key({ id: 'b', createdAt: '2026-09-25T10:00:00.000Z' }),
];
sortKeys(input);
assert.equal(input[0].id, 'a');

// Потолок считает ЖИВЫЕ: упереться в него из-за прошлогодних отзывов
// было бы странно.
assert.equal(slotsLeft([key(), key({ id: 'k2' })], 5), 3);
assert.equal(slotsLeft([key({ revokedAt: '2026-09-22T10:00:00.000Z' })], 5), 5);
assert.equal(slotsLeft([key(), key({ id: 'k2' })], 2), 0);
// Отрицательного остатка не бывает: сервер мог выдать больше потолка,
// а «-1 ключ» на экране объясняет человеку ровно ничего.
assert.equal(slotsLeft([key(), key({ id: 'k2' }), key({ id: 'k3' })], 2), 0);

// Секрет убирает только сам человек (аудит этапа 145). Перезагрузку
// списка запускает не он: отзыв соседнего ключа и «повторить» после
// сетевой осечки уносили единственную копию, за которую он ещё не
// успел взяться.
assert.equal(keepSecret('v4c_secret', 'issued'), 'v4c_secret');
assert.equal(keepSecret('v4c_secret', 'reloaded'), 'v4c_secret');
assert.equal(keepSecret('v4c_secret', 'dismissed'), null);

// Потолок приходит от сервера (аудит этапа 145). Пока список не
// загрузился, свободных слотов ноль — кнопка выключена: своей копии
// числа у экрана нет, и придумывать её на время загрузки значит
// вернуть ровно ту копию, от которой избавлялись.
assert.equal(slotsLeft([], 0), 0);
assert.equal(slotsLeft([], 5), 5);

console.log('api-keys: ok');
