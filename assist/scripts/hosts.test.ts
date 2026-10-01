import assert from 'node:assert/strict';
import {
  hostKey,
  hostOrigin,
  isPublicPlatformHost,
  parseHostInput,
  validateHostList,
  verificationCovers,
  wwwTwin,
  type HostAddress,
} from '../src/kit/hosts';

function ok(raw: string): HostAddress {
  const r = parseHostInput(raw);
  assert.ok(r.ok, `ожидался валидный хост: ${raw}`);
  return r as HostAddress;
}
function err(raw: string): string {
  const r = parseHostInput(raw);
  assert.ok(!r.ok, `ожидалась ошибка: ${raw}`);
  return (r as { error: string }).error;
}

// Нормализация: схема по умолчанию, регистр, путь и хвостовая точка уходят.
assert.deepEqual(ok('example.com'), {
  ok: true,
  scheme: 'https',
  host: 'example.com',
  port: 443,
});
assert.equal(
  ok('  HTTPS://Shop.Example.COM/catalog?x=1#a ').host,
  'shop.example.com'
);
assert.equal(ok('example.com.').host, 'example.com');
assert.equal(ok('https://example.com:443/').port, 443);
// IDN → punycode (единица подтверждения в ядре — punycode).
assert.equal(ok('пример.укр').host, 'xn--e1afmkfd.xn--j1amh');
// www НЕ срезается: это отдельный хост.
assert.equal(ok('www.example.com').host, 'www.example.com');

assert.equal(err(''), 'empty');
assert.equal(err('   '), 'empty');
assert.equal(err('http://example.com'), 'not_https');
assert.equal(err('ftp://example.com'), 'not_https');
assert.equal(err('example.com:8443'), 'port');
assert.equal(err('1.2.3.4'), 'ip');
assert.equal(err('[::1]'), 'ip');
assert.equal(err('localhost'), 'single_label');
assert.equal(err('https://user:pw@example.com'), 'invalid');
assert.equal(err('exa mple.com'), 'invalid');

// ПРИЁМКА Э0: apex и www — разные хосты; поддомен НЕ подтверждён от apex.
const apex = ok('example.com');
const www = ok('www.example.com');
const shop = ok('shop.example.com');
assert.notEqual(hostKey(apex), hostKey(www));
assert.equal(verificationCovers(apex, apex), true);
assert.equal(verificationCovers(apex, shop), false);
assert.equal(verificationCovers(apex, www), false);
assert.equal(verificationCovers(www, apex), false);
assert.equal(verificationCovers(shop, apex), false);
// И «тот же» хост на другом порту — другой.
assert.equal(verificationCovers(apex, { ...apex, port: 8443 }), false);
// И суффикс-похожий домен не покрывается.
assert.equal(verificationCovers(apex, ok('badexample.com')), false);

assert.equal(hostOrigin(apex), 'https://example.com');
assert.equal(hostOrigin({ ...apex, port: 8443 }), 'https://example.com:8443');

// Список формы: дубли — по ключу ядра, пустые строки пропускаются.
const v = validateHostList([
  'example.com',
  'HTTPS://Example.com/',
  '',
  'shop.example.com',
  'http://x.com',
]);
assert.deepEqual(v.errors, [null, 'duplicate', null, null, 'not_https']);
assert.deepEqual(
  v.hosts.map((h) => h.host),
  ['example.com', 'shop.example.com']
);
assert.deepEqual(validateHostList(['example.com', 'www.example.com']).errors, [
  null,
  null,
]);

// Подсказка пары www ↔ apex.
assert.equal(wwwTwin('example.com'), 'www.example.com');
assert.equal(wwwTwin('www.example.com'), 'example.com');
assert.equal(wwwTwin('shop.example.com'), null);
assert.equal(wwwTwin('www.com'), null);

assert.equal(isPublicPlatformHost('store.myshopify.com'), true);
assert.equal(isPublicPlatformHost('myshopify.com'), true);
assert.equal(isPublicPlatformHost('evilmyshopify.com'), false);
assert.equal(isPublicPlatformHost('project.vercel.app'), true);
assert.equal(isPublicPlatformHost('example.com'), false);

console.log('hosts: ok');
