/**
 * Снимок тарифов `assist-plans.snapshot.json` = ТЗ TMA §7.1 (после аудита
 * 01.10). Таблица ниже переписана из §7.1 руками: правка §7.1 без правки
 * снимка (или наоборот) — красный тест. Сверка — пункт чек-листа релиза.
 */
import assert from 'node:assert/strict';
import { formatUsd, parsePlansSnapshot, PLANS } from '../src/lib/plans';
import raw from '../assist-plans.snapshot.json';

const TZ_7_1 = {
  trial: { price: 0, trialDays: 14, dialogs: 50, sites: 1, pages: 50, docs: 5, ops: 1, keep: 30, over: null, voice: false, adminRead: false, adminActions: false, noPowered: false },
  start: { price: 19, trialDays: null, dialogs: 400, sites: 1, pages: 300, docs: 20, ops: 2, keep: 90, over: 6, voice: false, adminRead: false, adminActions: false, noPowered: false },
  business: { price: 59, trialDays: null, dialogs: 1200, sites: 3, pages: 2000, docs: 200, ops: 5, keep: 180, over: 5.5, voice: true, adminRead: true, adminActions: false, noPowered: true },
  pro: { price: 149, trialDays: null, dialogs: 3000, sites: 10, pages: 10000, docs: 1000, ops: 20, keep: 365, over: 5, voice: true, adminRead: true, adminActions: true, noPowered: true },
} as const;

for (const p of PLANS.plans) {
  const t = TZ_7_1[p.id];
  assert.deepEqual(
    [p.priceUsdMonthly, p.trialDays, p.dialogsPerMonth, p.sites, p.knowledgePages, p.documents, p.telegramOperators, p.retentionDays, p.overageUsdPer100, p.voice, p.adminRead, p.adminActions, p.removePoweredBy],
    [t.price, t.trialDays, t.dialogs, t.sites, t.pages, t.docs, t.ops, t.keep, t.over, t.voice, t.adminRead, t.adminActions, t.noPowered],
    `${p.id}: снимок разошёлся с ТЗ TMA §7.1`,
  );
}
assert.equal(PLANS.minOveragePerDialogUsd, 0.05);
assert.equal(PLANS.annualDiscountPercent, 20);
assert.deepEqual(PLANS.dialogRules, { idleCloseMinutes: 30, countsAsTwoAfterReplies: 30, countsAsThreeAfterReplies: 60 });
assert.equal(PLANS.currency, 'USD', 'EUR не показываем — оплаты в EUR нет (§3.8)');
// Испорченный снимок — ошибка сборки, а не пустая страница.
const broken = JSON.parse(JSON.stringify(raw));
broken.plans[1].overageUsdPer100 = 4;
assert.throws(() => parsePlansSnapshot(broken), /ниже минимума/);
const noPlan = JSON.parse(JSON.stringify(raw));
noPlan.plans.pop();
assert.throws(() => parsePlansSnapshot(noPlan), /тарифы/);
assert.equal(formatUsd(19, 'en'), '$19');
assert.equal(formatUsd(0.05, 'en'), '$0.05');
console.log('ok   тарифы: снимок совпадает с ТЗ TMA §7.1 (4 тарифа × 13 полей), правила диалога и докупки; битый снимок не собирается');
