/**
 * Правило ветвления экрана одного ролика — регрессия на промигивание
 * «Ролик не найден» (27.09.2026).
 */
import assert from 'node:assert/strict';
import { postprodViewState } from '../src/lib/video-polling';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const base = {
  loading: false,
  error: null as unknown,
  requestedId: 'a',
  loadedId: 'a',
  hasVideo: true,
};

console.log('postprod-view-state');

it('данные загружены и ролик есть — показываем ролик', () => {
  assert.equal(postprodViewState(base), 'ready');
});

it('ЭТО И БЫЛА ОШИБКА: данных для запрошенной сессии ещё нет — спиннер, не «не найден»', () => {
  // Кадр между сменой sessionId и стартом эффекта: loading ещё false
  // от прошлой загрузки, данных уже/ещё нет.
  assert.equal(
    postprodViewState({ ...base, loadedId: null, hasVideo: false }),
    'loading'
  );
  // И тот же кадр, когда в состоянии остался ПРЕДЫДУЩИЙ ролик:
  // показывать чужой ролик под новым адресом нельзя.
  assert.equal(
    postprodViewState({ ...base, requestedId: 'b', loadedId: 'a' }),
    'loading'
  );
});

it('загрузили и ролика правда нет — «не найден»', () => {
  assert.equal(postprodViewState({ ...base, hasVideo: false }), 'empty');
});

it('ошибка перевешивает «ещё не загрузили» — иначе спиннер навсегда', () => {
  assert.equal(
    postprodViewState({
      ...base,
      error: new Error('сеть'),
      loadedId: null,
      hasVideo: false,
    }),
    'error'
  );
});

it('пока грузим — спиннер, даже если в состоянии остался старый ролик', () => {
  assert.equal(postprodViewState({ ...base, loading: true }), 'loading');
});

console.log(`postprod-view-state: ok (${passed} проверок)`);
