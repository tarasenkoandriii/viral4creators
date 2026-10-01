/**
 * Юридические черновики (§3.15, §13): все три на месте, помечены
 * черновиком, плейсхолдеры подставлены, разметка разбирается портом
 * `legal-markdown`, и в тексте нет того, что противоречило бы сайту.
 */
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand';
import { parseLegalMarkdown } from '../src/lib/legal-markdown';
import { LEGAL_DOCS, legalMarkdown, legalTitle } from '../src/lib/legal-docs';

for (const doc of LEGAL_DOCS) {
  const md = legalMarkdown(doc.slug);
  assert.ok(doc.draft, `${doc.slug}: до юриста — только черновик`);
  assert.match(md, /ЧЕРНЕТКА до перевірки юристом/, `${doc.slug}: нет пометки «чернетка»`);
  assert.ok(!/\{[a-z]+\}/.test(md), `${doc.slug}: неподставленный плейсхолдер`);
  assert.ok(md.includes(BRAND.name), `${doc.slug}: нет имени из brand.ts`);
  assert.ok(legalTitle(md).length > 5);
  const blocks = parseLegalMarkdown(md);
  assert.equal(blocks[0].kind, 'h1');
  assert.ok(blocks.some((b) => b.kind === 'note'), `${doc.slug}: пометка не стала блоком-примечанием`);
  assert.ok(!/гарант/i.test(md), `${doc.slug}: «гарантуємо» в юр-тексте (§13)`);
}
// Политика описывает ровно то, что делает сайт: cookie одна — язык.
const cookies = legalMarkdown('cookies');
assert.ok(cookies.includes('NEXT_LOCALE'));
const privacy = legalMarkdown('privacy');
for (const must of ['Vercel Web Analytics', 'Telegram', 'згода']) assert.ok(privacy.includes(must), `privacy: нет «${must}»`);
console.log(`ok   юр-черновики: ${LEGAL_DOCS.length} документа, помечены, плейсхолдеры подставлены, разметка разбирается`);
