/**
 * Конфиг сегментов App Router (`export const revalidate` и соседи) —
 * литералы, равные константам библиотек.
 *
 * Next 15 читает эти экспорты СТАТИЧЕСКИ, по исходнику: импортированную
 * константу (`export const revalidate = BLOG_REVALIDATE_SECONDS`) он
 * отвергает ошибкой сборки (Next 14 брал значение из загруженного модуля, и
 * так было написано везде). Поэтому в файлах маршрутов стоят числа, а здесь:
 *
 *  1. каждый такой экспорт в `src/app` — `export const <ключ> = <литерал>`
 *     (число, строка, true/false); `let`/`var`, аннотация типа, `as`,
 *     экспорт списком и реэкспорт — отказ (п. 0 проверяет саму проверку);
 *  2. `revalidate` блога и его лент/карт сайта = `BLOG_REVALIDATE_SECONDS`,
 *     страницы ролика = `SHARED_VIDEO_REVALIDATE_SECONDS` — константа и
 *     литерал не разъедутся молча.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BLOG_REVALIDATE_SECONDS } from '../src/lib/blog-api';
import { SHARED_VIDEO_REVALIDATE_SECONDS } from '../src/lib/shared-video-api';

const APP = path.join(__dirname, '..', 'src', 'app');
const SEGMENT_KEYS = [
  'revalidate',
  'dynamic',
  'dynamicParams',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
];
const KEYS = SEGMENT_KEYS.join('|');
const LITERAL_RE = /^(?:\d+|false|true|'[^']*'|"[^"]*")$/;

/** Исходник без комментариев: пояснения вправе цитировать запрещённые формы. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * Нарушения формы конфига сегмента в одном файле. Разрешено ровно
 * `export const <ключ> = <литерал>;`. Ловятся: идентификатор или выражение
 * (`= X`, `= 900 as number`, `= X as const`), аннотация типа (`: number`),
 * `let`/`var`, экспорт списком (`export { revalidate }`,
 * `export { x as revalidate }`), реэкспорт (`… from '…'`, `export *`).
 */
function segmentProblems(src: string): { seen: number; problems: string[] } {
  const code = codeOf(src);
  const problems: string[] = [];
  let seen = 0;
  const decl = new RegExp(
    `^\\s*export\\s+(const|let|var)\\s+(${KEYS})\\b\\s*(:[^=]*)?=\\s*([^;\\n]+)`,
    'gm',
  );
  for (const [, kind, key, type, value] of code.matchAll(decl)) {
    seen++;
    if (kind !== 'const') problems.push(`\`export ${kind} ${key}\` — только const`);
    if (type) problems.push(`\`${key}${type.trimEnd()}\` — без аннотации типа`);
    if (!LITERAL_RE.test(value.trim())) {
      problems.push(`\`${key} = ${value.trim()}\` — не литерал`);
    }
  }
  for (const [list] of code.matchAll(/\bexport\s*(?:type\s*)?\{[^}]*\}/g)) {
    const names = list
      .replace(/^export\s*(?:type\s*)?\{|\}$/g, '')
      .split(',')
      .map((spec) => spec.trim().split(/\s+as\s+/).pop()!.trim());
    for (const name of names) {
      if (SEGMENT_KEYS.includes(name)) {
        seen++;
        problems.push(`\`${list.replace(/\s+/g, ' ')}\` — конфиг сегмента списком/реэкспортом`);
      }
    }
  }
  if (/\bexport\s*\*/.test(code)) {
    problems.push('`export * from` — может протащить конфиг сегмента мимо проверки');
  }
  return { seen, problems };
}

// ── 0. Сама проверка ловит все формы ──
for (const bad of [
  'export const revalidate = BLOG_REVALIDATE_SECONDS;',
  'export const revalidate = 900 as number;',
  'export const revalidate = X as const;',
  'export const revalidate: number = 900;',
  'export let revalidate = 900;',
  'export var dynamic = "force-dynamic";',
  "export const dynamic =\n  MODE;",
  'const revalidate = 900;\nexport { revalidate };',
  'const r = 900;\nexport { r as revalidate };',
  "export { revalidate } from '../lib/blog-api';",
  "export { BLOG_REVALIDATE_SECONDS as revalidate } from '../lib/blog-api';",
  "export * from '../lib/segment';",
]) {
  assert.ok(segmentProblems(bad).problems.length > 0, `не поймано: ${bad}`);
}
for (const good of [
  'export const revalidate = 900;',
  "export const dynamic = 'force-dynamic';",
  'export const dynamicParams = false;',
  '// export const revalidate = X;\nexport const revalidate = 60;',
  "export { helper } from './helper';",
]) {
  assert.deepEqual(segmentProblems(good).problems, [], `ложная тревога: ${good}`);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

/** `revalidate` маршрута по его исходнику; `undefined` — не задан. */
function revalidateOf(rel: string): number | undefined {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  const m = /^export const revalidate = (\d+);/m.exec(src);
  return m ? Number(m[1]) : undefined;
}

// ── 1. Только литералы, только `export const` ──
let exportsSeen = 0;
const problems: string[] = [];
for (const file of walk(APP).filter((f) => /\.tsx?$/.test(f))) {
  const r = segmentProblems(fs.readFileSync(file, 'utf8'));
  exportsSeen += r.seen;
  for (const p of r.problems) problems.push(`${path.relative(APP, file)}: ${p}`);
}
assert.deepEqual(
  problems,
  [],
  `конфиг сегмента не в форме «export const <ключ> = <литерал>;» — Next 15 его не прочтёт:\n${problems.join('\n')}`,
);
assert.ok(exportsSeen >= 8, `подозрительно мало конфигов сегментов: ${exportsSeen}`);

// ── 2. Литералы = константы ──
const BLOG_ROUTES = [
  '[locale]/blog/page.tsx',
  '[locale]/blog/[slug]/page.tsx',
  'feed.xml/route.ts',
  'feed/[category]/route.ts',
  'sitemap.ts',
  'sitemap-news.xml/route.ts',
];
for (const rel of BLOG_ROUTES) {
  assert.equal(
    revalidateOf(rel),
    BLOG_REVALIDATE_SECONDS,
    `${rel}: revalidate ≠ BLOG_REVALIDATE_SECONDS (${BLOG_REVALIDATE_SECONDS})`,
  );
}
assert.equal(
  revalidateOf('video/[id]/page.tsx'),
  SHARED_VIDEO_REVALIDATE_SECONDS,
  `video/[id]/page.tsx: revalidate ≠ SHARED_VIDEO_REVALIDATE_SECONDS (${SHARED_VIDEO_REVALIDATE_SECONDS})`,
);

console.log(
  `segment-config: ${exportsSeen} конфигов сегментов — литералы; ` +
    `revalidate блога ${BLOG_ROUTES.length} маршрутов = ${BLOG_REVALIDATE_SECONDS} с, ролика = ${SHARED_VIDEO_REVALIDATE_SECONDS} с`,
);
