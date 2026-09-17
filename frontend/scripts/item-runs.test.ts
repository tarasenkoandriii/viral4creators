/**
 * Прогоны генерации товара (Б-2.9, этап 121).
 *
 * Цена ошибки здесь — потерянный оплаченный ролик: незавершённый прогон
 * не показывает ни один список, и если не предложить его продолжить, он
 * уходит по TTL вместе с результатом.
 */
import assert from 'node:assert/strict';
import {
  isUnfinished,
  resumableRun,
  runState,
  sortRuns,
} from '../src/lib/item-runs';

const run = (over: Partial<Parameters<typeof runState>[0]> = {}) => ({
  sessionId: 's1',
  status: 'generating_video',
  createdAt: '2026-09-01T10:00:00.000Z',
  lastActivityAt: '2026-09-01T10:00:00.000Z',
  videoUrl: null as string | null,
  ...over,
});

// Готовность — по файлу, а не по статусу: постобработка могла дописать
// своё уже после того, как статус перестал меняться.
assert.equal(runState(run({ videoUrl: 'https://blob/v.mp4' })), 'done');
assert.equal(
  runState(run({ status: 'video_complete', videoUrl: null })),
  'stalled',
  'статус говорит «готово», а файла нет — это брошенный прогон, не готовый'
);
assert.equal(runState(run({ status: 'analyzing' })), 'running');
assert.equal(runState(run({ status: 'generating_video' })), 'running');
assert.equal(runState(run({ status: 'error' })), 'failed');
assert.equal(runState(run({ status: 'prompt_generated' })), 'stalled');
// Пустая сессия от случайного нажатия «Сделать ролик» — не прогон.
assert.equal(runState(run({ status: 'created' })), 'fresh');
assert.equal(
  isUnfinished(run({ status: 'created' })),
  false,
  'иначе диалог «вернуться к прогону» вылезал бы на КАЖДОЕ второе ' +
    'нажатие главной кнопки экрана и врал бы про потраченные деньги'
);
assert.equal(resumableRun([run({ status: 'created' })]), null);

assert.equal(isUnfinished(run({ videoUrl: 'https://blob/v.mp4' })), false);
assert.equal(isUnfinished(run({ status: 'error' })), true);

// Предлагаем продолжить самый свежий по ПОСЛЕДНЕЙ АКТИВНОСТИ: человек
// мог вернуться к старому прогону, и спорить с этим незачем.
{
  const older = run({
    sessionId: 'вернулись-к-нему',
    createdAt: '2026-09-01T10:00:00.000Z',
    lastActivityAt: '2026-09-03T09:00:00.000Z',
  });
  const newer = run({
    sessionId: 'брошен-давно',
    createdAt: '2026-09-02T10:00:00.000Z',
    lastActivityAt: '2026-09-02T10:05:00.000Z',
  });
  assert.equal(resumableRun([newer, older])?.sessionId, 'вернулись-к-нему');
}

// Готовые прогоны продолжать не предлагаем — их незачем продолжать.
assert.equal(resumableRun([run({ videoUrl: 'https://blob/v.mp4' })]), null);
assert.equal(resumableRun([]), null);
assert.equal(resumableRun(null), null);

// Битая дата не роняет выбор (и не выигрывает у настоящей).
{
  const broken = run({ sessionId: 'битая', lastActivityAt: 'не дата' });
  const good = run({
    sessionId: 'нормальная',
    lastActivityAt: '2026-09-02T10:00:00.000Z',
  });
  assert.equal(resumableRun([broken, good])?.sessionId, 'нормальная');
}

// Порядок показа — свежие сверху.
{
  const a = run({ sessionId: 'a', lastActivityAt: '2026-09-01T10:00:00.000Z' });
  const b = run({ sessionId: 'b', lastActivityAt: '2026-09-05T10:00:00.000Z' });
  const source = [a, b];
  assert.deepEqual(
    sortRuns(source).map((r) => r.sessionId),
    ['b', 'a']
  );
  assert.deepEqual(
    source.map((r) => r.sessionId),
    ['a', 'b'],
    'исходный список не мутируется'
  );
}

console.log('item-runs: 18 cases ok');
