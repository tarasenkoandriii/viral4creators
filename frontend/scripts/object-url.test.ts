/**
 * Отзыв `blob:`-ссылок (этап 119, хвост В-5.18…В-5.23).
 *
 * Важна ровно одна тонкость: в тех же самых полях состояния лежат и
 * обычные ссылки — фото товара с сервера, восстановленный снимок
 * сессии. Отзывать их нельзя (а безусловный `revokeObjectURL` от чужого
 * адреса молча ничего не делает, то есть ошибку в логике не покажет).
 */
import assert from 'node:assert/strict';
import { revokeObjectUrl } from '../src/lib/object-url';

const revoked: string[] = [];
(globalThis as unknown as { URL: { revokeObjectURL(u: string): void } }).URL = {
  ...URL,
  revokeObjectURL: (u: string) => revoked.push(u),
} as never;

revokeObjectUrl('blob:https://app.example/9f1c-1');
assert.deepEqual(revoked, ['blob:https://app.example/9f1c-1']);

// Ссылка на файл в хранилище — не наша, отзывать нечего.
revokeObjectUrl('https://blob.vercel-storage.com/items/photo.jpg');
// Пустое состояние — обычное дело: шаг открыт, файл ещё не выбран.
revokeObjectUrl(null);
revokeObjectUrl(undefined);
revokeObjectUrl('');
assert.deepEqual(
  revoked,
  ['blob:https://app.example/9f1c-1'],
  'отозвана должна быть только blob:-ссылка'
);

// Данные в строке (`data:`) тоже не объектная ссылка.
revokeObjectUrl('data:image/png;base64,iVBORw0KGgo=');
assert.equal(revoked.length, 1);

console.log('object-url: 6 cases ok');
