/**
 * Логика экранов Э3 (T): права на экранах (оператор не видит статистику и
 * денег, проверенные ответы — без кнопок публикации), кнопки передачи,
 * опросы, период и числа, слова атрибуции §5-тер.2 во всех словарях,
 * участники и роли (кит).
 */
import assert from 'node:assert/strict';
import type { AccountMember } from '../src/kit';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';
import {
  MEMBER_ERROR_CODES,
  memberActions,
  memberRolePatch,
} from '../src/kit/invite';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import {
  canManageMembers,
  canManageSecrets,
  canResolveLearning,
  canSeeStats,
  delta,
  dialogViews,
  handoffActions,
  hasAssist,
  learningTabs,
  pct,
  periodOf,
  pickedDetector,
  pickerShouldPoll,
  shouldPollDialog,
  templateDetectors,
  usd,
} from '../src/lib/e3-view';
import { GOAL_TEMPLATES } from '../src/lib/stats-types';

const member = (
  role: AccountMember['role'],
  assist: AccountMember['productRoles']['assist'],
  telegramId = '1',
  memberId = ''
): AccountMember => ({
  memberId,
  telegramId,
  role,
  productRoles: { qa: 'none', assist, assistAdmin: 'none' },
});
const owner = member('owner', 'manager', '1', 'm-owner');
const manager = member('manager', 'manager', '2', 'm-man');
const operator = member('operator', 'operator', '3', 'm-op');
const managerNoAssist = member('manager', 'none', '4');
// Роль кабинета «оператор» с правом продукта manager — всё равно оператор.
const operatorWithManagerRole = member('operator', 'manager', '5');

// ═══ Права на экранах ════════════════════════════════════════════════
assert.equal(canSeeStats(owner), true);
assert.equal(canSeeStats(manager), true);
assert.equal(
  canSeeStats(operator),
  false,
  'оператор не видит статистику и денег'
);
assert.equal(canSeeStats(operatorWithManagerRole), false);
assert.equal(canSeeStats(managerNoAssist), false);
assert.equal(canResolveLearning(operator), false, 'оператор — без публикации');
assert.equal(canResolveLearning(manager), true);
assert.deepEqual(
  learningTabs(operator),
  ['queue'],
  'проверенные ответы и качество — не оператору'
);
assert.deepEqual(learningTabs(manager), ['queue', 'golden', 'quality']);
assert.deepEqual(
  dialogViews(operator),
  ['handoff', 'mine'],
  '«Все» оператору — 403 на сервере'
);
assert.deepEqual(dialogViews(owner), ['handoff', 'mine', 'all']);
assert.equal(hasAssist(managerNoAssist), false);
assert.equal(hasAssist(operator), true);
assert.equal(canManageSecrets(manager), false, 'секреты — только владелец');
assert.equal(canManageSecrets(owner), true);
assert.equal(canManageMembers(manager), false);

// ═══ Кнопки передачи ═════════════════════════════════════════════════
const st = (
  state: 'waiting' | 'active' | 'closed' | 'missed' | 'cancelled',
  mine = false
) => ({
  state,
  assignedToMe: mine,
});
assert.deepEqual(handoffActions(st('waiting'), operator), {
  take: true,
  reply: false,
  draft: false,
  close: false,
});
assert.deepEqual(handoffActions(st('waiting'), manager), {
  take: true,
  reply: false,
  draft: false,
  close: true,
});
assert.deepEqual(handoffActions(st('active', true), operator), {
  take: false,
  reply: true,
  draft: true,
  close: true,
});
assert.deepEqual(
  handoffActions(st('active', false), operator),
  { take: false, reply: false, draft: false, close: false },
  'чужую передачу оператор не трогает'
);
assert.equal(handoffActions(st('active', false), manager).close, true);
for (const s of ['closed', 'missed', 'cancelled'] as const) {
  assert.deepEqual(handoffActions(st(s, true), owner), {
    take: false,
    reply: false,
    draft: false,
    close: false,
  });
}
assert.equal(handoffActions(null, owner).take, false);
assert.equal(handoffActions(st('waiting'), managerNoAssist).take, false);
assert.equal(shouldPollDialog(st('waiting')), true);
assert.equal(shouldPollDialog(st('active')), true);
assert.equal(shouldPollDialog(st('closed')), false);
assert.equal(shouldPollDialog(null), false);

// ═══ Период и числа ══════════════════════════════════════════════════
// 23:30 UTC 30 сентября — в Киеве уже 1 октября: период по поясу сайта.
const now = new Date('2026-09-30T23:30:00Z');
assert.deepEqual(periodOf(7, now, 'Europe/Kyiv'), {
  from: '2026-09-25',
  to: '2026-10-01',
});
assert.deepEqual(periodOf(7, now, 'UTC'), {
  from: '2026-09-24',
  to: '2026-09-30',
});
assert.deepEqual(periodOf(30, now, 'Bad/Zone'), {
  from: '2026-09-01',
  to: '2026-09-30',
});
assert.equal(pct(0.426), '43 %');
assert.equal(pct(0.054), '5.4 %');
assert.equal(pct(null), '—');
assert.equal(usd(1234), '$0.0012');
assert.equal(usd(12_340_000), '$12.34');
assert.deepEqual(delta({ value: 1, prev: 1, deltaPct: 12.4, noise: false }), {
  text: '+12 %',
  tone: 'up',
});
assert.deepEqual(delta({ value: 1, prev: 1, deltaPct: -3, noise: true }), {
  text: '−3 %',
  tone: 'down',
});
assert.equal(delta({ value: 1, prev: 0, deltaPct: null, noise: null }), null);

// Шаблон цели → детекторы: у каждого шаблона хотя бы один.
for (const t of GOAL_TEMPLATES) assert.ok(templateDetectors(t).length > 0, t);
assert.deepEqual(templateDetectors('lead'), [
  { kind: 'builtin', config: { event: 'lead' } },
]);
assert.deepEqual(templateDetectors('call'), [
  { kind: 'click', config: { auto: 'tel' } },
]);

// ═══ Выбор цели на сайте — TMA-часть §5-тер.16 п.6 ════════════════════
const desc = {
  assistGoal: null,
  assistId: null,
  role: 'button',
  text: 'Купить',
  tag: 'button',
};
assert.equal(pickerShouldPoll(null, null), false, 'нет ссылки — не опрашиваем');
assert.equal(pickerShouldPoll('t1', null), true);
assert.equal(pickerShouldPoll('t1', { status: 'waiting', result: null }), true);
assert.equal(
  pickerShouldPoll('t1', { status: 'expired', result: null }),
  false
);
assert.equal(
  pickerShouldPoll('t1', {
    status: 'picked',
    result: { descriptor: desc, path: '/', label: 'x', kind: 'click' },
  }),
  false
);
assert.deepEqual(
  pickedDetector({
    status: 'picked',
    result: { descriptor: desc, path: '/cart', label: 'Купить', kind: 'click' },
  }),
  { kind: 'click', config: { descriptor: desc, pathMask: '/cart' } }
);
assert.deepEqual(
  pickedDetector({
    status: 'picked',
    result: {
      descriptor: { ...desc, tag: 'form' },
      path: '',
      label: 'Форма',
      kind: 'form_submit',
    },
  }),
  {
    kind: 'form_submit',
    config: { descriptor: { ...desc, tag: 'form' }, pathMask: null },
  }
);
for (const tag of ['input', 'TEXTAREA', 'select']) {
  assert.equal(
    pickedDetector({
      status: 'picked',
      result: {
        descriptor: { ...desc, tag },
        path: '/',
        label: 'x',
        kind: 'click',
      },
    }),
    null,
    `поле ввода (${tag}) целью не становится`
  );
}
assert.equal(pickedDetector({ status: 'waiting', result: null }), null);

// ═══ Слова атрибуции (§5-тер.2) во всех словарях ═════════════════════
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}
const all = (d: unknown) => strings(d).join('\n');
const ruText = all(appRu);
const ukText = all(appUk);
const enText = all(appEn);
assert.equal(appRu.e3.stats.attribution.direct, 'помощник довёл');
assert.equal(
  appRu.e3.stats.attribution.assisted,
  'с участием помощника (не обязательно благодаря)'
);
// «благодаря» — только в оговорке «не обязательно благодаря».
assert.equal(
  (ruText.match(/благодаря/gi) ?? []).length,
  (ruText.match(/не обязательно благодаря/gi) ?? []).length
);
assert.equal(
  (ukText.match(/завдяки/gi) ?? []).length,
  (ukText.match(/не обов’язково завдяки/gi) ?? []).length
);
assert.equal(
  (enText.match(/because of it/gi) ?? []).length,
  (enText.match(/not necessarily because of it/gi) ?? []).length
);
assert.ok(!/thanks to/i.test(appEn.e3.stats.attribution.assisted));
for (const [lang, text] of [
  ['ru', ruText],
  ['uk', ukText],
  ['en', enText],
] as const) {
  assert.ok(
    !/окупаем|окупн|окупн|payback|\bROI\b/i.test(text),
    `${lang}: «окупаемость» в Э3 запрещена`
  );
}

// ═══ Участники и роли (кит) ══════════════════════════════════════════
assert.deepEqual(memberActions(owner, manager), {
  changeRole: true,
  remove: true,
  leave: false,
});
assert.deepEqual(memberActions(owner, owner), {
  changeRole: false,
  remove: false,
  leave: false,
});
assert.deepEqual(
  memberActions(owner, member('owner', 'manager', '9', 'm9')),
  { changeRole: false, remove: false, leave: false },
  'владельца не понизить и не удалить'
);
assert.deepEqual(memberActions(manager, operator), {
  changeRole: false,
  remove: false,
  leave: false,
});
assert.deepEqual(memberActions(operator, operator), {
  changeRole: false,
  remove: false,
  leave: true,
});
assert.deepEqual(
  memberActions(owner, member('operator', 'operator', '7')),
  { changeRole: false, remove: false, leave: false },
  'memberId не прошёл проверку сегмента пути — ничего'
);
assert.deepEqual(memberRolePatch('assist', 'manager', 'none'), {
  role: 'manager',
  productRoles: { assist: 'manager', assistAdmin: 'none' },
});
assert.deepEqual(memberRolePatch('qa', 'operator', 'none'), {
  role: 'operator',
  productRoles: { qa: 'viewer' },
});
for (const d of [uk, ru, en]) {
  assert.deepEqual(
    Object.keys(d.members.errors).sort(),
    [...MEMBER_ERROR_CODES].sort()
  );
  assert.ok(d.invite.managerSeesAll.length > 20);
}

console.log('e3-view: ok');
