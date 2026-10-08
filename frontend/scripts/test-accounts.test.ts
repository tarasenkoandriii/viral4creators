/**
 * Тестовые учётные записи мастера обучалки (Э-С Ш2): пароль только на
 * запись, обязательные поля, галочка «тестовый аккаунт» у новой учётки.
 */
import assert from 'node:assert/strict';
import {
  emptyTestAccountForm,
  formFromAccount,
  productLabel,
  roleHintKey,
  statusTone,
  testAccountPayload,
  toggle,
} from '../src/lib/test-accounts';
import type { SiteTestAccount } from '../src/types/test-accounts';
import ru from '../src/dictionaries/ru.json';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import de from '../src/dictionaries/de.json';
import es from '../src/dictionaries/es.json';

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

it('Ш3 (12): продукт assist-admin — подписью во всех пяти словарях, не кодом', () => {
  for (const [loc, d] of Object.entries({ ru, uk, en, de, es })) {
    const t = d.clientSiteTestAccounts;
    const label = productLabel('assist-admin', t);
    assert.ok(label.trim(), `${loc}: пустая подпись assist-admin`);
    assert.notEqual(label, 'assist-admin', `${loc}: сырой код продукта`);
    assert.equal(productLabel('tutorial', t), t.productTutorial);
    assert.equal(productLabel('qa', t), t.productQa);
    // Три подписи различимы — иначе в карточке не понять, что разрешено.
    assert.equal(
      new Set([t.productTutorial, t.productQa, t.productAssistAdmin]).size,
      3,
      `${loc}: подписи продуктов совпадают`
    );
  }
  assert.equal(
    account.products
      .map((p) => productLabel(p, ru.clientSiteTestAccounts))
      .join(', '),
    'Обучалка, QA-проверки, Помощник: обход Админки'
  );
  // Неизвестный будущий продукт — кодом, а не пропавшей строкой.
  assert.equal(productLabel('voice', ru.clientSiteTestAccounts), 'voice');
});

it('P3-3: учётка только с assist-admin сохраняется — скрытый продукт считается, в запрос не уходит', () => {
  const f = formFromAccount({ ...account, products: ['assist-admin'] });
  assert.deepEqual(f.products, []);
  assert.deepEqual(f.otherProducts, ['assist-admin']);
  const p = payloadOf(testAccountPayload(f, { isNew: false }));
  assert.deepEqual(p.products, []);
  // Сняли видимые — тоже можно, если остался скрытый.
  const mixed = formFromAccount(account);
  assert.deepEqual(mixed.otherProducts, ['assist-admin']);
  assert.deepEqual(
    payloadOf(testAccountPayload({ ...mixed, products: [] }, { isNew: false }))
      .products,
    []
  );
  // Без скрытых — по-прежнему «хотя бы один продукт».
  assert.deepEqual(
    testAccountPayload(
      { ...formFromAccount({ ...account, products: ['qa'] }), products: [] },
      { isNew: false }
    ),
    { error: 'productRequired' }
  );
  assert.deepEqual(emptyTestAccountForm(null).otherProducts, []);
});

console.log(`test-accounts: ${passed} ok`);
