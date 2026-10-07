// Помощники карточки «Обучалка по сайту: выключатель и суточные потолки».
// Запуск (из admin/): npm test — или один файл: npx tsx src/lib/site-tutorial-settings.test.ts
import assert from 'node:assert/strict';
import { capSummary, parseCapField, siteTutorialChanges, siteTutorialDraft } from './site-tutorial-settings';
import type { SiteTutorialSettingsView } from './types';

const cap = (over: Partial<SiteTutorialSettingsView['rounds']> = {}): SiteTutorialSettingsView['rounds'] => ({
  value: 5000,
  stored: null,
  defaultValue: 5000,
  source: 'default',
  usedToday: 120,
  updatedAt: null,
  updatedBy: null,
  ...over,
});
const view = (over: Partial<SiteTutorialSettingsView> = {}): SiteTutorialSettingsView => ({
  paused: false,
  pausedUpdatedAt: null,
  pausedUpdatedBy: null,
  rounds: cap(),
  liveSessions: cap({ value: 300, defaultValue: 300, usedToday: 3 }),
  day: '2026-10-07',
  cacheSeconds: 15,
  ...over,
});

// Поле: пусто — умолчание; 0, дробь, минус, сверх миллиона — негодно.
assert.equal(parseCapField(''), null);
assert.equal(parseCapField('  '), null);
assert.equal(parseCapField('250'), 250);
assert.equal(parseCapField('1000000'), 1_000_000);
for (const bad of ['0', '-1', '2.5', '1e3', '1000001', 'abc']) assert.equal(parseCapField(bad), undefined, bad);

// Черновик: незаданный потолок — пустое поле, заданный — число.
assert.deepEqual(siteTutorialDraft(view({ rounds: cap({ stored: 40, value: 40, source: 'admin' }) })), {
  paused: false,
  rounds: '40',
  liveSessions: '',
});

// Изменения: только изменившееся; очистка поля — null (вернуть умолчание).
const s = view({ rounds: cap({ stored: 40, value: 40, source: 'admin' }) });
assert.deepEqual(siteTutorialChanges(s, { paused: false, rounds: '40', liveSessions: '' }), { input: {}, error: null });
assert.deepEqual(siteTutorialChanges(s, { paused: true, rounds: '', liveSessions: '17' }), {
  input: { paused: true, roundsPerDay: null, liveSessionsPerDay: 17 },
  error: null,
});
const bad = siteTutorialChanges(s, { paused: true, rounds: '0', liveSessions: '17' });
assert.deepEqual(bad.input, {});
assert.match(bad.error ?? '', /выключателем/);

// Сводка: источник, расход, остаток / выбранный потолок / непрочитанный расход.
assert.match(capSummary(cap()), /умолчание кода.*сегодня 120.*осталось 4\s880/);
assert.match(capSummary(cap({ usedToday: 5000 })), /потолок выбран/);
assert.match(capSummary(cap({ usedToday: null })), /не прочитан/);
assert.match(capSummary(cap({ source: 'admin', stored: 10, value: 10, usedToday: 1 })), /задано здесь\) · умолчание 5\s000/);

console.log('site-tutorial-settings.test.ts: ok');
