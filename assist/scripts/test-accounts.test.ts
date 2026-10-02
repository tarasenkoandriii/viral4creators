/**
 * Э-С Ш2: тестовые учётные записи сайта в кабинете — маршруты, строгий
 * разбор ответа (пароля нет и быть не может), форма (пароль только на
 * запись), хеш-маршрут экрана.
 */
import assert from 'node:assert/strict';
import { createApiClient } from '../src/kit/api-client';
import { createSitesApi } from '../src/kit/sites-api';
import {
  emptyTestAccountForm,
  isTestAccountErrorCode,
  parseTestAccount,
  testAccountForm,
  testAccountRequest,
  toggleItem,
} from '../src/kit/test-accounts';
import { parseRoute, routeHref } from '../src/lib/router';

type Init = { method: string; body?: string };

/** Тело запроса или провал теста (сужение типа для tsc). */
function payloadOf(r: ReturnType<typeof testAccountRequest>) {
  if ('error' in r) throw new Error(`ожидалось тело, а не ${r.error}`);
  return r.payload;
}
const calls: Array<{ url: string; init: Init }> = [];
let data: unknown = [];
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

async function main() {
  // ── маршруты ──
  data = [
    {
      id: 'ta1',
      siteId: 's1',
      label: 'Админ',
      status: 'weird',
      products: ['qa', 7],
      secrets: { password: 'yes', session: true },
      createdBy: 'generator',
      password: 'НЕ-ДОЛЖЕН-ПРОЙТИ',
    },
  ];
  const list = await api.testAccounts.list('s 1');
  assert.equal(calls[0].url, '/api/sites/s%201/test-accounts');
  assert.equal(calls[0].init.method, 'GET');
  // Неизвестный статус — истёкшая (аренды нет), флаги — только true.
  assert.equal(list[0].status, 'expired');
  assert.deepEqual(list[0].products, ['qa']);
  assert.deepEqual(list[0].secrets, {
    password: false,
    loginFields: false,
    session: true,
  });
  assert.equal(JSON.stringify(list).includes('НЕ-ДОЛЖЕН'), false);

  data = { id: 'ta2', status: 'active' };
  await api.testAccounts.update('s1', 'ta2', { status: 'frozen' });
  assert.equal(calls[1].url, '/api/sites/s1/test-accounts/ta2');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].init.body!), { status: 'frozen' });
  data = { deleted: true };
  assert.deepEqual(await api.testAccounts.remove('s1', 'ta2'), {
    deleted: true,
  });
  assert.equal(calls[2].init.method, 'DELETE');

  // ── форма ──
  const f = emptyTestAccountForm(['h1']);
  assert.deepEqual(testAccountRequest({ ...f, label: 'X' }, true), {
    error: 'confirmRequired',
  });
  const created = payloadOf(
    testAccountRequest(
      { ...f, label: ' X ', password: 'p', confirmedTestAccount: true },
      true
    )
  );
  assert.equal(created.label, 'X');
  assert.equal(created.password, 'p');
  const edit = testAccountForm(
    parseTestAccount({ label: 'Y', hostIds: ['h1'], products: ['tutorial'] })
  );
  assert.equal(edit.password, '');
  const patch = payloadOf(testAccountRequest(edit, false));
  assert.equal('password' in patch, false);
  assert.equal('lifetimeDays' in patch, false);
  assert.deepEqual(testAccountRequest({ ...edit, hostIds: [] }, false), {
    error: 'hostRequired',
  });
  assert.deepEqual(toggleItem(['a'], 'a'), []);
  assert.equal(isTestAccountErrorCode('TEST_ACCOUNT_INVALID'), true);
  assert.equal(isTestAccountErrorCode('HOST_INVALID'), false);

  // ── хеш-маршрут ──
  assert.deepEqual(parseRoute('#/sites/ck1/test-accounts'), {
    name: 'test-accounts',
    siteId: 'ck1',
  });
  assert.equal(
    routeHref({ name: 'test-accounts', siteId: 'ck1' }),
    '#/sites/ck1/test-accounts'
  );
  assert.equal(parseRoute('#/sites/../test-accounts').name, 'not-found');

  console.log('test-accounts: ok');
}

void main();
