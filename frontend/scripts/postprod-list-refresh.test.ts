/**
 * Фоновое обновление списка постпрода (автообновление статуса,
 * 27.09.2026): бейдж «Обрабатывается» должен уходить сам.
 *
 * Проверяется ровно то, что легко сломать: обновление не должно
 * менять состав и порядок списка — иначе поедет пагинация со
 * смещением (см. `loadMore` в PostprodScreen).
 */
import assert from 'node:assert/strict';
import {
  isPostProductionPending,
  mergeVideoStatuses,
} from '../src/lib/video-polling';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('postprod-list-refresh');

it('статус показанной строки обновляется', () => {
  const shown = [
    { sessionId: 'a', postStatus: 'pending' as const },
    { sessionId: 'b', postStatus: 'complete' as const },
  ];
  const fresh = [
    { sessionId: 'a', postStatus: 'complete' as const },
    { sessionId: 'b', postStatus: 'complete' as const },
  ];

  const merged = mergeVideoStatuses(shown, fresh);

  assert.equal(merged[0].postStatus, 'complete');
  assert.equal(merged.length, 2);
});

it('новые ролики в список НЕ добавляются — иначе поедет пагинация', () => {
  const shown = [{ sessionId: 'a', postStatus: 'pending' as const }];
  const fresh = [
    { sessionId: 'new', postStatus: 'complete' as const },
    { sessionId: 'a', postStatus: 'complete' as const },
  ];

  const merged = mergeVideoStatuses(shown, fresh);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].sessionId, 'a');
});

it('порядок сохраняется, даже если свежий ответ пришёл в другом', () => {
  const shown = [
    { sessionId: 'a', postStatus: 'pending' as const },
    { sessionId: 'b', postStatus: 'pending' as const },
  ];
  const fresh = [
    { sessionId: 'b', postStatus: 'complete' as const },
    { sessionId: 'a', postStatus: 'complete' as const },
  ];

  const merged = mergeVideoStatuses(shown, fresh);

  assert.deepEqual(
    merged.map((m) => m.sessionId),
    ['a', 'b']
  );
});

it('строка, которой нет в свежем ответе, остаётся как была', () => {
  // Она могла уехать на вторую страницу — это не повод её стирать.
  const shown = [
    { sessionId: 'a', postStatus: 'pending' as const },
    { sessionId: 'old', postStatus: 'complete' as const },
  ];

  const merged = mergeVideoStatuses(shown, [
    { sessionId: 'a', postStatus: 'complete' as const },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[1].sessionId, 'old');
});

it('пустой свежий ответ ничего не портит', () => {
  const shown = [{ sessionId: 'a', postStatus: 'pending' as const }];
  assert.deepEqual(mergeVideoStatuses(shown, []), shown);
});

it('опрашивать стоит, пока хоть одна строка в обработке', () => {
  const items = [
    { postStatus: 'complete' as const },
    { postStatus: 'pending' as const },
  ];
  assert.equal(items.some(isPostProductionPending), true);
  assert.equal(
    [{ postStatus: 'complete' as const }].some(isPostProductionPending),
    false
  );
});

console.log(`postprod-list-refresh: ok (${passed} проверок)`);
