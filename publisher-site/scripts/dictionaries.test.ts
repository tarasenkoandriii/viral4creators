/**
 * Словарь `uk.json` (§13.1; ТЗ §8.1): полнота (ключи формы ↔ списки
 * контракта), подстановки, непустые строки — и отсутствие выдуманных
 * фактов: гарантий, отзывов, скидок, «№1», процентов роста, цен в тексте
 * посадочной (цена — только `offer.priceNote` из site-config).
 */
import assert from 'node:assert/strict';
import uk from '../src/dictionaries/uk.json';
import { LEAD_BUDGET_RANGES, LEAD_CONTACT_METHODS, LEAD_SELF_REPORTED_CHANNELS } from '../src/shared/lead-validation';

const leaves: Array<[string, string]> = [];
const walk = (v: unknown, p: string) => {
  if (typeof v === 'string') leaves.push([p, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
};
walk(uk, '');
let n = 0;
for (const [p, s] of leaves) {
  n++;
  assert.ok(s.trim().length > 0, `${p}: пустая строка`);
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    assert.ok(
      ['name', 'positioning', 'n', 'max', 'leadRef', 'count', 'window', 'wait', 'version', 'sla'].includes(m[1]),
      `${p}: неизвестная подстановка {${m[1]}}`,
    );
  }
}
const keys = (o: object) => Object.keys(o).sort();
assert.deepEqual(keys(uk.form.methods), [...LEAD_CONTACT_METHODS].sort(), 'form.methods ↔ LEAD_CONTACT_METHODS');
assert.deepEqual(keys(uk.form.contact), [...LEAD_CONTACT_METHODS].sort(), 'form.contact');
assert.deepEqual(keys(uk.form.contactHint), [...LEAD_CONTACT_METHODS].sort(), 'form.contactHint');
assert.deepEqual(keys(uk.form.budgets), [...LEAD_BUDGET_RANGES].sort(), 'form.budgets ↔ LEAD_BUDGET_RANGES');
assert.deepEqual(
  keys(uk.form.sources),
  [...LEAD_SELF_REPORTED_CHANNELS].sort(),
  'form.sources ↔ LEAD_SELF_REPORTED_CHANNELS',
);
assert.ok(
  uk.form.success.includes('{leadRef}') && uk.form.success.includes('{sla}'),
  'подтверждение — номер и срок из contact_sla (ТЗ §6)',
);
assert.ok(/наступного робочого дня/.test(uk.form.sla.next_business_day_end), 'срок по умолчанию параметра — ТЗ §6');
assert.deepEqual(Object.keys(uk.form.sla).sort(), ['next_business_day_end', 'unknown'], 'правила contact_sla');
for (const k of ['server', 'rateLimited'] as const)
  assert.ok(
    /не відправлено/i.test(uk.form[k]) && /альтернативн/.test(uk.form[k]),
    `form.${k}: «не відправлено» + альтернативный контакт`,
  );
// Аудит S3-5: при таймауте/обрыве заявка могла дойти — «статус невідомий» и повтор без дубля, а не «не відправлено».
assert.ok(
  /невідом/i.test(uk.form.network) &&
    /дубль/.test(uk.form.network) &&
    /альтернативн/.test(uk.form.network) &&
    !/не відправлено/i.test(uk.form.network),
  'form.network: статус неизвестен, повтор без дубля',
);
for (const k of ['network', 'server', 'rateLimited'] as const)
  assert.ok(/збережено/.test(uk.form[k]), `form.${k}: данные остаются`);
assert.equal(uk.home.steps.length >= 3, true);

// Запрещённые обещания и выдуманные факты (ТЗ §8.1).
const FORBIDDEN: Array<[RegExp, string]> = [
  [/гарантуєм|гарантован|гарантія результ/i, 'гарантия'],
  [/відгук|кажуть наші клієнти/i, 'отзывы'],
  [/знижк|акці[яї]|було\s+\d/i, 'скидки/зачёркнутые цены'],
  [/№\s*1\b|найкращ|лідер ринку|топ-?\d/i, 'превосходная степень'],
  [/\d+\s*%/, 'проценты'],
  [/у\s+\d+\s+раз/i, 'кратный рост'],
];
for (const [p, s] of leaves) {
  for (const [re, what] of FORBIDDEN) {
    n++;
    assert.ok(!re.test(s), `${p}: ${what} — «${s}»`);
  }
  // Цены/суммы — только подписи диапазонов бюджета в форме.
  if (!p.startsWith('form.budgets.'))
    assert.ok(!/\d[\d\s]*\s*(грн|₴|\$|usd|uah|eur|€)/i.test(s), `${p}: сумма в тексте — «${s}»`);
}
// Посадочная без чисел вообще (факты — из site-config).
for (const [p, s] of leaves.filter(([p]) => p.startsWith('home.')))
  assert.ok(!/\d/.test(s), `${p}: число на посадочной из словаря — «${s}»`);
console.log(
  `ok   dictionaries: ${leaves.length} строк, ${n} проверок — полнота формы ↔ контракт, подстановки, без гарантий/отзывов/скидок/процентов/цен`,
);
