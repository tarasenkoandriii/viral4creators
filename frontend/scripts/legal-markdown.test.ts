import assert from 'node:assert/strict';
import { parseInline, parseLegalMarkdown } from '../src/lib/legal-markdown';
import { LEGAL_DOCS, LEGAL_VERSION } from '../src/lib/legal-content';

const blocks = parseLegalMarkdown(
  '# Заголовок\n\n**Версия: 2026-09-06.** Действует.\n\n## 1. Раздел\n\nАбзац с\nмягким переносом.\n\n- пункт один\n- пункт два\n  с продолжением\n\n> Примечание.\n'
);
assert.deepEqual(
  blocks.map((b) => b.kind),
  ['h1', 'p', 'h2', 'p', 'ul', 'note']
);
assert.equal(blocks[0].kind === 'h1' && blocks[0].text, 'Заголовок');
assert.equal(
  blocks[3].kind === 'p' && blocks[3].text,
  'Абзац с мягким переносом.'
);
assert.deepEqual(blocks[4].kind === 'ul' && blocks[4].items, [
  'пункт один',
  'пункт два с продолжением',
]);
assert.equal(blocks[5].kind === 'note' && blocks[5].text, 'Примечание.');

assert.deepEqual(parseInline('до **жир** после'), [
  { text: 'до ', bold: false },
  { text: 'жир', bold: true },
  { text: ' после', bold: false },
]);
assert.deepEqual(parseInline('без разметки'), [
  { text: 'без разметки', bold: false },
]);

// Реальные документы разбираются и содержат обещанный пункт про права
assert.equal(LEGAL_DOCS.length, 2);
for (const doc of LEGAL_DOCS) {
  const parsed = parseLegalMarkdown(doc.markdown);
  assert.ok(parsed.length > 20, `${doc.slug}: подозрительно мало блоков`);
  assert.equal(parsed[0].kind, 'h1');
  assert.equal(doc.version, LEGAL_VERSION);
}
const ip = LEGAL_DOCS.map((d) => d.markdown).join('\n');
assert.ok(/Разборы являются объектом интеллектуальной собственности/.test(ip));
assert.ok(/Разборы принадлежат Сервису/.test(ip));
console.log('legal-markdown: 14 cases ok');
