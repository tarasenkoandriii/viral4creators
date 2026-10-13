/**
 * Служебные route handlers (аудит P-F S3-1): `POST /api/revalidate` — без
 * секрета маршрута нет (404), без верного `Bearer` — 401 (позитивный путь —
 * e2e); `/.well-known/v4c-verify.txt` — токен первой строкой, негодный или
 * не заданный — 404.
 */
import assert from 'node:assert/strict';
import { GET as verify } from '../src/app/.well-known/v4c-verify.txt/route';
import { POST as revalidate } from '../src/app/api/revalidate/route';

let n = 0;
async function main() {
  const env = process.env;
  const SECRET = 'unit-secret-0123456789';
  // verify.txt
  for (const [tok, status, body] of [
    ['tok_ABC-123456', 200, 'tok_ABC-123456\n'],
    ['  tok_ABC-123456  ', 200, 'tok_ABC-123456\n'],
    [undefined, 404, null],
    ['', 404, null],
    ['short', 404, null],
    ['tok with space', 404, null],
    ['tok\nInjected: 1', 404, null],
    ['<script>alert(1)</script>', 404, null],
  ] as const) {
    if (tok === undefined) delete env.PUBLISHER_OWNERSHIP_TOKEN;
    else env.PUBLISHER_OWNERSHIP_TOKEN = tok;
    const r = verify();
    n++;
    assert.equal(r.status, status, `verify.txt «${tok}» → ${r.status}`);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    if (body) assert.equal(await r.text(), body, 'тело — токен и перевод строки');
  }
  // revalidate: секрет не задан/короткий — 404.
  const call = (auth?: string) =>
    revalidate(
      new Request('https://x/api/revalidate', {
        method: 'POST',
        headers: auth === undefined ? {} : { authorization: auth },
      }),
    );
  for (const s of [undefined, '', 'short-secret']) {
    if (s === undefined) delete env.PUBLISHER_REVALIDATE_SECRET;
    else env.PUBLISHER_REVALIDATE_SECRET = s;
    n++;
    assert.equal((await call(`Bearer ${s ?? ''}`)).status, 404, `секрет «${s}» — маршрута нет`);
  }
  env.PUBLISHER_REVALIDATE_SECRET = SECRET;
  for (const auth of [
    undefined,
    '',
    'Bearer',
    `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`,
    `bearer ${SECRET}`,
    `Bearer  ${SECRET}`,
    SECRET,
    `Basic ${SECRET}`,
  ]) {
    n++;
    const r = await call(auth);
    assert.equal(r.status, 401, `Authorization «${auth}» → ${r.status}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  console.log(
    `ok   routes: ${n} проверок — verify.txt (формат токена, 404), /api/revalidate (404 без секрета, 401 на 9 вариантов неверного Authorization)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
