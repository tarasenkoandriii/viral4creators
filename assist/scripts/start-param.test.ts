import assert from 'node:assert/strict';
import {
  isCanonicalHost,
  parseStartParam,
  verifyHostFromStartParam,
  verifyHostStartParam,
} from '../src/kit/start-param';

/** base64url (UTF-8) без `=` — как генератор (Node `Buffer…toString('base64url')`). */
const b64u = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

assert.deepEqual(parseStartParam('inv_abc123'), {
  kind: 'inv',
  value: 'abc123',
});
assert.deepEqual(parseStartParam('sb_X-1'), { kind: 'sb', value: 'X-1' });
assert.deepEqual(parseStartParam('st_site1'), { kind: 'st', value: 'site1' });
assert.equal(parseStartParam('inv_'), null);
assert.equal(parseStartParam('inv_a.b'), null);
assert.equal(parseStartParam('ref_abc'), null);
assert.equal(parseStartParam('x'.repeat(65)), null);
assert.equal(parseStartParam(null), null);
assert.equal(parseStartParam(''), null);

// ═══ Ш1-хвост: `vh-<base64url(хост)>` — «подтвердить ЭТОТ хост» ═══════
// Кодирование — как у генератора (base64url без `=`).
const vh = (host: string) => `vh-${b64u(host)}`;
for (const host of [
  'shop.example.com',
  'www.example.com',
  'a.b',
  'xn--e1afmkfd.xn--j1amh',
  'my-shop.co.uk',
  'x'.repeat(41) + '.com', // 45 символов — 60 в base64url, 63 всего
]) {
  assert.equal(verifyHostFromStartParam(vh(host)), host, host);
  assert.equal(verifyHostStartParam(host), vh(host), host);
  assert.deepEqual(parseStartParam(vh(host))?.kind, 'vh');
}
// Длиннее 45 символов в 64 символа startapp не влезает — не разбирается.
assert.equal(verifyHostFromStartParam(vh('x'.repeat(42) + '.com')), null);
assert.equal(verifyHostStartParam('x'.repeat(42) + '.com'), null);
// Строгий хост: только нормальная форма, никаких схем/путей/портов/IP.
for (const bad of [
  'Shop.Example.com',
  'https://shop.example.com',
  'shop.example.com/',
  'shop.example.com:8443',
  'shop.example.com.',
  'localhost',
  '127.0.0.1',
  '10.0.0.1',
  '-shop.example.com',
  'shop-.example.com',
  'shop..example.com',
  'shop.example.123',
  'user@shop.example.com',
  'shop example.com',
  'пример.укр',
  'shop.example.com\n',
]) {
  assert.equal(isCanonicalHost(bad), false, bad);
  assert.equal(verifyHostFromStartParam(vh(bad)), null, bad);
}
// Не base64url, неканоническая запись, паддинг, обрыв, чужой префикс.
for (const raw of [
  'vh-',
  'vh-c2hvcC5leGFtcGxlLmNvbQ==',
  'vh-c2hvcC5leGFtcGxlLmNvbR', // хвостовые биты ≠ 0 — неканонично
  'vh-c2hvc', // длина ≡ 1 (mod 4)
  'vh-c2hvcC5le+GFtcGxl',
  'vh_c2hvcC5leGFtcGxlLmNvbQ',
  'VH-c2hvcC5leGFtcGxlLmNvbQ',
  `vh-${b64u('shop.ex\u0000ample.com')}`,
  `vh-${b64u('shöp.example.com')}`,
  'inv_abc',
  null,
  '',
]) {
  assert.equal(verifyHostFromStartParam(raw), null, String(raw));
}

console.log('start-param: ok');
