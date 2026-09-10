/**
 * Опрос статуса ролика (§15.4/§16.1, этап 37) — регрессия на находку,
 * из-за которой обрезка и озвучка оплачивались, а до пользователя не
 * доходили.
 */
import assert from 'node:assert/strict';
import {
  isPostProductionPending,
  isVideoReady,
  shouldKeepPolling,
} from '../src/lib/video-polling';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('video-polling (ТЗ §15.4/§16.1)');

it('пока Veo рендерит — опрашиваем', () => {
  assert.equal(shouldKeepPolling({ status: 'processing' }), true);
  assert.equal(shouldKeepPolling({ status: 'pending' }), true);
  assert.equal(shouldKeepPolling(null), true);
});

it('готовый ролик НЕ конец опроса, пока идёт постобработка', () => {
  // Ровно эта строка и была ошибкой: опрос гас здесь, обрезка и озвучка
  // оплачивались, готовый файл ложился в Blob и не доходил никогда.
  assert.equal(
    shouldKeepPolling({ status: 'complete', postStatus: 'pending' }),
    true
  );
});

it('постобработка завершилась — опрашивать нечего', () => {
  for (const postStatus of ['complete', 'failed', 'skipped'] as const) {
    assert.equal(
      shouldKeepPolling({ status: 'complete', postStatus }),
      false,
      postStatus
    );
  }
  // Сессия до этапа 34: поля postStatus нет вовсе.
  assert.equal(shouldKeepPolling({ status: 'complete' }), false);
});

it('провал рендера — конец: постобработке нечего обрабатывать', () => {
  assert.equal(shouldKeepPolling({ status: 'failed' }), false);
  assert.equal(
    shouldKeepPolling({ status: 'failed', postStatus: 'pending' }),
    false
  );
});

it('ролик показывается сразу, не дожидаясь постобработки', () => {
  assert.equal(
    isVideoReady({ status: 'complete', postStatus: 'pending' }),
    true
  );
  assert.equal(isVideoReady({ status: 'processing' }), false);
  assert.equal(isVideoReady(null), false);
});

it('идущая постобработка узнаётся отдельно от готовности ролика', () => {
  assert.equal(isPostProductionPending({ postStatus: 'pending' }), true);
  assert.equal(isPostProductionPending({ postStatus: 'skipped' }), false);
  assert.equal(isPostProductionPending({}), false);
});

console.log(`\n${passed} проверок пройдено`);
