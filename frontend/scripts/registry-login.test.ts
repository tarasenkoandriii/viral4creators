/**
 * Вход учёткой из реестра сайта на шаге входа мастера (Э-С Ш2-хвост (3)):
 * перевод отказов по коду, «чего не нашёл сервер», выбор полей вручную
 * (пароль — только в поле пароля), показ блока и подпись учётки без
 * логина/пароля. Плюс: в разметке блока и в запросе нет значений секретов.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOGIN_FIELDS_NOT_FOUND,
  buildPick,
  missingFields,
  passwordFields,
  registryAccountLabel,
  registryLoginErrorKey,
  registryLoginVisible,
  usernameFields,
} from '../src/features/projects/registry-login';
import type { PageExploration } from '../src/types/client-site-tutorial';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const page = (
  elements: PageExploration['elements'],
  looksLikeLogin = true
): PageExploration => ({
  currentUrl: 'https://shop.example.com/login',
  screenshotDataUrl: 'data:image/jpeg;base64,x',
  looksLikeLogin,
  elements,
});

const login = page([
  { selector: '#q', tag: 'input', type: 'search' },
  { selector: '#email', tag: 'input', type: 'email', label: 'Email' },
  { selector: '#nick', tag: 'input', label: 'Ник' },
  { selector: '#pw', tag: 'input', type: 'password', label: 'Пароль' },
  { selector: '#agree', tag: 'input', type: 'checkbox' },
  { selector: '#go', tag: 'button', visibleText: 'Войти' },
]);

console.log('вход учёткой реестра (Ш2-хвост (3))');

it('коды отказов — ключи словаря; чужой код — null (текст сервера)', () => {
  assert.equal(
    registryLoginErrorKey('REGISTRY_LOGIN_UNAVAILABLE'),
    'registryErrUnavailable'
  );
  assert.equal(
    registryLoginErrorKey('REGISTRY_ACCOUNT_UNAVAILABLE'),
    'registryErrAccount'
  );
  assert.equal(
    registryLoginErrorKey('REGISTRY_ACCOUNT_NO_PASSWORD'),
    'registryErrNoPassword'
  );
  assert.equal(
    registryLoginErrorKey(LOGIN_FIELDS_NOT_FOUND),
    'registryErrFieldsNotFound'
  );
  assert.equal(registryLoginErrorKey('SOMETHING_ELSE'), null);
  assert.equal(registryLoginErrorKey(null), null);
});

it('чего не нашёл сервер — из reason; мусор отброшен; без reason — всё', () => {
  assert.deepEqual(missingFields('username,submit'), ['username', 'submit']);
  assert.deepEqual(missingFields(' password , totp'), ['password']);
  assert.deepEqual(missingFields(null), ['username', 'password', 'submit']);
  assert.deepEqual(missingFields(''), ['username', 'password', 'submit']);
});

it('поля для выбора: пароль — только поля пароля, логин — текстовые не-пароли', () => {
  assert.deepEqual(
    passwordFields(login).map((e) => e.selector),
    ['#pw']
  );
  assert.deepEqual(
    usernameFields(login).map((e) => e.selector),
    ['#email', '#nick']
  );
});

it('pick: пароль обязателен и только поле пароля; логин — только текстовое поле', () => {
  assert.deepEqual(
    buildPick(login, { username: '#email', password: '#pw', submit: '#go' }),
    {
      usernameSelector: '#email',
      passwordSelector: '#pw',
      submitSelector: '#go',
    }
  );
  assert.deepEqual(
    buildPick(login, { username: '', password: '#pw', submit: null }),
    { passwordSelector: '#pw' }
  );
  // «Пароль» в текстовое поле — нельзя: он был бы виден в кадре.
  assert.equal(
    buildPick(login, { username: '', password: '#email', submit: null }),
    null
  );
  assert.equal(
    buildPick(login, { username: '', password: '', submit: null }),
    null
  );
  // Логин в поле пароля или в чекбокс — нельзя.
  assert.equal(
    buildPick(login, { username: '#pw', password: '#pw', submit: null }),
    null
  );
  assert.equal(
    buildPick(login, { username: '#agree', password: '#pw', submit: null }),
    null
  );
});

it('блок виден только на странице входа, при доступном реестре и непустом списке', () => {
  const opts = {
    available: true,
    accounts: [{ id: 'a', label: 'Покупатель', role: 'customer' }],
  };
  assert.equal(registryLoginVisible(opts, login), true);
  assert.equal(registryLoginVisible(null, login), false);
  assert.equal(
    registryLoginVisible({ available: false, accounts: opts.accounts }, login),
    false
  );
  assert.equal(
    registryLoginVisible({ available: true, accounts: [] }, login),
    false
  );
  assert.equal(registryLoginVisible(opts, page(login.elements, false)), false);
});

it('подпись учётки — метка и роль, без логина', () => {
  assert.equal(
    registryAccountLabel({
      id: 'a',
      label: 'Покупатель Pro',
      role: 'customer',
    }),
    'Покупатель Pro · customer'
  );
  assert.equal(
    registryAccountLabel({ id: 'a', label: 'Админ', role: null }),
    'Админ'
  );
});

it('запрос входа учёткой несёт только id учётки и селекторы — без логина и пароля', () => {
  const api = readFileSync(
    new URL('../src/services/client-site-tutorial-api.ts', import.meta.url),
    'utf8'
  );
  const fn = api.slice(
    api.indexOf('export async function loginWithRegistryAccount')
  );
  const sig = fn.slice(0, fn.indexOf('): Promise'));
  assert.ok(/testAccountId: string/.test(sig));
  assert.ok(!/password\s*:|username\s*:/.test(sig));
  assert.ok(/\/login-registry`/.test(fn));
});

console.log(`  ${passed} проверок`);
