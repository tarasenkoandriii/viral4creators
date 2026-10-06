/**
 * Аудит Н-1 (P2): приглашение больше не принимается само при запуске и не
 * переключает человека в чужой кабинет.
 *  - шаги приглашения (`inviteFlow`): из запуска — только экран
 *    подтверждения; «Принять» — только с него; пока решения нет, кабинет
 *    не грузится; после принятия — тост «Переключиться», а не смена выбора;
 *  - превью сервера (`GET /sites/account/invites/:token/preview`) — разбор
 *    и маршрут;
 *  - «в каком кабинете действие» для экранов сайта/хоста;
 *  - App.tsx: экран подтверждения подключён, принятие — только из него,
 *    выбранный кабинет принятием не перезаписывается;
 *  - словари: экран и предупреждения есть на всех языках.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountContext } from '../src/kit/account-select';
import { createApiClient } from '../src/kit/api-client';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';
import {
  inviteBlocksAccount,
  inviteFlowNext,
  inviteJoinNotice,
  pendingInviteToken,
  startInviteFlow,
  type InviteFlow,
} from '../src/kit/invite';
import { createSitesApi, parseInvitePreview } from '../src/kit/sites-api';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012_-9';

// ── Шаги приглашения ──────────────────────────────────────────────────
// Из запуска — экран подтверждения, НЕ принятие.
const start = startInviteFlow(TOKEN);
assert.deepEqual(start, { step: 'confirm', token: TOKEN });
assert.deepEqual(startInviteFlow(null), { step: 'idle' });
// Пока решения нет — кабинет не грузится (новичку не создаётся пустой).
assert.equal(inviteBlocksAccount(start), true);
assert.equal(inviteBlocksAccount({ step: 'idle' }), false);
assert.equal(pendingInviteToken(start), TOKEN);
assert.equal(pendingInviteToken({ step: 'idle' }), null);

// Принять — только с экрана; «принято» — только после нажатия.
const idle: InviteFlow = { step: 'idle' };
assert.deepEqual(inviteFlowNext(idle, { type: 'accept' }), idle);
assert.deepEqual(
  inviteFlowNext(start, { type: 'accepted', accountId: 'A', role: 'manager' }),
  start,
  'принятие без нажатия «Принять» — не шаг'
);
const accepting = inviteFlowNext(start, { type: 'accept' });
assert.deepEqual(accepting, { step: 'accepting', token: TOKEN });
assert.equal(inviteBlocksAccount(accepting), true);
assert.equal(pendingInviteToken(accepting), TOKEN);
const joined = inviteFlowNext(accepting, {
  type: 'accepted',
  accountId: 'acc_foreign_123456',
  role: 'manager',
});
assert.deepEqual(joined, {
  step: 'joined',
  accountId: 'acc_foreign_123456',
  role: 'manager',
});
assert.equal(inviteBlocksAccount(joined), false);
// Отклонить — закрыто; 401 при принятии — снова экран; отказ — закрыто.
assert.deepEqual(inviteFlowNext(start, { type: 'decline' }), {
  step: 'closed',
});
assert.deepEqual(inviteFlowNext(accepting, { type: 'unauthorized' }), start);
assert.deepEqual(inviteFlowNext(accepting, { type: 'failed' }), {
  step: 'closed',
});
// Отклонить во время запроса нельзя (кнопки заблокированы).
assert.deepEqual(inviteFlowNext(accepting, { type: 'decline' }), accepting);

// Тост: открыт свой — предложить переключиться; открыт добавленный
// (новичок без своего) — просто «вы присоединились».
assert.deepEqual(inviteJoinNotice(joined, 'acc_own_999999'), {
  kind: 'switch',
  accountId: 'acc_foreign_123456',
});
assert.deepEqual(inviteJoinNotice(joined, 'acc_foreign_123456'), {
  kind: 'here',
  accountId: 'acc_foreign_123456',
});
assert.equal(inviteJoinNotice(start, 'x'), null);
assert.deepEqual(inviteFlowNext(joined, { type: 'dismiss' }), {
  step: 'closed',
});

// ── Превью: разбор ────────────────────────────────────────────────────
const raw = {
  account: { tail: '123456', type: 'agency' },
  inviter: { username: 'owner_a', firstName: 'Ольга' },
  role: 'manager',
  productRoles: { assist: 'manager', assistAdmin: 'employee', qa: 'bogus' },
  expiresAt: '2026-10-13T00:00:00.000Z',
  alreadyMember: false,
};
assert.deepEqual(parseInvitePreview(raw), {
  account: { tail: '123456', type: 'agency' },
  inviter: { username: 'owner_a', firstName: 'Ольга' },
  role: 'manager',
  productRoles: { qa: 'none', assist: 'manager', assistAdmin: 'employee' },
  expiresAt: '2026-10-13T00:00:00.000Z',
  alreadyMember: false,
});
assert.equal(
  parseInvitePreview({ ...raw, inviter: { username: null, firstName: '' } })
    .inviter,
  null
);
assert.equal(parseInvitePreview({ ...raw, inviter: null }).inviter, null);
assert.equal(
  parseInvitePreview({ ...raw, account: { tail: 'x' } }).account.type,
  'owner'
);
// «Уже участник» — строго true.
assert.equal(
  parseInvitePreview({ ...raw, alreadyMember: 'true' }).alreadyMember,
  false
);
// Роль владельца / без кабинета — не приглашение (экран не даст «Принять»).
assert.throws(() => parseInvitePreview({ ...raw, role: 'owner' }));
assert.throws(() => parseInvitePreview({ ...raw, account: {} }));
assert.throws(() => parseInvitePreview(null));

// ── Превью: маршрут ───────────────────────────────────────────────────
type Init = { method: string; body?: string };
const calls: Array<{ url: string; init: Init }> = [];
let data: unknown = null;
const api = createSitesApi(
  createApiClient({
    baseUrl: '/api',
    auth: () => ({ headers: {}, credentials: 'same-origin' }),
    locale: () => 'ru',
    fetchImpl: (async (url: string, init: Init) => {
      calls.push({ url, init });
      return {
        status: 200,
        text: async () => JSON.stringify({ success: true, data }),
      };
    }) as unknown as typeof fetch,
  })
);
const last = () => calls[calls.length - 1];
data = raw;
assert.equal((await api.invitePreview(TOKEN)).role, 'manager');
assert.equal(last().url, `/api/sites/account/invites/${TOKEN}/preview`);
assert.equal(last().init.method, 'GET');
assert.equal(last().init.body, undefined);
await api.invitePreview('a/b?c').catch(() => undefined);
assert.equal(last().url, '/api/sites/account/invites/a%2Fb%3Fc/preview');

// ── В каком кабинете действие ─────────────────────────────────────────
assert.deepEqual(
  accountContext({ account: { id: 'acc_own_999999' }, me: { role: 'owner' } }),
  { own: true, label: '…999999', role: 'owner' }
);
assert.deepEqual(
  accountContext({
    account: { id: 'acc_foreign_123456' },
    me: { role: 'manager' },
  }),
  { own: false, label: '…123456', role: 'manager' }
);
assert.equal(
  accountContext({ account: { id: 'x' }, me: { role: 'operator' } }).own,
  false
);

// ── App.tsx: экран подключён, автопринятия и молчаливого переключения нет ─
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.ok(/<InviteAcceptScreen[\s\S]*?onAccept=\{acceptInvite\}/.test(app));
assert.ok(/startInviteFlow\(/.test(app));
assert.ok(/if \(inviteBlocks\) \{/.test(app));
// Принятие — ровно одно место (обработчик кнопки), не в загрузке кабинета.
assert.equal(app.match(/api\.acceptInvite\(/g)?.length, 1);
const loader = app.slice(app.indexOf('const account = useAsync'));
assert.ok(
  !/acceptInvite/.test(loader.slice(0, loader.indexOf('}, [api, phase'))),
  'загрузка кабинета не принимает приглашение'
);
// Выбор кабинета принятием не перезаписывается.
assert.ok(!/storeAccountId\(\s*joined/.test(app));
assert.ok(!/accountIdRef\.current\s*=\s*joined/.test(app));

// ── Словари ───────────────────────────────────────────────────────────
for (const d of [ru, uk, en]) {
  for (const k of [
    'title',
    'warningTitle',
    'warning',
    'accept',
    'decline',
  ] as const) {
    assert.ok(d.inviteAccept[k].trim(), k);
  }
  assert.ok(d.account.foreignWarning.trim());
  assert.ok(/\{id\}/.test(d.invite.joined));
  assert.ok(/\{id\}.*\{role\}|\{role\}.*\{id\}/.test(d.account.foreignContext));
}
// Предупреждение называет главное: чужой кабинет, домены, пароли.
assert.ok(/НЕ ваш/.test(ru.inviteAccept.warningTitle));
assert.ok(/домен/.test(ru.inviteAccept.warning));
assert.ok(/парол/.test(ru.inviteAccept.warning));
assert.ok(/парол/.test(uk.inviteAccept.warning));
assert.ok(/password/.test(en.inviteAccept.warning));

console.log('invite-flow: ok');
