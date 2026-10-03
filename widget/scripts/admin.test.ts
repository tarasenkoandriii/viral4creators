/**
 * Э7 «Админка» в виджете: протокол чанк `admin.js` ↔ iframe `wa.`
 * (свой ns, строгий разбор, JWT — только форма), и граница кода: публичный
 * чат и загрузчик не импортируют код «Админки», а «Админка» — код чата
 * «Сайта» (разные origin и storage, У-13/У-18).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
  adminEnvelope,
  isAdminPk,
  isJwt,
  jwtClaims,
  parseAdminFrameMessage,
  parseAdminParentMessage,
} from '../src/shared/admin-protocol';
import {
  ADMIN_MESSAGE_NS,
  WIDGET_MESSAGE_NS,
  WIDGET_PK_LIVE_PREFIX,
} from '../src/shared/brand';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 'emp-Ш', iat: 100, exp: 700 })}.${'s'.repeat(43)}`;
const pk = `${WIDGET_PK_LIVE_PREFIX}abc123DEF456ghi7`;

assert.notEqual(ADMIN_MESSAGE_NS, WIDGET_MESSAGE_NS, 'свой ns «Админки»');
assert.ok(isAdminPk(pk));
assert.ok(!isAdminPk('pk_live_<script>'));
assert.ok(isJwt(jwt));
assert.ok(!isJwt('a.b'));
assert.deepEqual(jwtClaims(jwt), { sub: 'emp-Ш', iat: 100, exp: 700 });
assert.equal(jwtClaims('x.y.z'), null);

// Сообщения родителя: только свой ns/v и проверенные поля.
assert.deepEqual(
  parseAdminParentMessage(adminEnvelope({ type: 'identity', jwt })),
  { type: 'identity', jwt }
);
assert.equal(
  parseAdminParentMessage({
    ns: WIDGET_MESSAGE_NS,
    v: 1,
    type: 'identity',
    jwt,
  }),
  null,
  'сообщение публичного виджета «Админка» не принимает'
);
assert.equal(
  parseAdminParentMessage(adminEnvelope({ type: 'identity', jwt: 'x' })),
  null
);
assert.equal(
  parseAdminParentMessage(
    adminEnvelope({ type: 'init', pk, parentOrigin: 'javascript:alert(1)' })
  ),
  null
);
assert.deepEqual(
  parseAdminParentMessage(
    adminEnvelope({
      type: 'init',
      pk,
      parentOrigin: 'https://admin.shop.com',
      lang: 'xx',
    })
  ),
  { type: 'init', pk, parentOrigin: 'https://admin.shop.com', lang: null }
);
// Из iframe наружу — только ready/need-identity/close: «отдай историю» нет.
assert.deepEqual(parseAdminFrameMessage(adminEnvelope({ type: 'ready' })), {
  type: 'ready',
});
assert.equal(parseAdminFrameMessage(adminEnvelope({ type: 'history' })), null);

// Граница кода: публичные части виджета не импортируют «Админку» и наоборот.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.(ts|tsx)$/.test(n)
        ? [p]
        : [];
  });
}
const src = new URL('../src', import.meta.url).pathname;
const importsOf = (f: string) =>
  [
    ...readFileSync(f, 'utf8').matchAll(
      /from\s+'([^']+)'|import\(\s*'([^']+)'/g
    ),
  ].map((m) => m[1] ?? m[2]);
for (const f of walk(src)) {
  const rel = f.slice(src.length + 1);
  const specs = importsOf(f);
  if (
    !/^(admin|admin-chat)\//.test(rel) &&
    !rel.endsWith('shared/admin-protocol.ts')
  ) {
    assert.ok(
      !specs.some((s) => /(^|\/)(admin|admin-chat)\/|admin-protocol/.test(s)),
      `${rel}: публичный код виджета импортирует «Админку»`
    );
  }
  if (/^(admin|admin-chat)\//.test(rel)) {
    assert.ok(
      !specs.some((s) =>
        /\.\.\/(chat|loader|act|engage|voice|vt|check|picker|highlight)\//.test(
          s
        )
      ),
      `${rel}: «Админка» импортирует код публичного виджета`
    );
  }
}
console.log('admin: протокол «Админки» и граница кода — ок');
