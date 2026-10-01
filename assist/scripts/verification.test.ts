import assert from 'node:assert/strict';
import {
  VERIFY_FILE_PATH,
  VERIFY_META_NAME,
  VERIFY_TXT_PREFIX,
  VERIFY_TXT_KEY,
} from '../src/kit/brand';
import {
  assertVerifyToken,
  availableMethods,
  buildDnsBatch,
  buildInstruction,
  dnsRecordName,
} from '../src/kit/verification';

const TOKEN = 'tok_ABC123xyz';
const apex = { scheme: 'https' as const, host: 'example.com', port: 443 };
const shop = { scheme: 'https' as const, host: 'shop.example.com', port: 443 };

// Формат — дословно TZ-QA-TMA.md §2.4 (приёмка Э0, аудит 01.10). Строки
// здесь литералами, а не из brand.ts: иначе правка brand.ts «проверяла бы
// сама себя», и опечатка в префиксе прошла бы тест.
assert.deepEqual(buildInstruction('dns', apex, TOKEN), {
  method: 'dns',
  recordType: 'TXT',
  name: '_v4c-verify.example.com',
  value: 'v4c-verify=tok_ABC123xyz',
});
assert.deepEqual(buildInstruction('file', apex, TOKEN), {
  method: 'file',
  url: 'https://example.com/.well-known/v4c-verify.txt',
  content: 'tok_ABC123xyz',
});
assert.deepEqual(buildInstruction('meta', apex, TOKEN), {
  method: 'meta',
  pageUrl: 'https://example.com/',
  tag: '<meta name="v4c-verify" content="tok_ABC123xyz">',
});
// Поддомен — своя запись, имя меняется, значение (токен кабинета) — нет.
const shopDns = buildInstruction('dns', shop, TOKEN);
assert.equal(
  shopDns.method === 'dns' && shopDns.name,
  '_v4c-verify.shop.example.com'
);
assert.equal(
  shopDns.method === 'dns' && shopDns.value,
  'v4c-verify=tok_ABC123xyz'
);

// И да, всё это берётся из brand.ts (одно место переименования).
assert.equal(dnsRecordName('a.b'), `${VERIFY_TXT_PREFIX}.a.b`);
const meta = buildInstruction('meta', apex, TOKEN);
assert.ok(
  meta.method === 'meta' && meta.tag.includes(`name="${VERIFY_META_NAME}"`)
);
const file = buildInstruction('file', apex, TOKEN);
assert.ok(file.method === 'file' && file.url.endsWith(VERIFY_FILE_PATH));
const dns = buildInstruction('dns', apex, TOKEN);
assert.ok(dns.method === 'dns' && dns.value.startsWith(VERIFY_TXT_KEY));

// Нестандартный порт попадает в адрес файла/меты (на будущее — MVP только 443).
const f8443 = buildInstruction('file', { ...apex, port: 8443 }, TOKEN);
assert.equal(
  f8443.method === 'file' && f8443.url,
  'https://example.com:8443/.well-known/v4c-verify.txt'
);

// Токен с HTML/кавычками — отказ, а не инструкция с инъекцией в тег.
assert.throws(() => buildInstruction('meta', apex, 'x"><script>'));
assert.throws(() => assertVerifyToken(''));
assert.throws(() => assertVerifyToken('short'));
assertVerifyToken('abcdefgh');

// Пакет «добавьте N записей»: подтверждённые не попадают, дубли схлопнуты.
const batch = buildDnsBatch(
  [
    { ...apex, status: 'verified' },
    { ...shop, status: 'pending' },
    { ...shop, status: 'pending' },
    { scheme: 'https', host: 'www.example.com', port: 443, status: 'expired' },
  ],
  TOKEN
);
assert.deepEqual(
  batch.map((b) => b.name),
  ['_v4c-verify.shop.example.com', '_v4c-verify.www.example.com']
);
assert.ok(batch.every((b) => b.value === 'v4c-verify=tok_ABC123xyz'));

// Хосты публичных платформ — только DNS (по флагу сервера или по суффиксу).
assert.deepEqual(
  availableMethods({ host: 'x.myshopify.com', publicPlatform: false }),
  ['dns']
);
assert.deepEqual(
  availableMethods({ host: 'me.github.io', publicPlatform: false }),
  ['dns']
);
assert.deepEqual(
  availableMethods({ host: 'shop.example.com', publicPlatform: true }),
  ['dns']
);
assert.deepEqual(
  availableMethods({ host: 'example.com', publicPlatform: false }),
  ['dns', 'file', 'meta']
);
// Похожее имя — не платформа.
assert.deepEqual(
  availableMethods({ host: 'notvercel.app.example.com', publicPlatform: false })
    .length,
  3
);

console.log('verification: ok');
