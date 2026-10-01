import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { en } from '../src/kit/dictionaries/en';
import { ru } from '../src/kit/dictionaries/ru';
import { uk } from '../src/kit/dictionaries/uk';
import { ApiError } from '../src/kit/envelope';
import {
  API_ERROR_CODES,
  CHECK_CODES,
  checkText,
  errorText,
} from '../src/kit/errors';

// ── Коды — зеркало сервера ────────────────────────────────────────────
function serverUnion(rel: string, typeName: string): string[] {
  const src = readFileSync(
    new URL(
      `../../sites-backend/src/modules/site-core/${rel}`,
      import.meta.url
    ),
    'utf8'
  );
  const m = src.match(new RegExp(`export type ${typeName}\\s*=([^;]*);`));
  assert.ok(m, `${rel}: нет типа ${typeName}`);
  return [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
}
assert.deepEqual(
  [...API_ERROR_CODES].sort(),
  serverUnion('site-core.constants.ts', 'SiteCoreCode'),
  'error.code: список фронта расходится с SiteCoreCode сервера'
);
assert.deepEqual(
  [...CHECK_CODES].sort(),
  serverUnion('ownership/ownership-checker.ts', 'CheckCode'),
  'lastCheck.code: список фронта расходится с CheckCode сервера'
);

// ── Каждый код переведён на все три языка ─────────────────────────────
const dicts = { uk, ru, en };
for (const [lang, d] of Object.entries(dicts)) {
  const api = d.errors.api as Record<string, string>;
  const check = d.errors.check as Record<string, string>;
  assert.deepEqual(Object.keys(api).sort(), [...API_ERROR_CODES].sort(), lang);
  assert.deepEqual(Object.keys(check).sort(), [...CHECK_CODES].sort(), lang);
  for (const c of API_ERROR_CODES) {
    assert.ok(api[c].trim().length > 10, `${lang}.errors.api.${c}`);
    // Через errorText — именно этот текст, не серверный русский.
    const e = new ApiError(c, 'серверный текст', 409);
    assert.equal(errorText(e, d), api[c], `${lang}: ${c}`);
  }
  for (const c of CHECK_CODES) {
    assert.ok(check[c].trim().length > 10, `${lang}.errors.check.${c}`);
    assert.equal(
      checkText({ ok: c === 'VERIFIED', code: c, message: 'серв' }, d),
      check[c],
      `${lang}: ${c}`
    );
  }
}
// uk и en — действительно переводы, а не копия русского.
for (const c of API_ERROR_CODES) {
  assert.notEqual(uk.errors.api[c], ru.errors.api[c], `uk = ru: ${c}`);
  assert.notEqual(en.errors.api[c], ru.errors.api[c], `en = ru: ${c}`);
}
for (const c of CHECK_CODES) {
  assert.notEqual(uk.errors.check[c], ru.errors.check[c], `uk = ru: ${c}`);
  assert.notEqual(en.errors.check[c], ru.errors.check[c], `en = ru: ${c}`);
}

// ── Запасные пути ─────────────────────────────────────────────────────
assert.equal(
  errorText(new ApiError('network', 'x', 0), en),
  en.errors.client.network
);
assert.equal(
  errorText(new ApiError('no_telegram', 'x', 401), uk),
  uk.errors.client.noIdentity
);
assert.equal(
  errorText(new ApiError('UNAUTHORIZED', 'x', 401), ru),
  ru.errors.client.unauthorized
);
assert.equal(
  errorText(new ApiError('RATE_LIMIT_EXCEEDED', 'x', 429), en),
  en.errors.client.rateLimited
);
assert.equal(
  errorText(new ApiError('INTERNAL_SERVER_ERROR', 'Внутр.', 500), uk),
  uk.errors.client.server
);
// Неизвестный код — текст сервера (конкретнее общего).
assert.equal(
  errorText(new ApiError('BAD_REQUEST', 'Укажите название сайта', 400), en),
  'Укажите название сайта'
);
assert.equal(errorText(new Error(''), en), en.common.error);
assert.equal(errorText('строка', en), en.common.error);
// Неизвестный итог проверки — текст сервера, без него — «не нашли».
assert.equal(
  checkText({ ok: false, code: 'NEW', message: 'серв' }, en),
  'серв'
);
assert.equal(checkText({ ok: false }, en), en.verify.notFound);
assert.equal(checkText({ ok: true }, uk), uk.errors.check.VERIFIED);

console.log('errors: ok');
