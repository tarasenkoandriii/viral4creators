import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { ApiError } from '../src/kit/envelope';
import { API_ERROR_CODES } from '../src/kit/errors';
import { en as kitEn } from '../src/kit/dictionaries/en';
import { ru as kitRu } from '../src/kit/dictionaries/ru';
import { uk as kitUk } from '../src/kit/dictionaries/uk';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import {
  ClientKnowledgeError,
  KNOWLEDGE_ERROR_CODES,
  knowledgeErrorText,
} from '../src/lib/knowledge-errors';

const MINE = [...KNOWLEDGE_ERROR_CODES] as string[];
const KIT = [...API_ERROR_CODES] as string[];

// ── 1. Список контракта Э1 §6 — весь здесь (или в ките) ──────────────
const CONTRACT = [
  'URL_REJECTED',
  'OPTED_OUT',
  'BLOCKED_CATEGORY',
  'SANDBOX_DISABLED',
  'SANDBOX_LIMIT_IP',
  'SANDBOX_BUDGET',
  'SANDBOX_QUESTIONS_EXHAUSTED',
  'SANDBOX_EXPIRED',
  'HOST_NOT_VERIFIED',
  'KNOWLEDGE_SOURCE_LIMIT',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TYPE',
  'DOCUMENT_NO_TEXT',
  'VERSION_NOT_ROLLBACKABLE',
  'VERSION_NOT_HELD',
  'HOT_PAGES_LIMIT',
  'LEARNING_BUDGET_EXHAUSTED',
];
for (const c of CONTRACT) {
  assert.ok(
    MINE.includes(c) || KIT.includes(c),
    `код контракта без перевода: ${c}`
  );
}
// Код ядра не дублируется (перевод один — в ките).
for (const c of MINE) assert.ok(!KIT.includes(c), `дубль кода кита: ${c}`);
assert.equal(new Set(MINE).size, MINE.length, 'дубли в списке');

// ── 2. Сервер: всё, что бросают модули знаний/песочницы, переведено ──
const MODULES = new URL('../../sites-backend/src/modules/', import.meta.url);
const errorsTs = new URL('assist-knowledge-core/documents/errors.ts', MODULES);
if (existsSync(errorsTs)) {
  const src = readFileSync(errorsTs, 'utf8');
  const m = src.match(/export type E1Code\s*=([^;]*);/);
  assert.ok(m, 'errors.ts: нет E1Code');
  for (const [, c] of m![1].matchAll(/'([A-Z_]+)'/g)) {
    assert.ok(MINE.includes(c) || KIT.includes(c), `E1Code ${c} без перевода`);
  }
}
// Плюс скан вызовов: e1Error(…, 'X', …) и knowledgeError('X', …) — так
// ловится код, брошенный мимо объединения.
function walk(dir: URL): URL[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const u = new URL(name, dir);
    if (name.endsWith('.ts')) return name.endsWith('.spec.ts') ? [] : [u];
    if (/^[\w-]+$/.test(name)) return walk(new URL(`${name}/`, dir));
    return [];
  });
}
// Общие коды Nest/фильтра — переводятся запасным путём кита (errorText).
const GENERIC = ['NOT_FOUND', 'BAD_REQUEST', 'FORBIDDEN', 'CONFLICT'];
let scanned = 0;
for (const mod of [
  'assist-knowledge-core',
  'assist-site-knowledge',
  'assist-admin-knowledge',
  'assist-sandbox',
]) {
  for (const f of walk(new URL(`${mod}/`, MODULES))) {
    const src = readFileSync(f, 'utf8');
    for (const [, c] of src.matchAll(
      /(?:e1Error|knowledgeError)\(\s*(?:\d+\s*,\s*)?'([A-Z][A-Z0-9_]+)'/g
    )) {
      scanned += 1;
      assert.ok(
        MINE.includes(c) || KIT.includes(c) || GENERIC.includes(c),
        `${f.pathname.split('/modules/')[1]}: код ${c} без перевода`
      );
    }
  }
}
console.log(`  (сервер: проверено бросков кодов — ${scanned})`);

// ── 3. Перевод: три языка, не копия русского, через knowledgeErrorText ─
const pairs = [
  [appUk, kitUk],
  [appRu, kitRu],
  [appEn, kitEn],
] as const;
for (const [app, kit] of pairs) {
  assert.deepEqual(Object.keys(app.errors).sort(), [...MINE].sort());
  for (const c of KNOWLEDGE_ERROR_CODES) {
    assert.ok(app.errors[c].trim().length > 10, c);
    const e = new ApiError(c, 'серверный текст', 409);
    assert.equal(knowledgeErrorText(e, app, kit), app.errors[c], c);
  }
  // Код ядра — перевод кита, не серверный русский.
  assert.equal(
    knowledgeErrorText(new ApiError('HOST_NOT_VERIFIED', 'x', 409), app, kit),
    kit.errors.api.HOST_NOT_VERIFIED
  );
  // 403 без своего кода — «нет доступа к знаниям».
  assert.equal(
    knowledgeErrorText(new ApiError('FORBIDDEN', 'Forbidden', 403), app, kit),
    app.knowledge.noAccess
  );
  assert.equal(
    knowledgeErrorText(new ApiError('http_403', '', 403), app, kit),
    app.knowledge.noAccess
  );
  assert.equal(
    knowledgeErrorText(
      new ApiError('PRODUCT_ROLE_REQUIRED', 'x', 403),
      app,
      kit
    ),
    kit.errors.api.PRODUCT_ROLE_REQUIRED
  );
  // Ошибки клиента до запроса — тем же текстом, что серверные.
  assert.equal(
    knowledgeErrorText(
      new ClientKnowledgeError('DOCUMENT_TOO_LARGE'),
      app,
      kit
    ),
    app.errors.DOCUMENT_TOO_LARGE
  );
  assert.equal(
    knowledgeErrorText(new ClientKnowledgeError('UPLOAD_FAILED'), app, kit),
    app.knowledge.sources.uploadFailed
  );
  assert.equal(
    knowledgeErrorText(new ApiError('network', 'x', 0), app, kit),
    kit.errors.client.network
  );
}
for (const c of KNOWLEDGE_ERROR_CODES) {
  assert.notEqual(appUk.errors[c], appRu.errors[c], `uk = ru: ${c}`);
  assert.notEqual(appEn.errors[c], appRu.errors[c], `en = ru: ${c}`);
}
// UI «сейчас недоступно — оставьте заявку» (контракт Э1 §6).
assert.ok(/заявк/.test(appRu.errors.SANDBOX_BUDGET));
assert.ok(/заявк/.test(appUk.errors.SANDBOX_BUDGET));
assert.ok(/request/.test(appEn.errors.SANDBOX_BUDGET));

console.log('knowledge-errors: ok');
