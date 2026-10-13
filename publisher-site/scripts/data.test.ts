/**
 * Нормализация данных API для страниц: `alt_contact` (схема параметра —
 * только https/mailto/tel), FAQ (≤ 5, `{question, answer}`), список снятых
 * для middleware 410, выдержка для description.
 */
import assert from 'node:assert/strict';
import { altContactOf, faqOf, slaTextOf } from '../src/lib/api';
import { plainExcerpt } from '../src/lib/page-meta';
import { withdrawnFromList } from '../src/lib/withdrawn';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  n++;
  assert.deepEqual(a, b, m);
};
eq(
  altContactOf({ label: 'hi@example.org', href: 'mailto:hi@example.org' }),
  { label: 'hi@example.org', href: 'mailto:hi@example.org' },
  'mailto',
);
eq(
  altContactOf({ label: '+380 44', href: 'tel:+380 44 123 45 67' }),
  { label: '+380 44', href: 'tel:+380 44 123 45 67' },
  'tel',
);
eq(
  altContactOf({ label: 'x', href: 'javascript:alert(1)' }),
  { label: 'x', href: null },
  'опасная ссылка отбрасывается, подпись остаётся',
);
eq(altContactOf({ label: 'x', href: 'http://t.me/x' }), { label: 'x', href: null }, 'http — не ссылка');
eq(altContactOf({ label: '  ' }), null, 'пустая подпись');
eq(altContactOf(null), null, 'не утверждён');
eq(altContactOf('строка'), null, 'не объект');
eq(
  faqOf([
    { question: 'Q1', answer: 'A1' },
    { question: '', answer: 'x' },
    { text: 'x' },
    null,
    ...[2, 3, 4, 5, 6].map((i) => ({ question: `Q${i}`, answer: `A${i}` })),
  ]).map((f) => f.question),
  ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
  'FAQ: годные, не больше пяти',
);
eq(faqOf('x' as unknown as unknown[]), [], 'FAQ: не список');
eq(
  [
    ...(withdrawnFromList([
      { slug: 'a', withdrawn: true },
      { slug: 'b', withdrawn: false },
      { withdrawn: true },
      null,
    ]) ?? []),
  ],
  ['a'],
  'снятые slug',
);
eq(withdrawnFromList({}), null, 'не список — неизвестно, а не «пусто»');
eq(plainExcerpt('**Жирний** [посилання](https://x) і `код`'), 'Жирний посилання і код', 'выдержка без разметки');
eq(plainExcerpt('я'.repeat(200))?.length, 160, 'выдержка ≤ 160');
eq(plainExcerpt(null), null, 'нет текста');
const sla = { next_business_day_end: 'NBD', unknown: 'U' };
eq(
  [
    slaTextOf(undefined, sla),
    slaTextOf({ rule: 'next_business_day_end' }, sla),
    slaTextOf({ rule: 'within_1h' }, sla),
    slaTextOf('x', sla),
    slaTextOf(null, sla),
  ],
  ['NBD', 'NBD', 'U', 'U', 'NBD'],
  'contact_sla: нет поля или null (контракт Z-2a) — умолчание параметра; чужое правило — без обещания срока',
);
console.log(`ok   data: ${n} проверок — alt_contact, FAQ, снятые slug, выдержка`);
