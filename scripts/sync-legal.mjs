#!/usr/bin/env node
/**
 * doc/legal/*.md → landing/src/lib/legal-content.ts и
 * frontend/src/lib/legal-content.ts.
 *
 * Один источник правды: юридические тексты живут в doc/legal (там их
 * правит владелец продукта и юрист), а оба приложения читают
 * сгенерированный TS-модуль — без рантайм-чтения файлов, чтобы страницы
 * оставались статикой на Vercel. Версия документа берётся из строки
 * «**Версия: YYYY-MM-DD.**» и должна совпадать с TERMS_VERSION в
 * backend/src/modules/legal/legal.service.ts (скрипт это проверяет).
 *
 *   node scripts/sync-legal.mjs        # записать
 *   node scripts/sync-legal.mjs --check # только проверить (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  { key: 'offer', file: 'offer.md', slug: 'offer', title: 'Договор публичной оферты' },
  { key: 'termsOfUse', file: 'terms-of-use.md', slug: 'terms-of-use', title: 'Условия использования' },
];

function versionOf(md, file) {
  const m = md.match(/\*\*Версия:\s*(\d{4}-\d{2}-\d{2})\.?\*\*/);
  if (!m) throw new Error(`${file}: не найдена строка «**Версия: YYYY-MM-DD.**»`);
  return m[1];
}

const docs = DOCS.map((d) => {
  const md = readFileSync(join(root, 'doc/legal', d.file), 'utf8');
  return { ...d, markdown: md, version: versionOf(md, d.file) };
});

const versions = [...new Set(docs.map((d) => d.version))];
if (versions.length !== 1) {
  throw new Error(`Версии документов расходятся: ${versions.join(', ')}`);
}
const version = versions[0];

const backend = readFileSync(
  join(root, 'backend/src/modules/legal/legal.service.ts'),
  'utf8'
);
const backendVersion = backend.match(/TERMS_VERSION\s*=\s*'([^']+)'/)?.[1];
if (backendVersion !== version) {
  throw new Error(
    `TERMS_VERSION в backend (${backendVersion}) не совпадает с версией документов (${version})`
  );
}

const header = `/**
 * СГЕНЕРИРОВАНО scripts/sync-legal.mjs — не редактировать руками.
 * Источник: doc/legal/*.md. После правки документов запустите
 * \`node scripts/sync-legal.mjs\`.
 */

export const LEGAL_VERSION = '${version}';

export interface LegalDoc {
  slug: string;
  title: string;
  version: string;
  markdown: string;
}

`;

const body =
  docs
    .map(
      (d) =>
        `export const ${d.key.toUpperCase()}_DOC: LegalDoc = {\n  slug: '${d.slug}',\n  title: ${JSON.stringify(d.title)},\n  version: '${d.version}',\n  markdown: ${JSON.stringify(d.markdown)},\n};\n`
    )
    .join('\n') +
  `\nexport const LEGAL_DOCS: LegalDoc[] = [${docs
    .map((d) => `${d.key.toUpperCase()}_DOC`)
    .join(', ')}];\n`;

const out = header + body;
const targets = [
  join(root, 'landing/src/lib/legal-content.ts'),
  join(root, 'frontend/src/lib/legal-content.ts'),
];

const check = process.argv.includes('--check');
let changed = 0;
for (const target of targets) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    /* нет файла — считаем изменившимся */
  }
  if (current === out) continue;
  changed += 1;
  if (!check) writeFileSync(target, out);
}

if (check && changed > 0) {
  console.error(
    `sync-legal: ${changed} файл(ов) устарели — запустите node scripts/sync-legal.mjs`
  );
  process.exit(1);
}
console.log(
  check
    ? `sync-legal: всё синхронизировано (версия ${version})`
    : `sync-legal: обновлено файлов ${changed}, версия ${version}`
);
