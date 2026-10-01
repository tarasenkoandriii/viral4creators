import assert from 'node:assert/strict';
import {
  canManage,
  pickAccountId,
  shortAccountId,
} from '../src/kit/account-select';
import {
  inviteProductRoles,
  telegramInviteLink,
  webInviteLink,
} from '../src/kit/invite';
import {
  inviteTokenFromLaunch,
  stripInviteParam,
} from '../src/kit/start-param';
import { parseAccountInfo, parseInvite } from '../src/kit/sites-api';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012_-9'; // 32, как newVerifyToken

// ── Приглашение из запуска ────────────────────────────────────────────
// TMA: start_param `inv_<токен>`.
assert.equal(inviteTokenFromLaunch(`inv_${TOKEN}`, ''), TOKEN);
// Другой префикс startapp — не приглашение.
assert.equal(inviteTokenFromLaunch(`lp_${TOKEN}`, ''), null);
// Веб: `?invite=inv_…` и голый токен.
assert.equal(inviteTokenFromLaunch(null, `?invite=inv_${TOKEN}`), TOKEN);
assert.equal(inviteTokenFromLaunch(null, `?x=1&invite=${TOKEN}`), TOKEN);
assert.equal(inviteTokenFromLaunch(undefined, `invite=${TOKEN}`), TOKEN);
// start_param важнее query.
assert.equal(inviteTokenFromLaunch('inv_first', `?invite=second`), 'first');
// Битое — не уходит на сервер.
assert.equal(inviteTokenFromLaunch(null, '?invite=a.b'), null);
assert.equal(inviteTokenFromLaunch(null, '?invite=<script>'), null);
assert.equal(inviteTokenFromLaunch(null, '?invite='), null);
assert.equal(inviteTokenFromLaunch(null, '?invite=' + 'x'.repeat(70)), null);
assert.equal(inviteTokenFromLaunch(null, ''), null);
assert.equal(inviteTokenFromLaunch(null, null), null);

assert.equal(
  stripInviteParam(`https://app.example/?invite=inv_${TOKEN}&a=1#/members`),
  '/?a=1#/members'
);
assert.equal(
  stripInviteParam(`https://app.example/?invite=inv_${TOKEN}#/`),
  '/#/'
);

// ── Ссылки ────────────────────────────────────────────────────────────
assert.equal(
  telegramInviteLink('@assist_bot', `inv_${TOKEN}`),
  `https://t.me/assist_bot?startapp=inv_${TOKEN}`
);
assert.equal(
  webInviteLink('https://cab.example/', `inv_${TOKEN}`),
  `https://cab.example/?invite=inv_${TOKEN}`
);
// Hash маршрута в ссылку не попадает, старый invite заменяется.
assert.equal(
  webInviteLink('https://cab.example/?invite=old#/members', `inv_${TOKEN}`),
  `https://cab.example/?invite=inv_${TOKEN}`
);
// Ссылка из веба разбирается обратно в тот же токен.
assert.equal(
  inviteTokenFromLaunch(
    null,
    new URL(webInviteLink('https://cab.example/', `inv_${TOKEN}`)).search
  ),
  TOKEN
);

assert.deepEqual(inviteProductRoles('assist', 'manager', 'none'), {
  assist: 'manager',
  assistAdmin: 'none',
});
assert.deepEqual(inviteProductRoles('assist', 'operator', 'employee'), {
  assist: 'operator',
  assistAdmin: 'employee',
});
assert.deepEqual(inviteProductRoles('qa', 'manager', 'owner'), { qa: 'admin' });
assert.deepEqual(inviteProductRoles('qa', 'operator', 'none'), {
  qa: 'viewer',
});

// ── Ответы сервера ────────────────────────────────────────────────────
assert.deepEqual(
  parseInvite({
    token: TOKEN,
    startParam: `inv_${TOKEN}`,
    expiresAt: '2026-10-08T00:00:00.000Z',
  }),
  {
    token: TOKEN,
    startParam: `inv_${TOKEN}`,
    expiresAt: '2026-10-08T00:00:00.000Z',
  }
);
assert.equal(parseInvite({ token: TOKEN }).startParam, `inv_${TOKEN}`);
assert.throws(() => parseInvite({}));

// Оператор: токена и списка участников нет — это не «пусто».
const op = parseAccountInfo({
  account: { id: 'a1', type: 'owner', region: 'ua', verifyToken: null },
  me: {
    telegramId: '5',
    role: 'operator',
    productRoles: { assist: 'operator' },
  },
  accounts: [
    { id: 'a1', role: 'operator' },
    { id: 'a2', role: 'owner' },
  ],
  created: false,
});
assert.equal(op.account.verifyToken, null);
assert.equal(op.members, null);
assert.deepEqual(op.accounts, [
  { id: 'a1', role: 'operator' },
  { id: 'a2', role: 'owner' },
]);
assert.equal(op.me.productRoles.assist, 'operator');
assert.equal(op.me.productRoles.qa, 'none');
const owner = parseAccountInfo({
  account: { id: 'a2', verifyToken: TOKEN },
  me: { telegramId: '5', role: 'owner' },
  members: [
    { telegramId: '5', role: 'owner' },
    { telegramId: '6', role: 'boss' },
  ],
});
assert.equal(owner.account.verifyToken, TOKEN);
assert.equal(owner.members?.length, 2);
assert.equal(owner.members?.[1].role, 'operator'); // неизвестная → самая узкая
// Сервер без accounts[] — один текущий кабинет (переключателя нет).
assert.deepEqual(owner.accounts, [{ id: 'a2', role: 'owner' }]);

// ── Выбор кабинета ────────────────────────────────────────────────────
assert.equal(pickAccountId('a2', op.accounts), 'a2');
assert.equal(pickAccountId('gone', op.accounts), null);
assert.equal(pickAccountId(null, op.accounts), null);
assert.equal(canManage('owner'), true);
assert.equal(canManage('manager'), true);
assert.equal(canManage('operator'), false);
assert.equal(shortAccountId('cku1234567890'), '…567890');
assert.equal(shortAccountId('abc'), 'abc');

console.log('invite: ok');
