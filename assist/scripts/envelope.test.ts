import assert from 'node:assert/strict';
import { ApiError, unwrapEnvelope } from '../src/kit/envelope';
import { createApiClient, joinUrl } from '../src/kit/api-client';
import { createSitesApi } from '../src/kit/sites-api';
import { buildAuthHeaders } from '../src/kit/telegram';

function catchErr(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError, 'ожидалась ApiError');
    return e as ApiError;
  }
  throw new Error('не бросило');
}

// Обычный конверт.
assert.deepEqual(unwrapEnvelope({ success: true, data: { a: 1 } }, 200, 'x'), {
  a: 1,
});
// Пустой массив/ноль/false — это данные, не «пустой ответ».
assert.deepEqual(unwrapEnvelope({ success: true, data: [] }, 200, 'x'), []);
assert.equal(unwrapEnvelope({ success: true, data: 0 }, 200, 'x'), 0);
assert.equal(unwrapEnvelope({ success: true, data: null }, 200, 'x'), null);
// Двойной конверт (урок frontend/unwrap-api-data).
assert.deepEqual(
  unwrapEnvelope(
    { success: true, data: { success: true, data: { b: 2 } } },
    200,
    'x'
  ),
  { b: 2 }
);
// Данные со своим success:false — не трогаем.
assert.deepEqual(
  unwrapEnvelope(
    { success: true, data: { success: false, data: 1 } },
    200,
    'x'
  ),
  { success: false, data: 1 }
);

// Ошибка сервера: код и текст — серверные, requestId сохраняется.
let e = catchErr(() =>
  unwrapEnvelope(
    {
      success: false,
      error: {
        code: 'host_duplicate',
        message: 'Этот хост уже есть в кабинете',
      },
      meta: { requestId: 'r1' },
    },
    409,
    'POST /sites/1/hosts'
  )
);
assert.equal(e.code, 'host_duplicate');
assert.equal(e.message, 'Этот хост уже есть в кабинете');
assert.equal(e.status, 409);
assert.equal(e.requestId, 'r1');
// HTTP-ошибка с success:true в теле — всё равно ошибка.
e = catchErr(() => unwrapEnvelope({ success: true, data: 1 }, 500, 'x'));
assert.equal(e.code, 'http_500');
// Без текста — общий текст по-русски.
e = catchErr(() => unwrapEnvelope({ success: false }, 403, 'GET /sites'));
assert.equal(e.code, 'http_403');
assert.equal(e.message, 'Ошибка сервера: GET /sites');
// Не конверт (HTML страницы ошибки прокси, null).
e = catchErr(() => unwrapEnvelope(null, 502, 'x'));
assert.equal(e.code, 'http_502');
e = catchErr(() => unwrapEnvelope({ a: 1 }, 200, 'x'));
assert.equal(e.code, 'bad_response');
// success:true без data — пустой ответ.
e = catchErr(() => unwrapEnvelope({ success: true }, 200, 'перепроверка'));
assert.equal(e.code, 'empty_response');
assert.equal(e.message, 'Пустой ответ: перепроверка');

assert.equal(joinUrl('https://api.x/', '/sites'), 'https://api.x/sites');
assert.equal(joinUrl('https://api.x/api', 'sites'), 'https://api.x/api/sites');

// Заголовки: X-Telegram-App всегда, initData важнее дев-входа, без обоих — null.
assert.deepEqual(
  buildAuthHeaders('assist', 'q=1', { enabled: true, userId: '7' }),
  {
    'X-Telegram-App': 'assist',
    'X-Telegram-Init-Data': 'q=1',
  }
);
assert.deepEqual(buildAuthHeaders('qa', '', { enabled: true, userId: '7' }), {
  'X-Telegram-App': 'qa',
  'X-Dev-User-Id': '7',
});
assert.equal(buildAuthHeaders('assist', '', { enabled: false }), null);
assert.equal(buildAuthHeaders('assist', undefined, { enabled: false }), null);

// Клиент целиком на подменённом fetch.
type Call = {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
};
const calls: Call[] = [];
let reply: { status: number; body: string } = { status: 200, body: '' };
const fakeFetch = (async (url: string, init: Call['init']) => {
  calls.push({ url, init });
  return { status: reply.status, text: async () => reply.body };
}) as unknown as typeof fetch;

let auth: Record<string, string> | null = {
  'X-Telegram-App': 'assist',
  'X-Telegram-Init-Data': 'q',
};
const api = createSitesApi(
  createApiClient({
    baseUrl: 'https://sites.example/',
    auth: () => (auth ? { headers: auth, credentials: 'omit' } : null),
    locale: () => 'uk',
    fetchImpl: fakeFetch,
  })
);

reply = {
  status: 200,
  body: JSON.stringify({
    success: true,
    data: {
      host: { id: 'h1', host: 'example.com', status: 'verified' },
      ok: true,
    },
  }),
};
const v = await api.verify('h1', 'dns');
assert.equal(v.ok, true);
assert.equal(calls[0].url, 'https://sites.example/sites/hosts/h1/verify');
assert.equal(calls[0].init.method, 'POST');
assert.equal(calls[0].init.headers['X-Telegram-App'], 'assist');
assert.equal(calls[0].init.headers['X-Telegram-Init-Data'], 'q');
assert.equal(calls[0].init.headers['Accept-Language'], 'uk');
assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
assert.equal(calls[0].init.body, '{"method":"dns"}');

// ok:true при статусе не verified — не успех (сервер и статус расходятся).
reply = {
  status: 200,
  body: JSON.stringify({
    success: true,
    data: { host: { status: 'pending' }, ok: true },
  }),
};
assert.equal((await api.verify('h1', 'dns')).ok, false);

// Идентификатор с «/» не уходит в путь как есть.
reply = {
  status: 200,
  body: JSON.stringify({ success: true, data: { results: [] } }),
};
await api.verifyAll('a/b');
assert.equal(
  calls[calls.length - 1].url,
  'https://sites.example/sites/a%2Fb/verify-all'
);

// Список сайтов: и массив, и { sites }.
reply = {
  status: 200,
  body: JSON.stringify({
    success: true,
    data: [{ id: 's1', name: 'A', hosts: [] }],
  }),
};
assert.equal((await api.listSites()).length, 1);
reply = {
  status: 200,
  body: JSON.stringify({
    success: true,
    data: { sites: [{ id: 's1' }, { id: 's2' }] },
  }),
};
assert.equal((await api.listSites()).length, 2);
// GET без тела — без Content-Type.
assert.equal(calls[calls.length - 1].init.headers['Content-Type'], undefined);
assert.equal(calls[calls.length - 1].init.body, undefined);

// Ошибка сервера доходит до экрана кодом.
reply = {
  status: 404,
  body: JSON.stringify({
    success: false,
    error: { code: 'not_found', message: 'Нет такого хоста' },
  }),
};
let thrown: unknown = null;
try {
  await api.verify('zz', 'file');
} catch (err) {
  thrown = err;
}
assert.ok(thrown instanceof ApiError);
assert.equal((thrown as ApiError).code, 'not_found');

// Тело не JSON (HTML от прокси) — ApiError, а не SyntaxError.
reply = { status: 502, body: '<html>Bad gateway</html>' };
thrown = null;
try {
  await api.listSites();
} catch (err) {
  thrown = err;
}
assert.equal((thrown as ApiError).code, 'http_502');

// Без идентичности запрос не уходит вовсе.
auth = null;
const before = calls.length;
thrown = null;
try {
  await api.account();
} catch (err) {
  thrown = err;
}
assert.equal((thrown as ApiError).code, 'no_telegram');
assert.equal(calls.length, before);

// Сеть упала — ApiError('network').
auth = { 'X-Telegram-App': 'assist', 'X-Telegram-Init-Data': 'q' };
const failing = createApiClient({
  baseUrl: 'https://x',
  auth: () => (auth ? { headers: auth, credentials: 'omit' } : null),
  locale: () => 'ru',
  fetchImpl: (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch,
});
thrown = null;
try {
  await failing.request('GET', '/sites');
} catch (err) {
  thrown = err;
}
assert.equal((thrown as ApiError).code, 'network');

console.log('envelope: ok');
