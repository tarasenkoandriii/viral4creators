import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as brand from '../src/shared/brand';

// 1. Зеркало sites-backend/src/brand.ts (блок «Э2»): значения обязаны
//    совпадать — иначе загрузчик зовёт путь, который сервер не отдаёт.
const backend = new URL('../../sites-backend/src/brand.ts', import.meta.url);
assert.ok(existsSync(backend), 'нет sites-backend/src/brand.ts');
const src = readFileSync(backend, 'utf8');
for (const [name, value] of Object.entries(brand)) {
  if (typeof value === 'function') continue; // функции — сверка ниже
  const m = src.match(
    new RegExp(`export const ${name}\\s*=\\s*(?:'([^']*)'|(\\d+));`)
  );
  assert.ok(m, `sites-backend/src/brand.ts: нет константы ${name}`);
  const backendValue = m![1] ?? Number(m![2]);
  assert.equal(
    backendValue,
    value,
    `${name}: виджет «${String(value)}», бэкенд «${String(backendValue)}»`
  );
}

// 1б. Функции бренда — те же результаты, что у бэкенда (имя cookie
//     указателя: сервер читает cookie СВОЕГО pk — расхождение = потеря
//     диалогов). Бэкендовый brand.ts без импортов — берём его как есть.
const backendBrand = (await import(backend.href)) as typeof brand;
for (const pk of [
  'pk_live_a',
  'pk_live_b',
  'pk_test_x',
  'pk_live_' + 'я'.repeat(30),
]) {
  assert.equal(
    brand.widgetResumeCookieName(pk),
    backendBrand.widgetResumeCookieName(pk),
    `widgetResumeCookieName(${pk}): расхождение с бэкендом`
  );
  assert.match(brand.widgetResumeCookieName(pk), /^__Host-[A-Za-z0-9_]+$/);
}
assert.notEqual(
  brand.widgetResumeCookieName('pk_live_a'),
  brand.widgetResumeCookieName('pk_live_b')
);

// 2. Литералы публичных имён — только в src/shared/brand.ts.
const NAMES = [
  brand.WIDGET_GLOBAL,
  brand.WIDGET_PREVIEW_PARAM,
  brand.WIDGET_PK_LIVE_PREFIX,
  brand.WIDGET_PK_TEST_PREFIX,
  brand.WIDGET_MESSAGE_NS,
  brand.WIDGET_RESUME_COOKIE,
  'example.invalid',
];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const root = new URL('../src', import.meta.url).pathname;
for (const file of walk(root)) {
  if (file.endsWith('/shared/brand.ts')) continue;
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const n of NAMES) {
    assert.ok(!code.includes(n), `${file}: литерал «${n}» мимо brand.ts`);
  }
}
console.log('brand: зеркало sites-backend/src/brand.ts сверено, литералов нет');
