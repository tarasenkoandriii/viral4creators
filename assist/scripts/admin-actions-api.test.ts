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
} from '../src/lib/admin-actions-api';
import { ADMIN_ACTIONS_TEXTS } from '../src/i18n/admin-actions';

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
await assert.rejects(api.memo('s1', 0));
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
  ]
);
assert.deepEqual(calls[0][2], { paramsHash: 'a'.repeat(64), phrase: 'X 1' });

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
