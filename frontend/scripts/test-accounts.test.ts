/**
 * Тестовые учётные записи мастера обучалки (Э-С Ш2): пароль только на
 * запись, обязательные поля, галочка «тестовый аккаунт» у новой учётки.
 */
import assert from 'node:assert/strict';
import {
  emptyTestAccountForm,
  formFromAccount,
  roleHintKey,
  statusTone,
  testAccountPayload,
  toggle,
} from '../src/lib/test-accounts';
import type { SiteTestAccount } from '../src/types/test-accounts';

/** Тело запроса или провал теста (сужение типа для tsc). */
function payloadOf(r: ReturnType<typeof testAccountPayload>) {
  if ('error' in r) throw new Error(`ожидалось тело, а не ${r.error}`);
  return r.payload;
}

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const account: SiteTestAccount = {
  id: 'ta1',
  siteId: 's1',
  label: 'Покупатель Pro',
  role: 'customer',
  plan: 'Pro',
  username: 'qa@example.com',
  loginMethod: 'password',
  hostIds: ['h1'],
  products: ['tutorial', 'qa', 'assist-admin'],
  status: 'active',
  confirmedTestAccount: true,
  createdBy: 'tma',
  secrets: { password: true, loginFields: false, session: false },
  lastUsedAt: null,
  expiresAt: '2027-01-01T00:00:00Z',
  createdAt: '2026-10-02T00:00:00Z',
};

it('новая учётка: хост черновика и обучалка по умолчанию, без галочки — ошибка', () => {
  const f = emptyTestAccountForm('h1');
  assert.deepEqual(f.hostIds, ['h1']);
  assert.deepEqual(f.products, ['tutorial']);
  assert.deepEqual(testAccountPayload({ ...f, label: 'X' }, { isNew: true }), {
    error: 'confirmRequired',
  });
});

it('обязательные: подпись, хост, продукт', () => {
  const f = { ...emptyTestAccountForm('h1'), confirmedTestAccount: true };
  assert.deepEqual(testAccountPayload(f, { isNew: true }), {
    error: 'labelRequired',
  });
  assert.deepEqual(
    testAccountPayload({ ...f, label: 'X', hostIds: [] }, { isNew: true }),
    { error: 'hostRequired' }
  );
  assert.deepEqual(
    testAccountPayload({ ...f, label: 'X', products: [] }, { isNew: true }),
    { error: 'productRequired' }
  );
});

it('правка: пароль пустой и не уходит; срок не меняется; чужие продукты отброшены', () => {
  const f = formFromAccount(account);
  assert.equal(f.password, '');
  assert.deepEqual(f.products, ['tutorial', 'qa']);
  const p = payloadOf(testAccountPayload(f, { isNew: false }));
  assert.equal('password' in p, false);
  assert.equal('lifetimeDays' in p, false);
  assert.equal(p.username, 'qa@example.com');
});

it('новый пароль уходит; пустые роль/пакет — null', () => {
  const f = {
    ...formFromAccount(account),
    password: 'n3w',
    role: ' ',
    plan: '',
  };
  const p = payloadOf(testAccountPayload(f, { isNew: false }));
  assert.equal(p.password, 'n3w');
  assert.equal(p.role, null);
  assert.equal(p.plan, null);
});

it('мелочи: переключение, тон статуса, подсказка роли', () => {
  assert.deepEqual(toggle(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggle(['a', 'b'], 'a'), ['b']);
  assert.equal(statusTone('active'), 'success');
  assert.equal(statusTone('frozen'), 'warning');
  assert.equal(statusTone('expired'), 'danger');
  assert.equal(roleHintKey('admin'), 'admin');
  assert.equal(roleHintKey('Супер-юзер'), null);
});

console.log(`test-accounts: ${passed} ok`);
