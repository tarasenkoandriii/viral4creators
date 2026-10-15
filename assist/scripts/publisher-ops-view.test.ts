/**
 * AI Publisher (P-G2) — чистые функции показа экранов денег, заявок и
 * отчётов (`src/lib/publisher/ops-view.ts`) и словари `publisher-ops-*`:
 *  - AT-F12-01 (UI): вектор ТЗ §17 — 10 000 − 2 000 − 1 000 − 2 000 = 5 000,
 *    delivered_unpaid 400 внутри обязательств и не вычитается; оплата
 *    1 000 сохраняет 5 000; несобранный лимит — «неизвестно», не 0;
 *  - AT-F10-01 (UI): балл отдельно от полноты, «невідомо» ≠ 0;
 *  - AT-CORE-18 (UI): `not_computable` → «не рассчитывается» с исходными
 *    числами, `lowerBound` → «не менее»;
 *  - AT-CORE-11 (UI): кнопки шагов скрыты без роли (решает сервер);
 *  - AT-CORE-12 (UI): интеграция `connected`, но устаревшая, — не зелёная;
 *  - AT-F17-02 (UI): при открытом окне — только «не определено»;
 *  - словари uk/ru/en: одинаковая форма, плейсхолдеры, без пустых строк,
 *    каждый перечень подписан.
 */
import assert from 'node:assert/strict';
import { pubOpsEn } from '../src/i18n/publisher-ops-en';
import { pubOpsRu } from '../src/i18n/publisher-ops-ru';
import { pubOpsUk } from '../src/i18n/publisher-ops-uk';
import { pubRu } from '../src/i18n/publisher-ru';
import * as D from '../src/lib/publisher/distribution-api';
import * as L from '../src/lib/publisher/leads-api';
import * as R from '../src/lib/publisher/reports-api';
import {
  allowedConclusions,
  budgetFormulaHolds,
  budgetRows,
  budgetTone,
  getOpsDict,
  hours,
  integrationTone,
  integrationsProblems,
  kyivNoonIso,
  kyivToday,
  leadTargets,
  parseMoneyInput,
  paymentNeedsReconcile,
  paymentTone,
  placementSteps,
  timeTotals,
  transitionNeedsReason,
  usagePct,
  venueScoreView,
} from '../src/lib/publisher/ops-view';
import { computableText, fmtMinor } from '../src/lib/publisher/view';
import * as OV from '../src/lib/publisher/ops-view';
import { POLL_MAX_MS } from '../src/lib/publisher/ai-api';

// ═══ Словари ════════════════════════════════════════════════════════════
function shape(v: unknown, prefix = ''): string[] {
  if (typeof v === 'string') {
    assert.ok(v.trim().length > 0, `пустая строка: ${prefix}`);
    return [prefix];
  }
  assert.ok(
    v !== null && typeof v === 'object' && !Array.isArray(v),
    `не объект: ${prefix}`
  );
  return Object.keys(v as object)
    .sort()
    .flatMap((k) =>
      shape((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k)
    );
}
function placeholders(v: unknown, prefix = ''): string[] {
  if (typeof v === 'string')
    return [`${prefix}:${(v.match(/\{\w+\}/g) ?? []).sort().join(',')}`];
  return Object.keys(v as object)
    .sort()
    .flatMap((k) =>
      placeholders(
        (v as Record<string, unknown>)[k],
        prefix ? `${prefix}.${k}` : k
      )
    );
}
assert.deepEqual(shape(pubOpsUk), shape(pubOpsRu));
assert.deepEqual(shape(pubOpsEn), shape(pubOpsRu));
assert.deepEqual(placeholders(pubOpsUk), placeholders(pubOpsRu));
assert.deepEqual(placeholders(pubOpsEn), placeholders(pubOpsRu));
assert.equal(getOpsDict('uk'), pubOpsUk);
assert.equal(getOpsDict('en'), pubOpsEn);

const labelled = (
  map: Record<string, string>,
  list: readonly string[],
  what: string
) => {
  for (const k of list) assert.ok(map[k], `${what}: нет подписи ${k}`);
};
for (const o of [pubOpsRu, pubOpsUk, pubOpsEn]) {
  labelled(o.venues.statuses, D.VENUE_STATUSES, 'venue');
  labelled(o.venues.criteria, D.VENUE_CRITERIA, 'criteria');
  labelled(o.venues.markings, D.VENUE_LINK_MARKINGS, 'marking');
  labelled(o.venues.checks, D.VENUE_CHECK_KEYS, 'checks');
  labelled(o.purchases.statuses, D.PLACEMENT_STATUSES, 'placement');
  labelled(o.purchases.payment, D.PAYMENT_STATUSES, 'payment');
  labelled(o.purchases.claim, D.CLAIM_STATUSES_PLACEMENT, 'claim');
  labelled(
    o.purchases.steps,
    [
      'approve',
      'reserve',
      'order',
      'publication',
      'published',
      'verify',
      'dispute',
      'resolve',
      'cancel',
      'reject',
      'editPrice',
    ],
    'steps'
  );
  labelled(o.budget.category, D.EXPENSE_CATEGORIES, 'category');
  labelled(o.budget.entryKinds, D.EXPENSE_ENTRY_KINDS, 'entryKind');
  labelled(o.budget.entryStatuses, D.EXPENSE_ENTRY_STATUSES, 'entryStatus');
  labelled(o.budget.warnings, D.BUDGET_WARNINGS, 'warning');
  labelled(o.leads.statuses, L.LEAD_STATUSES, 'lead');
  labelled(o.leads.testFilter, L.LEAD_TEST_FILTERS, 'testFilter');
  labelled(o.leads.testReasons, L.LEAD_TEST_REASONS, 'testReason');
  labelled(o.leads.contactMethods, L.CONTACT_METHODS, 'contactMethod');
  labelled(o.leads.purposes, L.CONTACT_PURPOSES, 'purpose');
  labelled(o.leads.reasonCodes, L.LEAD_REASON_CODES, 'reasonCode');
  labelled(o.leads.channelGroups, L.CHANNEL_GROUPS, 'channelGroup');
  labelled(
    o.leads.linkReasons,
    [
      'intake_exact_match',
      'new',
      'manual_merge',
      'manual_split',
      'manual_assign',
    ],
    'linkReason'
  );
  labelled(o.prospects.prior, L.PRIOR_EXTERNAL_PAYMENT, 'prior');
  labelled(o.payments.recordTypes, L.PAYMENT_RECORD_TYPES, 'recordType');
  labelled(o.payments.payerKinds, L.PAYER_KINDS, 'payerKind');
  labelled(o.payments.statuses, L.CLIENT_PAYMENT_STATUSES, 'paymentStatus');
  labelled(o.notifications.kinds, L.NOTIFICATION_KINDS, 'notificationKind');
  labelled(
    o.notifications.statuses,
    L.NOTIFICATION_STATUSES,
    'notificationStatus'
  );
  labelled(o.notifications.outboxStatuses, L.OUTBOX_STATUSES, 'outbox');
  labelled(o.traffic.eventNames, L.EVENT_NAMES, 'event');
  labelled(o.experiments.statuses, R.EXPERIMENT_STATUSES, 'experiment');
  labelled(o.experiments.kinds, R.EXPERIMENT_KINDS, 'experimentKind');
  labelled(o.experiments.conclusions, R.EXPERIMENT_CONCLUSIONS, 'conclusion');
  labelled(o.experiments.decisions, R.EXPERIMENT_DECISIONS, 'decision');
  labelled(o.reports.kinds, R.REPORT_KINDS, 'reportKind');
  labelled(o.reports.recomputeReasons, R.REPORT_RECOMPUTE_REASONS, 'recompute');
  labelled(o.reports.integrationKinds, R.INTEGRATION_KINDS, 'integration');
  labelled(o.reports.importSources, R.METRIC_IMPORT_SOURCES, 'importSource');
  labelled(o.reports.verdicts, R.VERDICTS, 'verdict');
  labelled(o.reports.parts, R.VERDICT_PARTS, 'part');
  labelled(o.reports.windowStates, R.WINDOW_STATES, 'windowState');
  labelled(o.time.categories, R.TIME_ENTRY_CATEGORIES, 'timeCategory');
  labelled(o.time.roles, R.TIME_ENTRY_ROLES, 'timeRole');
  labelled(o.backups.kinds, R.BACKUP_KINDS, 'backupKind');
  labelled(o.backups.statuses, R.BACKUP_STATUSES, 'backupStatus');
  labelled(o.backups.restoreStatuses, R.RESTORE_STATUSES, 'restoreStatus');
  labelled(o.backups.modes, R.RESTORE_MODES, 'restoreMode');
  // «Окупаемости» в словаре нет (ТЗ §16: CPL не доказывает эффективность).
  const all = JSON.stringify(o).toLowerCase();
  for (const w of ['окупаем', 'окупн', 'payback', 'roi ']) {
    assert.ok(!all.includes(w), `запрещённое слово «${w}»`);
  }
}

// ═══ AT-F12-01: числа бюджета (вектор ТЗ §17) ═══════════════════════════
const budget = (over: Partial<D.BudgetView> = {}): D.BudgetView => ({
  built: true,
  currency: 'UAH',
  total: '1000000',
  netPaid: '200000',
  openCommitment: '100000',
  deliveredUnpaid: '40000',
  protectedReserve: '200000',
  available: '500000',
  usageBp: 3000,
  warn: false,
  stopped: false,
  reconcileStopped: false,
  perPurchaseMax: '200000',
  byCategory: {
    placements: { used: '300000', limit: '600000', available: '300000' },
    tools: { used: '0', limit: '200000', available: '200000' },
  },
  cash: { paid: '200000', economicDelivered: '240000', advances: '0' },
  warnings: [],
  paramVersion: 1,
  reserveMoves: [],
  ...over,
});
{
  const b = budget();
  const rows = budgetRows(b);
  assert.deepEqual(
    rows.map((r) => r.key),
    [
      'total',
      'netPaid',
      'openCommitment',
      'deliveredUnpaid',
      'protectedReserve',
      'available',
    ]
  );
  const du = rows.find((r) => r.key === 'deliveredUnpaid')!;
  assert.equal(du.sign, 'in', 'delivered_unpaid — внутри обязательств');
  assert.equal(du.nested, true);
  // Сумма строк со знаком «−» и лимит дают доступное без delivered_unpaid.
  const minus = rows
    .filter((r) => r.sign === '−')
    .reduce((a, r) => a + BigInt(r.minor!), 0n);
  assert.equal(BigInt(rows[0].minor!) - minus, 500000n);
  assert.equal(budgetFormulaHolds(b), true);
  assert.equal(rows.find((r) => r.key === 'netPaid')!.kind, 'fact');
  assert.equal(rows.find((r) => r.key === 'openCommitment')!.kind, 'forecast');
  assert.equal(rows.find((r) => r.key === 'total')!.kind, 'plan');
  // Вычесть delivered_unpaid второй раз — формула «не сходится».
  assert.equal(budgetFormulaHolds(budget({ available: '460000' })), false);
  // Оплата обязательства 1 000: net_paid 3 000, open 0 → доступно 5 000.
  assert.equal(
    budgetFormulaHolds(
      budget({ netPaid: '300000', openCommitment: '0', deliveredUnpaid: '0' })
    ),
    true
  );
  // Перевод 500 из резерва: доступно 5 500, лимит тот же.
  assert.equal(
    budgetFormulaHolds(
      budget({ protectedReserve: '150000', available: '550000' })
    ),
    true
  );
  // Лимит не собран — неизвестно, а не ноль.
  const nb = budgetRows(budget({ built: false, total: '0', available: '0' }));
  assert.ok(nb.every((r) => r.minor === null && r.kind === 'unknown'));
  assert.equal(budgetFormulaHolds(budget({ built: false })), null);
  assert.equal(budgetTone(budget({ built: false })), 'danger');
  assert.equal(
    budgetTone(budget({ warn: true, warnings: ['warn_80'] })),
    'warning'
  );
  assert.equal(
    budgetTone(budget({ stopped: true, warnings: ['stopped_100'] })),
    'danger'
  );
  assert.equal(
    budgetTone(budget()),
    'neutral',
    'без предупреждений — нейтрально, не «зелёный»'
  );
  assert.equal(usagePct(3000, 'ru'), '30 %');
  assert.equal(usagePct(8050, 'en'), '80.5 %');
}
// Ввод сумм — без потери точности, неоднозначное не принимается.
assert.equal(parseMoneyInput('1 500,50'), '150050');
assert.equal(parseMoneyInput('1500.5'), '150050');
assert.equal(parseMoneyInput('-15'), '-1500');
assert.equal(parseMoneyInput('0'), '0');
assert.equal(parseMoneyInput('99999999999999'), '9999999999999900');
assert.equal(parseMoneyInput('1.234'), null);
assert.equal(parseMoneyInput('1,5,0'), null);
assert.equal(parseMoneyInput('abc'), null);
assert.equal(parseMoneyInput(''), null);
assert.equal(
  fmtMinor('150050', 'UAH', 'ru', '?').replace(/\s/g, ' '),
  '1 500,50 UAH'
);
assert.equal(fmtMinor(null, 'UAH', 'ru', 'неизвестно'), 'неизвестно');

// ═══ AT-F10-01: балл отдельно от полноты ════════════════════════════════
{
  const v = {
    criteria: {
      topic: { score: 2 as const, why: 'a' },
      format: { score: null, why: '' },
    },
    score: { sum: 2, max: 2, known: 1 },
    completeness: 1,
  } as unknown as D.VenueView;
  const s = venueScoreView(v);
  assert.deepEqual(s.score, { sum: 2, max: 2, known: 1 });
  assert.deepEqual(s.completeness, { rated: 1, total: 5 });
  assert.equal(
    s.cells.find((c) => c.criterion === 'format')!.value,
    'unknown',
    'null — «невідомо», не 0'
  );
  assert.equal(
    s.cells.find((c) => c.criterion === 'geo_language')!.value,
    'unknown'
  );
  assert.equal(s.cells.find((c) => c.criterion === 'topic')!.value, '2');
  const none = venueScoreView({
    criteria: {},
    score: { sum: 0, max: 0, known: 0 },
    completeness: 0,
  } as unknown as D.VenueView);
  assert.equal(none.score, null, 'нет оценок — балла нет (не «0 из 0»)');
}

// ═══ AT-CORE-11: шаги закупки по ролям (подсказка; решает сервер) ══════
{
  const PO = new Set([
    'placement.approve',
    'budget.operate',
    'placement.claim',
    'placement.propose',
  ]);
  const OP = new Set([
    'budget.operate',
    'placement.claim',
    'placement.propose',
  ]);
  const VW = new Set<string>();
  const can = (s: Set<string>) => (a: string) => s.has(a);
  const p = (
    status: D.PlacementStatus,
    paymentStatus: D.PaymentStatus = 'unpaid'
  ) => ({ status, paymentStatus });
  assert.deepEqual(placementSteps(p('proposed'), can(PO)), [
    'approve',
    'editPrice',
    'reject',
  ]);
  assert.deepEqual(
    placementSteps(p('proposed'), can(OP)),
    ['editPrice', 'reject'],
    'оператор не согласует'
  );
  assert.deepEqual(
    placementSteps(p('proposed'), can(VW)),
    [],
    'наблюдатель — без кнопок'
  );
  assert.ok(placementSteps(p('approved'), can(OP)).includes('reserve'));
  assert.ok(placementSteps(p('budget_reserved'), can(OP)).includes('order'));
  assert.ok(
    !placementSteps(p('budget_reserved', 'unknown'), can(OP)).includes('order'),
    'unknown — сначала сверка'
  );
  assert.ok(
    !placementSteps(p('budget_reserved', 'pending'), can(OP)).includes('order')
  );
  assert.deepEqual(placementSteps(p('disputed'), can(OP)), ['resolve']);
  assert.deepEqual(placementSteps(p('verified_complete'), can(PO)), []);
  assert.ok(placementSteps(p('published'), can(OP)).includes('dispute'));
  assert.ok(
    !placementSteps(p('published'), can(OP)).includes('cancel'),
    'опубликованную не отменить'
  );
  assert.equal(paymentNeedsReconcile({ paymentStatus: 'unknown' }), true);
  assert.equal(paymentNeedsReconcile({ paymentStatus: 'paid' }), false);
  assert.equal(
    paymentTone('unknown'),
    'warning',
    'неизвестная оплата — не зелёная'
  );
  assert.equal(paymentTone('pending'), 'warning');
  assert.equal(paymentTone('paid'), 'success');
}

// ═══ Машина заявки 7.4 ══════════════════════════════════════════════════
assert.deepEqual(
  [...leadTargets('new')],
  ['contacted', 'qualified', 'rejected']
);
assert.deepEqual([...leadTargets('won')], []);
assert.equal(transitionNeedsReason('new', 'rejected'), true);
assert.equal(transitionNeedsReason('proposal_sent', 'lost'), true);
assert.equal(
  transitionNeedsReason('lost', 'contacted'),
  true,
  'пересмотр — с причиной'
);
assert.equal(
  transitionNeedsReason('qualified', 'contacted'),
  true,
  'отмена квалификации — с причиной'
);
assert.equal(transitionNeedsReason('new', 'contacted'), false);
assert.equal(transitionNeedsReason('new', 'qualified'), false);

// ═══ AT-CORE-12: интеграции — зелёный только connected и свежая ═══════
{
  const i = (over: Partial<R.IntegrationView>): R.IntegrationView => ({
    kind: 'web_analytics',
    exists: true,
    status: 'connected',
    manual: true,
    lastSuccessAt: null,
    lastCheckedAt: null,
    staleAfterHours: 48,
    stale: false,
    note: null,
    revision: 1,
    ...over,
  });
  assert.equal(integrationTone(i({})), 'success');
  assert.equal(
    integrationTone(i({ stale: true })),
    'warning',
    'устарела — не зелёная'
  );
  assert.equal(integrationTone(i({ status: 'degraded' })), 'warning');
  assert.equal(integrationTone(i({ status: 'disconnected' })), 'danger');
  assert.equal(
    integrationTone(i({ exists: false, status: 'disconnected' })),
    'warning',
    'строки нет — не подключено'
  );
  assert.deepEqual(
    integrationsProblems([
      i({}),
      i({ kind: 'search_console', stale: true }),
    ]).map((x) => x.kind),
    ['search_console']
  );
}

// ═══ AT-CORE-18: «не рассчитывается» и «не менее» ══════════════════════
{
  const money = (v: string) => fmtMinor(v, 'UAH', 'ru', pubRu.common.unknown);
  const zero = computableText(
    {
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: { numeratorMinor: '340000', qualified: 0 },
    },
    money,
    pubRu.computable,
    pubRu.common.unknown
  );
  assert.ok(zero.text.includes(pubRu.computable.notComputable), zero.text);
  assert.ok(zero.text.includes(pubRu.computable.reasons.zero_denominator));
  assert.ok(
    zero.note &&
      zero.note.includes('340000') &&
      zero.note.includes('qualified=0'),
    'исходные числа видны'
  );
  assert.notEqual(zero.tone, 'success');
  assert.ok(!/\b0[,.]00\b/.test(zero.text), 'не ноль');
  const lb = computableText(
    {
      kind: 'value',
      value: '1700',
      lowerBound: true,
      unknownParts: ['labor:editor'],
    },
    money,
    pubRu.computable,
    pubRu.common.unknown
  );
  assert.ok(lb.text.startsWith('не менее'), lb.text);
  assert.ok(lb.text.replace(/\s/g, ' ').includes('17,00 UAH'));
  assert.equal(lb.tone, 'warning');
  const none = computableText(
    null,
    money,
    pubRu.computable,
    pubRu.common.unknown
  );
  assert.equal(none.text, pubRu.common.unknown);
}

// ═══ AT-F17-02: заключение при открытом окне ═══════════════════════════
{
  const now = new Date('2026-11-01T00:00:00Z');
  assert.deepEqual(
    allowedConclusions({ windowEnd: '2026-12-01T00:00:00Z' }, now),
    ['inconclusive']
  );
  assert.deepEqual(allowedConclusions({ windowEnd: 'not-a-date' }, now), [
    'inconclusive',
  ]);
  assert.deepEqual(
    allowedConclusions({ windowEnd: '2026-10-01T00:00:00Z' }, now),
    ['supported', 'not_supported', 'inconclusive']
  );
}

// ═══ Учёт часов: операции и инвестиции раздельно ═══════════════════════
{
  const t = timeTotals([
    {
      minutes: 90,
      isInvestment: false,
      role: 'editor',
      category: 'production',
    },
    { minutes: 60, isInvestment: true, role: 'admin', category: 'setup' },
    {
      minutes: 30,
      isInvestment: false,
      role: 'editor',
      category: 'qa_reports',
    },
  ]);
  assert.equal(t.minutes, 180);
  assert.equal(t.operations, 120);
  assert.equal(t.investment, 60);
  assert.deepEqual(t.byRole, { editor: 120, admin: 60 });
  assert.equal(hours(90), 1.5);
}

// ═══ Даты Киева ═════════════════════════════════════════════════════════
{
  const kyivDate = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  for (const d of ['2026-10-25', '2026-03-29', '2026-12-31', '2027-01-01']) {
    assert.equal(kyivDate(kyivNoonIso(d)), d, `полдень Киева ${d}`);
  }
  assert.equal(
    kyivToday(new Date('2026-10-12T22:30:00Z')),
    '2026-10-13',
    'после полуночи по Киеву — новый день'
  );
}

// ═══ Раунд исправлений по аудиту P-G ═════════════════════════════════════
// A5: раскрытый контакт — только той же заявки и до срока.
{
  const r: OV.Revealed<string> = { leadId: 'l1', value: '+380…', until: 1000 };
  assert.equal(OV.revealedFor(r, 'l1', 999), '+380…');
  assert.equal(OV.revealedFor(r, 'l1', 1000), null);
  assert.equal(OV.revealedFor(r, 'l2', 10), null);
  assert.equal(OV.revealedFor(null, 'l1', 10), null);
  assert.ok(OV.CONTACT_SHOW_SECONDS > 0 && OV.CONTACT_SHOW_SECONDS <= 120);
}
// S2: новая версия эксперимента (P-E S1-1): пилот после t0 — только
// `lateCohortEnd`; change — только с будущим `windowStart`.
{
  const NOW = new Date('2026-10-13T09:00:00.000Z');
  const ALLF = {
    hypothesis: 'h',
    windowStart: '2099-01-01T10:00',
    windowEnd: '2099-02-01T10:00',
    lateCohortEnd: '2099-03-01T10:00',
  };
  assert.equal(
    OV.experimentVersionMode({ kind: 'pilot', t0: '2026-10-01T00:00:00Z' }),
    'pilot_started'
  );
  assert.equal(OV.experimentVersionMode({ kind: 'pilot', t0: null }), 'pilot');
  assert.equal(
    OV.experimentVersionMode({ kind: 'change', t0: null }),
    'change'
  );
  const ps = OV.experimentVersionBody(
    { kind: 'pilot', t0: '2026-10-01T00:00:00Z' },
    ALLF,
    NOW
  );
  assert.deepEqual(Object.keys(ps ?? {}), ['lateCohortEnd']);
  assert.equal(
    OV.experimentVersionBody(
      { kind: 'pilot', t0: '2026-10-01T00:00:00Z' },
      { hypothesis: 'h' },
      NOW
    ),
    null
  );
  const ch = OV.experimentVersionBody({ kind: 'change', t0: null }, ALLF, NOW);
  assert.ok(ch && ch.windowStart && ch.hypothesis === 'h');
  // Без окна или с окном в прошлом — тела нет (кнопка неактивна).
  assert.equal(
    OV.experimentVersionBody(
      { kind: 'change', t0: null },
      { hypothesis: 'h' },
      NOW
    ),
    null
  );
  assert.equal(
    OV.experimentVersionBody(
      { kind: 'change', t0: null },
      { hypothesis: 'h', windowStart: '2026-10-01T10:00' },
      NOW
    ),
    null
  );
  const pi = OV.experimentVersionBody({ kind: 'pilot', t0: null }, ALLF, NOW);
  assert.ok(pi && pi.hypothesis && pi.windowStart && pi.lateCohortEnd);
}
// S1-1: ссылка со страницы — та, что выдана (`utm_content=<код>`).
assert.equal(
  OV.linkMatchesCode('https://s.com/?utm_content=pl7&utm_source=x', 'pl7'),
  true
);
assert.equal(
  OV.linkMatchesCode('https://s.com/?utm_content=pl8', 'pl7'),
  false
);
assert.equal(OV.linkMatchesCode('not a url', 'pl7'), false);
// Импорт метрик: дни — форма `MetricImportDay` контракта, иначе отказ до
// запроса.
{
  const ok = [
    { date: '2026-10-01', sessions: 3, clicks: null, indexed: true },
    { date: '2026-10-02', page: '/a', extra: { x: 1, y: null }, partial: true },
  ];
  assert.deepEqual(OV.metricDays(ok), ok);
  for (const bad of [
    null,
    {},
    [],
    [1],
    [{ sessions: 1 }],
    [{ date: '01.10.2026' }],
    [{ date: '2026-10-01', sessions: -1 }],
    [{ date: '2026-10-01', sessions: '3' }],
    [{ date: '2026-10-01', bogus: 1 }],
    [{ date: '2026-10-01', extra: { x: 'a' } }],
    [{ date: '2026-10-01', partial: null }],
  ])
    assert.equal(OV.metricDays(bad), null, JSON.stringify(bad));
}
// S3: опрос AI-вызова ждёт до 180 с (задание ai-calls-run, P-B2).
assert.equal(POLL_MAX_MS, 180_000);
// S3: подсказка продуктового CPL — формула контракта (§9.4): операционная
// стоимость / все внешние квалифицированные.
for (const d of [pubOpsUk, pubOpsRu, pubOpsEn]) {
  const h = d.traffic.productCplHint.toLowerCase();
  assert.ok(h.includes('/'), h);
  assert.ok(!/placement|розміщ|размещ/.test(h), h);
}

console.log('publisher-ops-view: ok');

// `purchases_disabled` (per_purchase_max = 0) рядом с `per_purchase_cap`.
for (const o of [pubOpsUk, pubOpsRu, pubOpsEn]) {
  assert.ok(o.purchases.insufficientReasons.purchases_disabled);
  assert.deepEqual(
    Object.keys(o.purchases.insufficientReasons).sort(),
    Object.keys(pubOpsRu.purchases.insufficientReasons).sort()
  );
}
assert.equal(
  pubOpsRu.purchases.insufficientReasons.purchases_disabled,
  'закупки отключены: максимум одной закупки — 0'
);
