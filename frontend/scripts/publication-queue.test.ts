/**
 * Очередь публикации (Б-2.6, этап 121).
 *
 * Проверяется одно: правило экрана совпадает с инвариантом сервера.
 * Расхождение стоило пользователю тупика — кнопка звала, сервер отвечал
 * 409 про заявку, которой на экране не было и которую нельзя отозвать.
 */
import assert from 'node:assert/strict';
import {
  blockingRequest,
  isForOtherVideo,
  queueState,
} from '../src/lib/publication-queue';

const req = (over: Partial<Parameters<typeof isForOtherVideo>[0]> = {}) => ({
  id: 'r1',
  platform: 'YOUTUBE',
  status: 'PENDING',
  generatedVideoId: 'v1',
  ...over,
});

// Занятость очереди — по сессии и площадке, как на сервере.
{
  const requests = [req({ generatedVideoId: 'старый' })];
  assert.equal(
    blockingRequest(requests, 'YOUTUBE')?.id,
    'r1',
    'заявка на прежнюю версию ролика всё равно занимает очередь: ' +
      'сервер не смотрит на generatedVideoId вовсе'
  );
  assert.equal(blockingRequest(requests, 'TIKTOK'), null);
}

// Закрытые статусы очередь не держат.
for (const status of ['REJECTED', 'PUBLISHED', 'FAILED']) {
  assert.equal(blockingRequest([req({ status })], 'YOUTUBE'), null, status);
}
for (const status of ['PENDING', 'APPROVED']) {
  assert.ok(blockingRequest([req({ status })], 'YOUTUBE'), status);
}

// Заявка на прежнюю версию — это отдельный разговор с человеком.
{
  const state = queueState(
    [req({ generatedVideoId: 'старый' })],
    'YOUTUBE',
    'новый'
  );
  assert.equal(state.kind, 'blocked-by-other');
  assert.equal(
    state.withdrawable,
    true,
    'PENDING отзывается самим человеком — ему и надо это предложить'
  );
}

// Одобренную оператором отозвать уже нельзя: совет «отзовите» был бы
// издевательством, поэтому признак отдельный.
{
  const state = queueState(
    [req({ status: 'APPROVED', generatedVideoId: 'старый' })],
    'YOUTUBE',
    'новый'
  );
  assert.equal(state.kind, 'blocked-by-other');
  assert.equal(state.withdrawable, false);
}

// Заявка на ТОТ ЖЕ ролик — обычное «уже в очереди».
{
  const state = queueState([req()], 'YOUTUBE', 'v1');
  assert.equal(state.kind, 'blocked');
}

// Пустая очередь и отсутствующий список.
assert.equal(queueState([], 'YOUTUBE', 'v1').kind, 'free');
assert.equal(queueState(null, 'YOUTUBE', 'v1').kind, 'free');
assert.equal(queueState(undefined, 'YOUTUBE', null).kind, 'free');

// Старая заявка без записанного ролика — не «чужая»: иначе человек
// увидел бы «прежняя версия» у заявки на тот самый ролик.
assert.equal(isForOtherVideo(req({ generatedVideoId: null }), 'v1'), false);
assert.equal(isForOtherVideo(req(), null), false);
assert.equal(isForOtherVideo(req({ generatedVideoId: 'другой' }), 'v1'), true);

console.log('publication-queue: 9 cases ok');
