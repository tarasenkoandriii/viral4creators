/**
 * Конфиг сегментов App Router (`export const revalidate/dynamic/runtime…`)
 * — только литералы, и окно ревалидации лент/карт сайта совпадает с
 * PROFILE_REVALIDATE_SECONDS.
 *
 * Зачем (заход 12, переход на Next 15): Next 15 разбирает эти экспорты
 * статически и на идентификатор (`revalidate = PROFILE_REVALIDATE_SECONDS`)
 * печатает «can't recognize the exported `config` field» — Next 14 молча
 * брал значение из модуля. Поэтому в пяти файлах стоит литерал `60`, а
 * этот тест следит, чтобы литерал не разошёлся с константой в
 * lib/api.ts и чтобы идентификатор не вернулся ни в один сегмент — ни
 * выражением (`as`), ни через `let`/аннотацию, ни экспортом списком или
 * реэкспортом (раунд исправлений захода 12).
 *
 * Запуск: `npm test` в marketplace.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PROFILE_REVALIDATE_SECONDS } from '../src/lib/api';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const APP = path.join(__dirname, '..', 'src', 'app');

/** Файлы, где окно = PROFILE_REVALIDATE_SECONDS (см. комментарии в них). */
const PROFILE_WINDOW_FILES = [
  'sitemap.ts',
  'feed.json/route.ts',
  'feed.xml/route.ts',
  'sitemap-news.xml/route.ts',
  'auctions/feed/google-ads.xml/route.ts',
];

/** Ключи конфига сегмента, которые Next 15 читает статически. */
const SEGMENT_KEYS = ['revalidate', 'dynamic', 'dynamicParams', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

console.log('конфиг сегментов');

it('ленты и карты сайта ревалидируются раз в PROFILE_REVALIDATE_SECONDS', () => {
  for (const rel of PROFILE_WINDOW_FILES) {
    const text = readFileSync(path.join(APP, rel), 'utf8');
    const m = /^export const revalidate = (\d+);$/m.exec(text);
    assert.ok(m, `${rel}: нет «export const revalidate = <число>;»`);
    assert.equal(Number(m[1]), PROFILE_REVALIDATE_SECONDS, `${rel}: окно разошлось с lib/api.ts`);
  }
});

const KEYS = SEGMENT_KEYS.join('|');
const LITERAL_RE = /^(\d+|false|true|'[^']*'|"[^"]*"|\[[^\]]*\])$/;

/** Исходник без комментариев: пояснения вправе цитировать запрещённые формы. */
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * Нарушения формы конфига сегмента в файле. Разрешено ровно
 * `export const <ключ> = <литерал>;`. Ловятся: идентификатор или выражение
 * (`= X`, `= 60 as number`, `= X as const`), аннотация типа, `let`/`var`,
 * экспорт списком (`export { revalidate }`, `export { x as revalidate }`),
 * реэкспорт (`… from '…'`, `export *`).
 */
function segmentProblems(src: string): string[] {
  const code = codeOf(src);
  const problems: string[] = [];
  const decl = new RegExp(`^\\s*export\\s+(const|let|var)\\s+(${KEYS})\\b\\s*(:[^=]*)?=\\s*([^;\\n]+)`, 'gm');
  for (const [, kind, key, type, value] of code.matchAll(decl)) {
    if (kind !== 'const') problems.push(`export ${kind} ${key} — только const`);
    if (type) problems.push(`${key}${type.trimEnd()} — без аннотации типа`);
    if (!LITERAL_RE.test(value.trim())) problems.push(`${key} = ${value.trim()} — не литерал`);
  }
  for (const [list] of code.matchAll(/\bexport\s*(?:type\s*)?\{[^}]*\}/g)) {
    const names = list
      .replace(/^export\s*(?:type\s*)?\{|\}$/g, '')
      .split(',')
      .map((spec) => spec.trim().split(/\s+as\s+/).pop()!.trim());
    if (names.some((n) => SEGMENT_KEYS.includes(n))) problems.push(`${list.replace(/\s+/g, ' ')} — конфиг сегмента списком/реэкспортом`);
  }
  if (/\bexport\s*\*/.test(code)) problems.push('export * from — может протащить конфиг сегмента мимо проверки');
  return problems;
}

it('проверка формы ловит идентификатор, as, аннотацию, let/var, экспорт списком и реэкспорт', () => {
  for (const bad of [
    'export const revalidate = PROFILE_REVALIDATE_SECONDS;',
    'export const revalidate = 60 as number;',
    'export const revalidate = X as const;',
    'export const revalidate: number = 60;',
    'export let revalidate = 60;',
    'export var dynamic = "force-dynamic";',
    'export const dynamic =\n  MODE;',
    'const revalidate = 60;\nexport { revalidate };',
    'const r = 60;\nexport { r as revalidate };',
    "export { revalidate } from '../lib/api';",
    "export { PROFILE_REVALIDATE_SECONDS as revalidate } from '../lib/api';",
    "export * from '../lib/segment';",
  ]) {
    assert.ok(segmentProblems(bad).length > 0, `не поймано: ${bad}`);
  }
  for (const good of [
    'export const revalidate = 60;',
    "export const runtime = 'edge';",
    "export const preferredRegion = ['fra1'];",
    '// export const revalidate = X;\nexport const revalidate = 60;',
    "export { helper } from './helper';",
  ]) {
    assert.deepEqual(segmentProblems(good), [], `ложная тревога: ${good}`);
  }
});

it('конфиг сегментов — только «export const <ключ> = <литерал>;»', () => {
  const bad = walk(APP).flatMap((file) =>
    segmentProblems(readFileSync(file, 'utf8')).map((p) => `${path.relative(APP, file)}: ${p}`),
  );
  assert.deepEqual(bad, []);
});

console.log(`\n${passed} passed`);
