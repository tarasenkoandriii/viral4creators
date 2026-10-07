// Помощники блока «Я в кадре: отметка „младше 18“» карточки пользователя (В-4).
// Запуск (из admin/): npm test — или один файл: npx tsx src/lib/persona-age.test.ts
import assert from 'node:assert/strict';
import {
  canClearAgeMark,
  checkClearReason,
  clearConfirmText,
  personaAgeSummary,
  refusalsText,
} from './persona-age';
import type { PersonaAgeState } from './types';

const persona = (over: Partial<NonNullable<PersonaAgeState['persona']>> = {}): PersonaAgeState['persona'] => ({
  id: 'p1',
  under18: true,
  markedAt: '2026-10-01T10:00:00.000Z',
  refusals: ['under-18'],
  verified: false,
  deletePending: false,
  filesPending: false,
  consentGivenAt: '2026-10-01T09:59:00.000Z',
  ...over,
});
const state = (p: PersonaAgeState['persona'], enabled = true): PersonaAgeState => ({
  userId: 'u1',
  personaEnabled: enabled,
  persona: p,
  clears: [],
});

// Причина: обрезка как на сервере, границы 3 и 500 включительно.
assert.deepEqual(checkClearReason('  abc  '), { ok: true, reason: 'abc' });
assert.equal(checkClearReason(' ab ').ok, false);
assert.equal(checkClearReason('').ok, false);
assert.equal(checkClearReason('x'.repeat(500)).ok, true);
assert.equal(checkClearReason('x'.repeat(501)).ok, false);
assert.equal(checkClearReason(`  ${'x'.repeat(500)}  `).ok, true, 'пробелы по краям не в счёт');

// Снять можно только стоящую отметку.
assert.equal(canClearAgeMark(state(persona())), true);
assert.equal(canClearAgeMark(state(persona({ under18: false, refusals: null }))), false);
assert.equal(canClearAgeMark(state(null)), false);
assert.equal(canClearAgeMark(null), false);

// Строка состояния.
assert.equal(personaAgeSummary(state(persona())).tone, 'critical');
assert.match(personaAgeSummary(state(persona({ filesPending: true }))).text, /удаляются/);
assert.equal(personaAgeSummary(state(null)).tone, 'muted');
assert.equal(personaAgeSummary(state(persona({ under18: false, verified: true }))).tone, 'ok');
assert.equal(personaAgeSummary(state(persona({ under18: false, deletePending: true }))).tone, 'warning');
assert.equal(personaAgeSummary(null).tone, 'muted');

assert.equal(refusalsText(['under-18', 'poor-quality']), 'младше 18 по оценке ИИ, плохое качество');
assert.equal(refusalsText(['new-code']), 'new-code', 'незнакомый код — как есть');
assert.equal(refusalsText(null), '—');

// Подтверждение: говорит, что режим не включается, и про рубильник — когда он выключен.
const on = clearConfirmText('@ivan', true);
assert.match(on, /НЕ включает/);
assert.doesNotMatch(on, /PERSONA_ENABLED/);
assert.match(clearConfirmText('@ivan', false), /PERSONA_ENABLED/);

console.log('persona-age.test.ts: ok');
