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
assert.deepEqual(
  LEGAL_DOCS.map((d) => d.slug),
  ['offer', 'terms-of-use', 'story-tales-rules']
);
for (const doc of LEGAL_DOCS) {
  const parsed = parseLegalMarkdown(doc.markdown);
  assert.ok(parsed.length > 20, `${doc.slug}: подозрительно мало блоков`);
  assert.equal(parsed[0].kind, 'h1');
  // Оферта и условия принимаются одной версией; у приложения — своя
  // (правила Story‑Tales принимаются отдельно перед первой сказкой).
  if (doc.appendixOf) {
    assert.ok(
      LEGAL_DOCS.some((d) => d.slug === doc.appendixOf && !d.appendixOf),
      `${doc.slug}: приложение к несуществующему документу`
    );
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(doc.version), `${doc.slug}: версия`);
  } else {
    assert.equal(doc.version, LEGAL_VERSION);
  }
}
// Правила Story‑Tales (Р-ST3-9): приложение к оферте, оферта на него
// ссылается, пометка о внутренней проверке и предупреждение §11.3 ТЗ на месте.
const found = LEGAL_DOCS.find((d) => d.slug === 'story-tales-rules');
if (!found) throw new Error('нет документа story-tales-rules');
assert.equal(found.appendixOf, 'offer');
const story = found;
assert.ok(/не заключение юриста/.test(story.markdown));
assert.ok(!/ЧЕРНОВИК/.test(story.markdown));
assert.ok(
  /«Этот подарок будет доступен любому, у кого есть ссылка\.\s+Поисковым системам запрещается индексирование\. Ссылку можно\s+переслать»/.test(
    story.markdown
  )
);
assert.ok(/90 дней/.test(story.markdown));
const offer = LEGAL_DOCS.find((d) => d.slug === 'offer');
assert.ok(offer && offer.markdown.includes('/legal/story-tales-rules'));
const ip = LEGAL_DOCS.map((d) => d.markdown).join('\n');
assert.ok(/Разборы являются объектом интеллектуальной собственности/.test(ip));
assert.ok(/Разборы принадлежат Сервису/.test(ip));
console.log('legal-markdown: 21 cases ok');
