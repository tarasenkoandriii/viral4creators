/**
 * Э8: клиент «Админки: действия» — строгий разбор карточки (неизвестный
 * статус → «expired», лишнего нет, хеш — только hex-64), адреса маршрутов
 * (§4.16: admin-chat/proposals, action-log, admin-mode/memos, signing-secret)
 * и тексты без «откатил/отменил» (§5-бис.15 п.10).
 */
import assert from 'node:assert/strict';
import {
  createAdminActionsApi,
  parseMemo,
  parseProposal,
  retryExpired,
} from '../src/lib/admin-actions-api';
import { ADMIN_ACTIONS_TEXTS } from '../src/i18n/admin-actions';
import { ADMIN_MEMO_CHECK_TEXTS } from '../src/i18n/admin-memo-check';
import { parseCheckToken } from '../src/lib/admin-memo-check';

const p = parseProposal({
  id: 'p1',
  status: 'hacked',
  kind: 'nope',
  title: 'Змінити статус',
  fields: [
    { name: 'status', before: 'paid', after: 'shipped' },
    { name: 'ids', after: ['1', 2, '3'] },
    { name: 'x', after: { $ne: 1 } },
  ],
  paramsHash: 'not-hex',
  params: { secret: 'LEAK' },
  memo: { step: 1 },
});
assert.equal(p.status, 'expired');
assert.equal(p.kind, 'write');
assert.equal(p.paramsHash, '');
assert.deepEqual(p.fields[0], {
  name: 'status',
  before: 'paid',
  after: 'shipped',
});
assert.deepEqual(p.fields[1].after, ['1', '3']);
assert.equal(p.fields[2].after, '');
assert.equal(p.memoStep, 1);
assert.equal(JSON.stringify(p).includes('LEAK'), false);

const m = parseMemo({
  number: 3,
  status: 'held',
  versions: [
    {
      number: 1,
      status: 'held',
      gateReport: {
        problems: [{ path: 'steps', code: 'empty' }],
        kinds: ['read'],
      },
    },
  ],
});
assert.equal(m.number, 3);
assert.deepEqual(m.versions[0].problems, [{ path: 'steps', code: 'empty' }]);
assert.equal(m.versions[0].check, null);
assert.equal(m.reviewReason, null);
assert.equal(m.stats.runs, 0);
assert.equal(m.stats.goalRate, null);

// Аудит 06.10: «требует проверки», статистика и итог прогона — строго.
const r = parseMemo({
  number: 4,
  status: 'needs_review',
  reviewReason: { code: 'failures', step: 2, employees: 3, version: 1 },
  stats: {
    days: 30,
    runs: 12,
    reached: 6,
    goalRate: 7,
    failures: [{ step: 2, n: 4, employees: 3, pin: 'yes' }],
    slots: { order: '1042' },
  },
  stats7: { days: 7, runs: 5, goalRate: 0.4 },
  versions: [
    {
      number: 2,
      status: 'checking',
      checkReport: {
        kind: 'memo-check',
        result: 'partial',
        steps: [
          { i: 0, ok: true },
          { i: 2, ok: false, problem: 'forbidden' },
        ],
        phraseConflicts: [{ lang: 'uk', phrase: 'x' }],
        pages: ['/admin/orders'],
        inherited: 1,
      },
    },
    { number: 1, status: 'held', checkReport: { result: 'pass' } },
  ],
});
assert.deepEqual(r.reviewReason, {
  code: 'failures',
  step: 2,
  version: 1,
  employees: 3,
  runs: null,
  reached: null,
  at: '',
});
assert.equal(r.stats.goalRate, null, 'доля вне 0..1 — нет');
assert.deepEqual(r.stats.failures, [
  { step: 2, n: 4, employees: 3, pin: false },
]);
assert.equal(JSON.stringify(r).includes('1042'), false, 'значений слотов нет');
assert.equal(r.stats7.goalRate, 0.4);
assert.deepEqual(r.versions[0].check, {
  result: 'partial',
  problems: [{ step: 3, code: 'forbidden' }],
  goal: '',
  phraseConflicts: 1,
  pages: ['/admin/orders'],
  at: '',
  inherited: 1,
});
assert.equal(r.versions[1].check, null, 'чужой формат отчёта — нет');
assert.equal(parseMemo({ reviewReason: { code: 'hack' } }).reviewReason, null);
assert.equal(parseCheckToken({ url: 'javascript:alert(1)' }).url, '');
assert.equal(
  parseCheckToken({ url: 'https://admin.shop.test/?v4c_voicetest=t' }).url,
  'https://admin.shop.test/?v4c_voicetest=t'
);
// Тексты прогона — одинаковые ключи на трёх языках.
const keysOf = (o: object): string[] =>
  Object.entries(o)
    .flatMap(([k, v]) =>
      v && typeof v === 'object' ? keysOf(v).map((x) => `${k}.${x}`) : [k]
    )
    .sort();
const ukKeys = keysOf(ADMIN_MEMO_CHECK_TEXTS.uk);
for (const l of ['ru', 'en'] as const)
  assert.deepEqual(keysOf(ADMIN_MEMO_CHECK_TEXTS[l]), ukKeys, l);
for (const l of ['uk', 'ru', 'en'] as const)
  assert.ok(ADMIN_ACTIONS_TEXTS[l].memo.statuses.needs_review, l);

const calls: Array<[string, string, unknown]> = [];
const api = createAdminActionsApi({
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return (path.includes('/action-log/proposals') ? [] : {}) as T;
  },
});
await api.confirm(
  's1',
  'p1',
  { paramsHash: 'a'.repeat(64), phrase: 'X 1' },
  'ru'
);
await api.reject('s1', 'p1', 'evil&x=1');
await api.compensate('s1', 'p1');
await api.list('s1', true);
await api.rollback('s1', 'p1');
await api.signingSecret('s1', 'c1');
await api.memos('s1');
await api.saveDraft('s1', 2, 0, { names: { uk: 'x' } });
await api.publish('s1', 2, 1);
await api.checkToken('s1', 2, { path: '/admin' });
await assert.rejects(api.memo('s1', 0));
await assert.rejects(api.checkToken('s1', -1, {}));
assert.deepEqual(
  calls.map(([m, path]) => `${m} ${path}`),
  [
    'POST /assist/sites/s1/admin-chat/proposals/p1/confirm?lang=ru',
    'POST /assist/sites/s1/admin-chat/proposals/p1/reject',
    'POST /assist/sites/s1/admin-chat/proposals/p1/compensate',
    'GET /assist/sites/s1/action-log/proposals?chain=review',
    'POST /assist/sites/s1/action-log/p1/rollback',
    'POST /assist/sites/s1/connectors/c1/signing-secret',
    'GET /assist/sites/s1/admin-mode/memos',
    'PATCH /assist/sites/s1/admin-mode/memos/2/draft',
    'POST /assist/sites/s1/admin-mode/memos/2/versions/1/publish',
    'POST /assist/sites/s1/admin-mode/memos/2/check-token',
  ]
);
assert.deepEqual(calls[calls.length - 1]?.[2], { path: '/admin' });
assert.deepEqual(calls[0][2], { paramsHash: 'a'.repeat(64), phrase: 'X 1' });

// Заход 9 — Р-З9-18 (секрет подписи с выпуском экрана), язык журнала
// владельца (аудит Э8 (5)), попытки/исход карточки и «повтор закрыт» (Р-З9-21).
calls.length = 0;
await api.signingSecret('s1', 'c1', null);
await api.signingSecret('s1', 'c1', '2026-10-05T10:00:00.000Z');
await api.list('s1', true, 'en');
await api.list('s1', false, 'ru');
await api.list('s1', false, 'xx');
assert.deepEqual(
  calls.map(([mth, path, b]) => `${mth} ${path} ${JSON.stringify(b) ?? '-'}`),
  [
    'POST /assist/sites/s1/connectors/c1/signing-secret {"expectedSetAt":null}',
    'POST /assist/sites/s1/connectors/c1/signing-secret {"expectedSetAt":"2026-10-05T10:00:00.000Z"}',
    'GET /assist/sites/s1/action-log/proposals?chain=review&lang=en -',
    'GET /assist/sites/s1/action-log/proposals?lang=ru -',
    'GET /assist/sites/s1/action-log/proposals -',
  ]
);
const ex = parseProposal({
  status: 'expired',
  attempts: 1.7,
  outcome: 'retry_expired',
});
assert.equal(ex.attempts, 1);
assert.equal(ex.outcome, 'retry_expired');
assert.equal(retryExpired(ex), true);
assert.equal(retryExpired(parseProposal({ status: 'expired' })), false);
assert.equal(
  retryExpired(
    parseProposal({ status: 'expired', attempts: 1, outcome: 'memo_halted' })
  ),
  false,
  'остановка мемо — не «24 часа»'
);
assert.equal(
  retryExpired(parseProposal({ status: 'unknown', attempts: 2 })),
  false
);
assert.equal(parseProposal({ attempts: -3 }).attempts, 0);
const allKeys = (o: object): string[] =>
  Object.entries(o)
    .flatMap(([k, v]) =>
      v && typeof v === 'object' ? allKeys(v).map((x) => `${k}.${x}`) : [k]
    )
    .sort();
for (const l of ['ru', 'en'] as const)
  assert.deepEqual(
    allKeys(ADMIN_ACTIONS_TEXTS[l]),
    allKeys(ADMIN_ACTIONS_TEXTS.uk),
    l
  );
for (const l of ['uk', 'ru', 'en'] as const) {
  assert.ok(/dryRun|API/.test(ADMIN_ACTIONS_TEXTS[l].op.dryRunWarn), l);
  assert.ok(/24/.test(ADMIN_ACTIONS_TEXTS[l].card.retryExpired), l);
}

for (const [lang, d] of Object.entries(ADMIN_ACTIONS_TEXTS)) {
  const all = JSON.stringify(d, (_k, v) =>
    typeof v === 'function' ? v(1, 2) : v
  );
  assert.equal(
    /откатил|відкотив|rolled back|вернул как было/i.test(all),
    false,
    lang
  );
}
console.log('ok admin-actions-api');
