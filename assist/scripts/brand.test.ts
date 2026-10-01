import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as brand from '../src/kit/brand';

// Публичные имена — только из brand.ts (контракт Э0 п.4): ни один другой
// файл кита и приложения не пишет их литералом. Иначе переименование
// бренда оставит старое имя в каком-нибудь экране.
const NAMES = ['v4c-verify', 'X-Telegram-App', '.well-known'];
function walk(dir: URL): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const u = new URL(name, dir);
    if (/\.(ts|tsx)$/.test(name)) return [u];
    if (name.includes('.')) return [];
    return walk(new URL(`${name}/`, dir));
  });
}
for (const file of walk(new URL('../src/', import.meta.url))) {
  if (file.pathname.endsWith('/kit/brand.ts')) continue;
  const text = readFileSync(file, 'utf8')
    // комментарии могут ссылаться на формат — проверяем код
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const n of NAMES) {
    assert.ok(
      !text.includes(n),
      `${file.pathname}: литерал «${n}» мимо brand.ts`
    );
  }
}

// Формат — дословно TZ-QA-TMA.md §2.4.
assert.equal(brand.VERIFY_TXT_PREFIX, '_v4c-verify');
assert.equal(brand.VERIFY_TXT_KEY, 'v4c-verify');
assert.equal(brand.VERIFY_FILE_PATH, '/.well-known/v4c-verify.txt');
assert.equal(brand.VERIFY_META_NAME, 'v4c-verify');
assert.equal(brand.TELEGRAM_APP_HEADER, 'X-Telegram-App');

// Зеркало на бэкенде (sites-backend/src/brand.ts, контракт п.4): когда
// оно есть, значения обязаны совпадать — иначе фронт выдаст инструкцию,
// которую сервер не ищет.
const backend = new URL('../../sites-backend/src/brand.ts', import.meta.url);
if (existsSync(backend)) {
  const src = readFileSync(backend, 'utf8');
  const MIRRORED = {
    VERIFY_TXT_PREFIX: brand.VERIFY_TXT_PREFIX,
    VERIFY_TXT_KEY: brand.VERIFY_TXT_KEY,
    VERIFY_FILE_PATH: brand.VERIFY_FILE_PATH,
    VERIFY_META_NAME: brand.VERIFY_META_NAME,
    TELEGRAM_APP_HEADER: brand.TELEGRAM_APP_HEADER,
  };
  for (const [name, value] of Object.entries(MIRRORED)) {
    const m = src.match(
      new RegExp(`export const ${name}\\s*=\\s*['"]([^'"]*)['"]`)
    );
    assert.ok(m, `sites-backend/src/brand.ts: нет константы ${name}`);
    assert.equal(m![1], value, `${name}: фронт «${value}», бэкенд «${m![1]}»`);
  }
  console.log('brand: зеркало sites-backend/src/brand.ts сверено');
} else {
  console.log(
    'brand: sites-backend/src/brand.ts ещё нет — сверка зеркала пропущена'
  );
}

console.log('brand: ok');
