/**
 * Приписка к строке «Формат: X» — регрессия на «обрезано из .» с пустым
 * форматом (сквозной аудит 28.09.2026, находка Д-4).
 */
import assert from 'node:assert/strict';
import { aspectRatioNote } from '../src/lib/aspect-ratio';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('aspect-ratio-note');

it('ЭТО И БЫЛА ОШИБКА: постобработка прошла, исходный формат не записан — приписки нет', () => {
  // Ровно состояние ролика Grok в родном формате: `renderedAspectRatio`
  // пишется только когда нужна обрезка, а постобработка (озвучка,
  // субтитры) всё равно доходит до complete.
  assert.deepEqual(
    aspectRatioNote({ aspectRatio: '9:16', postStatus: 'complete' }),
    { kind: 'none' }
  );
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: null,
      postStatus: 'complete',
    }),
    { kind: 'none' }
  );
});

it('пустая строка формата — это «не знаем», а не формат', () => {
  // Тип говорит '16:9' | '9:16' | undefined, но сюда приходит разобранный
  // JSON из базы: пустая строка в колонке дала бы ровно ту же приписку
  // «обрезано из .», ради которой всё это и правится.
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '',
      postStatus: 'complete',
    }),
    { kind: 'none' }
  );
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '',
      postStatus: 'failed',
    }),
    { kind: 'postFailedNoSource' }
  );
});

it('обрезка и правда была — говорим, из чего обрезали', () => {
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '16:9',
      postStatus: 'complete',
    }),
    { kind: 'croppedFrom', rendered: '16:9' }
  );
});

it('форматы совпали — обрезки не было, молчим', () => {
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '9:16',
      postStatus: 'complete',
    }),
    { kind: 'none' }
  );
});

it('обрезка идёт — обещание с обоими форматами', () => {
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '16:9',
      postStatus: 'pending',
      reframePending: true,
    }),
    { kind: 'reframePending', rendered: '16:9', target: '9:16' }
  );
});

it('pending без обрезки — приписки нет (ждём озвучку, а не кадр)', () => {
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '16:9',
      postStatus: 'pending',
      reframePending: false,
    }),
    { kind: 'none' }
  );
});

it('провал: исходный формат известен — полная формулировка', () => {
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '16:9',
      postStatus: 'failed',
    }),
    { kind: 'postFailed', rendered: '16:9' }
  );
});

it('провал без исходного формата — всё равно сообщаем о провале, но без «снято в »', () => {
  // Единственный исход, где незнание исходного формата НЕ повод
  // молчать: человеку нужен факт «скачивается исходный файл».
  assert.deepEqual(
    aspectRatioNote({ aspectRatio: '9:16', postStatus: 'failed' }),
    { kind: 'postFailedNoSource' }
  );
});

it('обрезка не подключена на стенде — приписка только когда знаем исходный формат', () => {
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      renderedAspectRatio: '16:9',
      postStatus: 'skipped',
      reframePending: true,
    }),
    { kind: 'reframeSkipped', rendered: '16:9', target: '9:16' }
  );
  assert.deepEqual(
    aspectRatioNote({
      aspectRatio: '9:16',
      postStatus: 'skipped',
      reframePending: true,
    }),
    { kind: 'none' }
  );
});

it('целевого формата нет вовсе — строки «Формат:» не будет, приписки тем более', () => {
  assert.deepEqual(aspectRatioNote({ postStatus: 'failed' }), { kind: 'none' });
});

console.log(`\n${passed} проверок пройдено`);
