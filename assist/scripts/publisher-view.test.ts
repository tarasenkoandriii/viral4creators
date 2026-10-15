/**
 * AI Publisher (P-G1, §14.3): видимость кнопок по ролям (подсказка —
 * решает сервер, AT-CORE-11), «не рассчитывается» → текст (AT-CORE-18),
 * гейт без пунктов → зелёный, unknown → не зелёный (ТЗ §8.4), деньги
 * `null` → «неизвестно», ошибки `PUB_*` человеческим текстом (409 конфликт
 * → перезагрузка, AT-CORE-10), словари P-G1 на трёх языках.
 */
import assert from 'node:assert/strict';
import { ApiError } from '../src/kit';
import { parseAccountInfo } from '../src/kit/sites-api';
import { pubContentEn } from '../src/i18n/publisher-content-en';
import { pubContentRu } from '../src/i18n/publisher-content-ru';
import { pubContentUk } from '../src/i18n/publisher-content-uk';
import { pubEn } from '../src/i18n/publisher-en';
import { pubRu } from '../src/i18n/publisher-ru';
import { pubUk } from '../src/i18n/publisher-uk';
import type { Computable } from '../src/lib/publisher/decode';
import { describePubError, PUB_ERROR_CODES } from '../src/lib/publisher/errors';
import {
  PUB_PERMISSIONS,
  canAny,
  canCreateProduct,
  canDo,
  publisherEntryVisible,
  type MyRoles,
} from '../src/lib/publisher/permissions';
import * as S from '../src/lib/publisher/states';
import * as V from '../src/lib/publisher/view';
import * as CA from '../src/lib/publisher/common-api';
import { redditListPath } from '../src/lib/publisher/reddit-api';
import * as CH from '../src/lib/publisher/channels-view';
import { PLACEMENT_STATUSES } from '../src/lib/publisher/distribution-api';
import {
  ATTENTION_STATUSES,
  NEGATIVE_STATUSES,
  POSITIVE_STATUSES,
  completenessTone,
  computableText,
  fmtMicroUsd,
  fmtMinor,
  gateBriefTone,
  gateTone,
  objectSection,
  planBalance,
  qaState,
  statusLabel,
  statusTone,
} from '../src/lib/publisher/view';

const t = pubUk;

// ═══ 1. Никакого зелёного при неизвестном ══════════════════════════════
for (const s of [
  'unknown',
  'pending',
  'running',
  'not_checked',
  'assumption',
  'unverified',
  'needs_review',
  'degraded',
  'unpriced',
  'not_run',
  null,
  undefined,
  '',
  'some_new_status',
]) {
  assert.notEqual(statusTone(s), 'success', `зелёный при «${String(s)}»`);
}
for (const s of POSITIVE_STATUSES) {
  assert.ok(!ATTENTION_STATUSES.has(s) && !NEGATIVE_STATUSES.has(s), s);
}
assert.equal(statusTone('approved'), 'success');
assert.equal(statusTone('revoked'), 'danger');
assert.equal(statusTone('unknown'), 'warning');
// Каждый статус экрана имеет решение тона (новый статус — сознательно).
for (const list of [
  S.SOURCE_USAGES,
  S.CLAIM_STATUSES,
  S.CLAIM_SUPPORTS,
  S.QA_RESULTS,
  S.APPROVAL_STATUSES,
  S.PUBLICATION_VERIFY_STATUSES,
  S.AI_CALL_STATUSES,
  S.AI_COST_STATUSES,
  S.PARAMETER_STATUSES,
]) {
  for (const s of list) {
    if (['unknown', 'unverified', 'needs_review', 'not_checked'].includes(s)) {
      assert.equal(statusTone(s), 'warning', s);
    }
  }
}
// Гейт: зелёный только при open без пунктов; нет данных — не зелёный.
assert.equal(gateTone({ open: true, missing: [] }), 'success');
assert.equal(
  gateTone({
    open: true,
    missing: [{ kind: 'parameter', key: 'niche', detail: 'not_approved' }],
  }),
  'danger'
);
assert.equal(gateTone({ open: false, missing: [] }), 'danger');
assert.equal(gateTone(null), 'warning');
assert.equal(gateBriefTone({ open: true, missingCount: 0 }), 'success');
assert.equal(gateBriefTone({ open: true, missingCount: 1 }), 'danger');
assert.equal(gateBriefTone(undefined), 'warning');
assert.equal(completenessTone(null), 'warning');
assert.equal(completenessTone({ state: 'partial', missing: ['x'] }), 'warning');
assert.equal(completenessTone({ state: 'complete', missing: [] }), 'neutral');

// ═══ 2. «Не рассчитывается» и «не менее» (AT-CORE-18) ══════════════════
const nc: Computable<number> = {
  kind: 'not_computable',
  reason: 'zero_denominator',
  inputs: { spend: '150000', leads: 0, payments: null },
};
const r1 = computableText(nc, String, t.computable, t.common.unknown);
assert.ok(r1.text.includes(t.computable.notComputable), r1.text);
assert.ok(r1.text.includes(t.computable.reasons.zero_denominator));
assert.ok(!/(^|\s)0([.,]0+)?$/.test(r1.text), 'не рассчитывается ≠ 0');
assert.ok(
  r1.note &&
    r1.note.includes('leads=0') &&
    r1.note.includes(`payments=${t.common.unknown}`)
);
assert.equal(r1.tone, 'warning');
const lb = computableText<number>(
  { kind: 'value', value: 12, lowerBound: true },
  String,
  t.computable,
  t.common.unknown
);
assert.equal(lb.text, t.computable.lowerBound.replace('{v}', '12'));
assert.notEqual(lb.tone, 'success');
const pre = computableText<number>(
  { kind: 'value', value: 5, preliminary: true, unknownParts: ['refunds'] },
  String,
  t.computable,
  t.common.unknown
);
assert.equal(pre.text, '5');
assert.ok(
  pre.note?.includes(t.computable.preliminary) && pre.note.includes('refunds')
);
assert.equal(
  computableText(null, String, t.computable, t.common.unknown).text,
  t.common.unknown
);

// ═══ 3. Деньги и стоимость: null → «неизвестно», не 0 ═════════════════
assert.equal(fmtMinor(null, 'UAH', 'uk', 'невідомо'), 'невідомо');
assert.equal(fmtMinor(undefined, 'UAH', 'uk', 'невідомо'), 'невідомо');
assert.equal(fmtMinor('0', 'UAH', 'en', '?'), '0.00 UAH');
assert.equal(fmtMinor('-150', null, 'en', '?'), '−1.50');
assert.equal(fmtMinor('1000000', 'UAH', 'uk', '?'), '10 000,00 UAH');
assert.equal(
  fmtMinor('90071992547409931', 'UAH', 'en', '?'),
  '900,719,925,474,099.31 UAH'
);
assert.equal(fmtMinor('1e5', 'UAH', 'en', '?'), '?');
assert.equal(fmtMicroUsd(null, 'невідомо'), 'невідомо');
assert.equal(fmtMicroUsd('0', '?'), '$0.0000');
assert.equal(fmtMicroUsd('2500000', '?'), '$2.50');

// ═══ 4. Видимость по ролям — подсказка (AT-CORE-11) ════════════════════
const role = (roles: string[], admin = false, owner = false): MyRoles => ({
  roles: roles as MyRoles['roles'],
  admin,
  accountOwner: owner,
});
const viewer = role(['viewer']);
const editor = role(['editor']);
const po = role(['product_owner']);
const admin = role([], true);
const owner = role([], true, true);
assert.equal(canDo(viewer, 'product.read'), true);
assert.equal(canDo(viewer, 'source.manage'), false);
assert.equal(canDo(viewer, 'role.manage'), false);
assert.equal(canDo(editor, 'source.manage'), true);
assert.equal(canDo(editor, 'version.approve'), false);
assert.equal(canDo(editor, 'parameter.decide'), false);
assert.equal(canDo(po, 'version.approve'), true);
assert.equal(canDo(po, 'parameter.decide'), true);
assert.equal(canDo(po, 'role.manage'), false);
assert.equal(canDo(admin, 'role.manage'), true);
assert.equal(
  canDo(admin, 'parameter.decide'),
  false,
  'админ не решает параметры'
);
assert.equal(canDo(admin, 'restore.apply'), false);
assert.equal(canDo(owner, 'restore.apply'), true);
assert.equal(
  canDo(owner, 'lead.contact.reveal'),
  true,
  'владелец — и продажи (Р-PUB-2)'
);
assert.equal(canDo(role(['operator']), 'qa.technical'), true);
assert.equal(canDo(role(['operator']), 'qa.editorial'), false);
assert.equal(canAny(viewer, undefined), true);
assert.equal(canAny(viewer, ['audit.read', 'role.manage']), false);
assert.equal(canAny(role(['analyst']), ['audit.read', 'role.manage']), true);
// Кнопка «Publisher» на экране сайта и создание продукта.
const me = (r: string, publisher?: string) => ({
  role: r,
  productRoles: publisher === undefined ? {} : { publisher },
});
assert.equal(publisherEntryVisible(me('owner')), true);
assert.equal(publisherEntryVisible(me('manager', 'none')), false);
assert.equal(publisherEntryVisible(me('manager')), false);
assert.equal(publisherEntryVisible(me('operator', 'member')), true);
assert.equal(canCreateProduct(me('operator', 'member')), false);
assert.equal(canCreateProduct(me('manager', 'admin')), true);
assert.equal(canCreateProduct(me('owner')), true);
// Кит: ключ publisher разбирается строго.
{
  const acc = (pr: unknown) =>
    parseAccountInfo({
      account: { id: 'a', type: 'owner', region: 'ua', verifyToken: null },
      me: {
        memberId: 'm1',
        telegramId: '1',
        role: 'manager',
        productRoles: pr,
      },
      members: null,
      accounts: [],
      created: false,
    });
  // «Поздний» ключ: `none`/мусор — ключа нет (= none), форма прав прежняя.
  assert.equal(acc({ qa: 'none' }).me.productRoles.publisher, undefined);
  assert.equal(acc({ publisher: 'none' }).me.productRoles.publisher, undefined);
  assert.equal(
    acc({ publisher: 'member' }).me.productRoles.publisher,
    'member'
  );
  assert.equal(acc({ publisher: 'root' }).me.productRoles.publisher, undefined);
  assert.equal(publisherEntryVisible(acc({ publisher: 'root' }).me), false);
  assert.equal(publisherEntryVisible(acc({ publisher: 'admin' }).me), true);
}

// ═══ 5. Ошибки PUB_* человеческим текстом ══════════════════════════════
const err = (code: string, status: number, details?: Record<string, unknown>) =>
  new ApiError(code, 'server text', status, 'rq', details);
{
  const v = describePubError(
    err('PUB_CONFLICT', 409, { currentRevision: 7 }),
    t
  );
  assert.equal(v.conflict, true);
  assert.equal(v.title, t.errors.codes.PUB_CONFLICT);
  assert.ok(v.lines.includes(t.errors.conflictText));
}
{
  const v = describePubError(
    err('PUB_GATE_CLOSED', 409, {
      gate: 'public_publish',
      missing: [
        { kind: 'parameter', key: 'niche', detail: 'not_approved' },
        { kind: 'host', key: 'ai-publisher.org', detail: 'not_verified' },
      ],
    }),
    t
  );
  assert.equal(v.conflict, false);
  assert.ok(v.lines[0] === t.gates.names.public_publish);
  assert.ok(
    v.lines.some(
      (l) =>
        l.includes(t.params.keys.niche) &&
        l.includes(t.gates.details.not_approved)
    )
  );
  assert.ok(v.lines.some((l) => l.includes('ai-publisher.org')));
}
{
  const v = describePubError(
    err('PUB_VALIDATION', 400, { fields: [{ field: 'basis', code: 'pii' }] }),
    t
  );
  assert.ok(
    v.lines[0].includes('basis') && v.lines[0].includes(t.errors.fieldCodes.pii)
  );
}
{
  const v = describePubError(
    err('PUB_IMPORT_BLOCKED', 400, { reason: 'ssrf' }),
    t
  );
  assert.ok(v.lines.includes(t.errors.importReasons.ssrf));
  assert.ok(!v.lines.some((l) => l.includes('ssrf')), 'причина — словами');
}
// `purchases_disabled` (per_purchase_max = 0): гейт закупок и 409 бюджета —
// словами во всех языках, без сырого кода причины.
for (const d of [pubUk, pubRu, pubEn]) {
  assert.ok(d.gates.details.purchases_disabled, 'gates.details');
  assert.ok(d.errors.budgetReasons.purchases_disabled, 'budgetReasons');
  assert.deepEqual(
    Object.keys(d.errors.budgetReasons).sort(),
    Object.keys(pubRu.errors.budgetReasons).sort()
  );
  for (const code of ['PUB_BUDGET_INSUFFICIENT', 'PUB_GATE_CLOSED']) {
    const v = describePubError(
      err(code, 409, {
        reason: 'purchases_disabled',
        available: 0,
        requested: 500,
        gate: 'purchases',
      }),
      d
    );
    assert.ok(v.lines.includes(d.errors.budgetReasons.purchases_disabled));
    assert.ok(
      !v.lines.some((l) => l.includes('purchases_disabled')),
      `${code}: причина — словами`
    );
  }
  const g = describePubError(
    err('PUB_GATE_CLOSED', 409, {
      gate: 'purchases',
      missing: [
        {
          kind: 'parameter',
          key: 'per_purchase_max',
          detail: 'purchases_disabled',
        },
      ],
    }),
    d
  );
  assert.ok(
    g.lines.some((l) => l.endsWith(d.gates.details.purchases_disabled)),
    'деталь гейта словами'
  );
}
assert.ok(
  pubRu.errors.budgetReasons.purchases_disabled.startsWith(
    'Закупки отключены: максимум одной закупки — 0'
  )
);
{
  // Незнакомая причина бюджета — по-прежнему строкой «Причина: …».
  const v = describePubError(
    err('PUB_BUDGET_INSUFFICIENT', 409, { reason: 'new_reason_x' }),
    t
  );
  assert.ok(v.lines.some((l) => l.includes('new_reason_x')));
}
{
  const v = describePubError(err('PUB_NOT_IMPLEMENTED', 501), t);
  assert.equal(v.title, t.errors.codes.PUB_NOT_IMPLEMENTED);
  assert.equal(v.conflict, false);
}
{
  const v = describePubError(
    err('PUB_AI_DISABLED', 409, { callId: 'call9' }),
    t
  );
  assert.equal(v.manualPath, true);
  assert.ok(v.lines.some((l) => l.includes('call9')));
}
{
  const v = describePubError(
    err('PUB_BLOCKERS_OPEN', 409, {
      blockers: [
        { code: 'qa_editorial_missing' },
        { code: 'claim_not_supported', id: 'c1' },
      ],
    }),
    t
  );
  assert.deepEqual(v.lines, [
    t.errors.blockers.qa_editorial_missing,
    t.errors.blockers.claim_not_supported,
  ]);
}
{
  const v = describePubError(err('PUB_BUSY', 503), t);
  assert.equal(v.retryable, true);
  const n = describePubError(new ApiError('network', 'x', 0), t);
  assert.equal(n.retryable, true);
  assert.equal(describePubError(err('http_504', 504), t).retryable, true);
  assert.equal(
    describePubError(err('PUB_VALIDATION', 400), t).retryable,
    false
  );
  assert.equal(n.title, t.errors.network);
  const unknown = describePubError(err('SOMETHING_NEW', 418), t);
  assert.equal(unknown.title, 'server text');
}

// ═══ 6. План 2/2/2, проверки QA как у сервера, раздел объекта ═══════════
{
  const b = (format: S.BriefFormat, status = 'draft') => ({ format, status });
  assert.equal(
    planBalance([
      b('instruction'),
      b('instruction'),
      b('case_review'),
      b('case_review'),
      b('choice_guide'),
      b('choice_guide'),
    ]).balanced,
    true
  );
  const off = planBalance([
    b('instruction'),
    b('instruction'),
    b('instruction', 'rejected'),
    b('case_review'),
  ]);
  assert.equal(off.balanced, false);
  assert.equal(off.counts.instruction, 2, 'отклонённый бриф не считается');
  assert.equal(off.counts.choice_guide, 0);
}
{
  const q = (
    kind: string,
    result: string,
    at: string,
    blockers: unknown[] = []
  ) => ({
    kind,
    result,
    checkedAt: at,
    blockers,
  });
  // Последняя проверка решает: старый fail, новый pass — ок.
  assert.deepEqual(
    qaState(
      [
        q('editorial', 'fail', '2026-10-01T00:00:00Z'),
        q('editorial', 'pass', '2026-10-02T00:00:00Z'),
        q('technical', 'pass', '2026-10-02T00:00:00Z'),
      ],
      false
    ),
    { missing: [], blockers: 0 }
  );
  // Новый unknown после pass — снова не хватает.
  assert.deepEqual(
    qaState(
      [
        q('editorial', 'pass', '2026-10-01T00:00:00Z'),
        q('editorial', 'unknown', '2026-10-03T00:00:00Z'),
      ],
      false
    ).missing,
    ['editorial', 'technical']
  );
  assert.deepEqual(qaState([], true).missing, [
    'editorial',
    'technical',
    'adaptation_meaning',
  ]);
  assert.equal(
    qaState(
      [
        q('editorial', 'pass', '2026-10-01T00:00:00Z', [{}]),
        q('technical', 'pass', '2026-10-01T00:00:00Z'),
      ],
      false
    ).blockers,
    1
  );
}
assert.equal(objectSection('content_version'), 'materials');
assert.equal(objectSection('brief'), 'briefs');
assert.equal(objectSection('lead'), 'leads');
assert.equal(objectSection('backup'), null);
assert.equal(
  statusLabel('approved', t.params.statuses),
  t.params.statuses.approved
);
assert.equal(statusLabel('brand_new', t.params.statuses), 'brand_new');

// ═══ 7. Словари P-G1: полнота и паритет uk/ru/en ═════════════════════════
function shape(v: unknown, prefix = ''): string[] {
  if (typeof v === 'string') {
    assert.ok(v.trim().length > 0, `пустая строка: ${prefix}`);
    return [`${prefix}:${(v.match(/\{\w+\}/g) ?? []).sort().join(',')}`];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => shape(x, `${prefix}[${i}]`));
  assert.ok(v !== null && typeof v === 'object', `не объект: ${prefix}`);
  return Object.keys(v as object)
    .sort()
    .flatMap((k) =>
      shape((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k)
    );
}
assert.deepEqual(shape(pubUk), shape(pubRu));
assert.deepEqual(shape(pubEn), shape(pubRu));
assert.deepEqual(shape(pubContentUk), shape(pubContentRu));
assert.deepEqual(shape(pubContentEn), shape(pubContentRu));
// Переведено, а не скопировано: заметная доля строк отличается от ru.
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  return Object.values(v as object).flatMap(strings);
}
for (const [name, a, b] of [
  ['pub uk', pubUk, pubRu],
  ['pub en', pubEn, pubRu],
  ['content uk', pubContentUk, pubContentRu],
  ['content en', pubContentEn, pubContentRu],
] as const) {
  const x = strings(a);
  const y = strings(b);
  const same = x.filter((s, i) => s === y[i] && /[а-яёіїє]{4}/i.test(s)).length;
  assert.ok(
    same / x.length < 0.1,
    `${name}: не переведено ${same} из ${x.length}`
  );
}
for (const d of [pubUk, pubRu, pubEn]) {
  for (const c of PUB_ERROR_CODES) assert.ok(d.errors.codes[c], c);
  for (const k of S.PARAMETER_KEYS) assert.ok(d.params.keys[k], k);
  for (const k of S.GATE_MISSING_KINDS) assert.ok(d.gates.missingKinds[k], k);
  for (const k of S.REVIEW_REASONS) assert.ok(d.review.reasons[k], k);
  for (const k of S.APPROVAL_BLOCKER_CODES) assert.ok(d.errors.blockers[k], k);
}
for (const d of [pubContentUk, pubContentRu, pubContentEn]) {
  for (const k of S.GENERATOR_IDS) assert.ok(d.ai.generators[k], k);
  for (const k of S.AI_CALL_STATUSES) assert.ok(d.ai.callStatuses[k], k);
  for (const k of S.CONTENT_STATUSES) assert.ok(d.materials.statuses[k], k);
  for (const k of S.DISTRIBUTION_BLOCK_REASONS)
    assert.ok(d.calendar.blockReasons[k], k);
  for (const k of S.BRIEF_MISSING) assert.ok(d.brief.missing[k], k);
}

// ═══ Раунд исправлений по аудиту P-G (A1, A3, S2 «никакого зелёного») ═══
// A1: ключ попытки — один на попытку и на действие.
{
  let n = 0;
  const gen = () => `k${++n}`;
  const a = CA.opKeyFor(null, 'POST x {1}', gen);
  assert.deepEqual(a, { key: 'k1', sig: 'POST x {1}' });
  // Сеть/таймаут/занято — тот же ключ для той же попытки…
  const net = new ApiError('network', 'n', 0);
  const kept = CA.opKeyAfter(a, net);
  assert.equal(kept, a);
  assert.equal(CA.opKeyFor(kept, 'POST x {1}', gen).key, 'k1');
  assert.equal(CA.opKeyAfter(a, new ApiError('PUB_BUSY', 'b', 503)), a);
  // Р-RD-AUD-7: ответ шлюза (502/503/504, `UPSTREAM_TIMEOUT` прокси
  // Админки) — исход неизвестен, тот же ключ (сервер вернёт сохранённое).
  for (const g of [
    new ApiError('UPSTREAM_TIMEOUT', 't', 504),
    new ApiError('http_504', 't', 504),
    new ApiError('http_502', 't', 502),
    new ApiError('http_503', 't', 503),
    new ApiError('Bad Gateway', 't', 502),
  ]) {
    assert.equal(CA.opKeyAfter(a, g), a, g.code);
    assert.equal(CA.isRetryable(g), true, g.code);
  }
  assert.equal(CA.isRetryable(new ApiError('http_500', 'x', 500)), false);
  assert.equal(CA.isRetryable(new ApiError('PUB_FORBIDDEN', 'x', 403)), false);
  // Прикладной код при 502/503/504 — явный ответ сервера, не шлюза: отказ
  // модели сохранён под этим opKey, тот же ключ воспроизвёл бы его навсегда.
  for (const g of [
    new ApiError('PUB_AI_UNAVAILABLE', 'm', 503),
    new ApiError('PUB_CONTACT_KEY_MISSING', 'm', 503),
    new ApiError('PUB_FORM_CLOSED', 'm', 503),
    new ApiError('PUB_INTERNAL', 'm', 502),
  ]) {
    assert.equal(CA.opKeyAfter(a, g), null, g.code);
    assert.equal(CA.isRetryable(g), false, g.code);
  }
  assert.equal(CA.opKeyAfter(a, new ApiError('PUB_BUSY', 'b', 503)), a);
  // …но ДРУГОЕ действие — новый ключ (иначе 409 PUB_IDEMPOTENCY_REUSED).
  assert.equal(CA.opKeyFor(kept, 'POST y {1}', gen).key, 'k2');
  // Успех и неповторяемая ошибка — ключ сброшен.
  assert.equal(CA.opKeyAfter(a, null), null);
  assert.equal(CA.opKeyAfter(a, new ApiError('PUB_CONFLICT', 'c', 409)), null);
  assert.equal(
    CA.opKeyAfter(a, new ApiError('PUB_VALIDATION', 'v', 400)),
    null
  );
  assert.equal(CA.opKeyFor(null, 'POST x {1}', gen).key, 'k3');
}
// A3: в `href` — только http(s).
{
  assert.equal(V.safeHref('https://e.com/a?b=1'), 'https://e.com/a?b=1');
  assert.equal(V.safeHref(' http://e.com '), 'http://e.com/');
  for (const bad of [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:x',
    '//e.com',
    'e.com',
    'https://',
    '',
    null,
    undefined,
  ])
    assert.equal(V.safeHref(bad), null, String(bad));
}
// S2: зелёный — только проверенное; неизвестное — не зелёный.
{
  assert.equal(V.placementTone('verified_complete'), 'success');
  for (const st of ['published', 'disputed'])
    assert.equal(V.placementTone(st), 'warning', st);
  for (const st of PLACEMENT_STATUSES)
    if (st !== 'verified_complete')
      assert.notEqual(V.placementTone(st), 'success', st);
  assert.equal(
    V.publicationTone({ status: 'published', verifyStatus: 'ok' }),
    'success'
  );
  for (const vs of ['not_checked', 'failed', 'unknown', ''])
    assert.equal(
      V.publicationTone({ status: 'published', verifyStatus: vs }),
      'warning',
      vs
    );
  for (const st of ['pending', 'planned', 'failed', 'withdrawn', 'x'])
    assert.notEqual(
      V.publicationTone({ status: st, verifyStatus: 'ok' }),
      'success',
      st
    );
}
// S3: сырые ключи — словами (все словари), незнакомое — как есть.
for (const d of [pubUk, pubRu, pubEn]) {
  assert.equal(
    V.unknownPartLabel('ai:no_fx_rate', d.computable),
    d.computable.parts['ai:no_fx_rate']
  );
  assert.equal(V.unknownPartLabel('x:y', d.computable), 'x:y');
  assert.equal(V.unknownPartLabel('toString', d.computable), 'toString');
  const ws = V.missingLabel('integration:web_analytics', d.completeness);
  assert.ok(ws.includes(d.completeness.kinds.web_analytics), ws);
  assert.ok(
    V.missingLabel('web_analytics_day:2026-10-01', d.completeness).includes(
      '2026-10-01'
    )
  );
  assert.equal(
    V.missingLabel('placement:delivery_unconfirmed', d.completeness),
    d.completeness.codes.placement_delivery_unconfirmed
  );
  assert.equal(V.missingLabel('other:z', d.completeness), 'other:z');
  assert.equal(V.gateDetailLabel('not_set', d), d.gates.details.not_set);
  assert.ok(V.gateDetailLabel('pending_or_unknown:3', d).includes('3'));
  assert.equal(V.gateDetailLabel('zzz', d, { zzz: 'Z' }), 'Z');
  assert.equal(V.gateDetailLabel('constructor', d), 'constructor');
  // Разобранный «не вычисляется» показывает части словами, не ключами.
  const up = V.computableText<number>(
    { kind: 'value', value: 5, unknownParts: ['ai:unpriced_calls'] },
    String,
    d.computable,
    d.common.unknown
  );
  const shown = JSON.stringify(up);
  assert.ok(!shown.includes('ai:unpriced_calls'), shown);
  assert.ok(shown.includes(d.computable.parts['ai:unpriced_calls']), shown);
}
// S3: фильтр «ответственный» — участники, «без», текущее из URL.
{
  const o = V.ownerOptions('m9', 'me', [
    { memberId: 'me', label: 'Я' },
    { memberId: 'm2', label: 'Оля' },
  ]);
  assert.deepEqual(
    o.map((x) => x.value),
    ['', 'me', 'm2', 'm9']
  );
  assert.equal(o[2].label, 'Оля');
  assert.deepEqual(
    V.ownerOptions('', 'me', [], true).map((x) => x.value),
    ['', 'me', 'none']
  );
}
// S3: CSV журнала частями (`X-Next-Before`) — склейка без повторного
// заголовка; на пределе — помечен неполным.
{
  const asked: string[] = [];
  const mk =
    (pages: number): CA.RawGet =>
    async (p) => {
      asked.push(p);
      const m = /before=(\d+)/.exec(p);
      const i = m ? Number(m[1]) : 0;
      return {
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        disposition: 'attachment; filename="publisher-ai-calls.csv"',
        text: `id,cost\r\nr${i},1\r\n`,
        nextBefore: i + 1 < pages ? String(i + 1) : null,
      };
    };
  const f = await CA.csvAll(mk(3), 'products/p/ai/calls', { status: 'done' });
  assert.equal(f.text, 'id,cost\r\nr0,1\r\nr1,1\r\nr2,1\r\n');
  assert.equal(f.parts, 3);
  assert.equal(f.truncated, false);
  assert.ok(asked[1].includes('before=1') && asked[1].includes('status=done'));
  asked.length = 0;
  const big = await CA.csvAll(mk(99), 'products/p/ai/calls', {});
  assert.equal(big.parts, CA.CSV_MAX_PARTS);
  assert.equal(big.truncated, true);
  assert.equal(asked.length, CA.CSV_MAX_PARTS);
  assert.equal(big.text.split('id,cost').length, 2);
}

// Раунд 3 P-R-ADM: Reddit-списки тоже выгружаются частями (`X-Next-Before`
// сервера, ≤ 5000 строк на часть) — кабинет склеивает 5000 + 1000 строк
// без потерь, дублей и повторного заголовка; фильтр списка сохраняется.
{
  const asked: string[] = [];
  const rows = (from: number, n: number) =>
    Array.from({ length: n }, (_, k) => `k${from + k},phrase`).join('\n');
  const raw: CA.RawGet = async (p) => {
    asked.push(p);
    const second = /before=k4999(&|$)/.test(p);
    return {
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="publisher-reddit-keywords.csv"',
      text: `id,phrase\n${second ? rows(5000, 1000) : rows(0, 5000)}\n`,
      nextBefore: second ? null : 'k4999',
    };
  };
  const path = redditListPath('p1', 'keywords');
  const f = await CA.csvAll(raw, path, { status: 'active' });
  const lines = f.text.trim().split('\n');
  assert.equal(lines[0], 'id,phrase');
  assert.equal(lines.length - 1, 6000);
  assert.equal(new Set(lines.slice(1)).size, 6000);
  assert.equal(f.parts, 2);
  assert.equal(f.truncated, false);
  assert.ok(
    asked[0].includes('/reddit/keywords') && asked[0].includes('format=csv')
  );
  assert.ok(
    asked[1].includes('before=k4999') && asked[1].includes('status=active')
  );
}

// ═══ Каналы и смена статуса публикации (раунд 2) ═══════════════════════
{
  const f0 = CH.channelForm(null);
  assert.equal(CH.channelCreateBody(f0), null);
  const f1: CH.ChannelForm = {
    ...f0,
    code: 'tg-main',
    title: ' Телеграм ',
    kind: 'own',
    utmSource: 'telegram',
    utmMedium: 'social',
  };
  // «Реклама разрешена» не задана — null (неизвестно), а не false.
  assert.deepEqual(CH.channelCreateBody(f1), {
    code: 'tg-main',
    title: 'Телеграм',
    kind: 'own',
    utmSource: 'telegram',
    utmMedium: 'social',
    adsAllowed: null,
  });
  assert.equal(
    CH.channelCreateBody({ ...f1, ads: 'no', rulesNote: ' r ' })?.rulesNote,
    'r'
  );
  assert.equal(CH.channelCreateBody({ ...f1, ads: 'no' })?.adsAllowed, false);
  // Как сервер: код, вид (без `site`), алфавит UTM.
  for (const bad of [
    { code: 'TG' },
    { code: '-x' },
    { code: 'a'.repeat(65) },
    { kind: 'site' },
    { kind: '' },
    { utmSource: 'a@b.com?x' },
    { utmMedium: '' },
    { utmSource: 'x'.repeat(101) },
    { title: '  ' },
  ])
    assert.equal(
      CH.channelCreateBody({ ...f1, ...bad }),
      null,
      JSON.stringify(bad)
    );
  assert.ok(CH.channelCreateBody({ ...f1, utmSource: 'Телеграм канал/1' }));
  const ch = {
    id: 'ch1',
    code: 'tg-main',
    title: 'Телеграм',
    kind: 'own' as const,
    utmSource: 'telegram',
    utmMedium: 'social',
    adsAllowed: null,
    rulesNote: null,
    status: 'available' as const,
    revision: 4,
  };
  const ef = CH.channelForm(ch);
  assert.equal(ef.ads, 'unknown');
  assert.equal(CH.channelPatchBody(ch, ef), null, 'без изменений — тела нет');
  assert.deepEqual(
    CH.channelPatchBody(ch, { ...ef, status: 'unavailable', ads: 'yes' }),
    { expectedRevision: 4, adsAllowed: true, status: 'unavailable' }
  );
  // Код и вид в правке не уходят (сервер их не принимает).
  const pb = CH.channelPatchBody(ch, {
    ...ef,
    code: 'zzz',
    kind: 'community',
    title: 'T2',
  });
  assert.deepEqual(pb, { expectedRevision: 4, title: 'T2' });
  assert.deepEqual(
    CH.channelPatchBody({ ...ch, rulesNote: 'old' }, { ...ef, rulesNote: '' }),
    { expectedRevision: 4, rulesNote: null }
  );
  // Публикация: переходы как `PUBLICATION_MACHINE` (`replaced` — система).
  assert.deepEqual(CH.publicationTargets({ status: 'pending' }), [
    'published',
    'failed',
    'withdrawn',
  ]);
  assert.deepEqual(CH.publicationTargets({ status: 'published' }), [
    'withdrawn',
  ]);
  for (const st of ['replaced', 'failed', 'withdrawn'])
    assert.deepEqual(CH.publicationTargets({ status: st as 'failed' }), []);
  const pp = { status: 'published' as const, revision: 2 };
  assert.equal(CH.publicationTransitionBody(pp, 'withdrawn', ' '), null);
  assert.deepEqual(
    CH.publicationTransitionBody(pp, 'withdrawn', ' устарело '),
    {
      expectedRevision: 2,
      to: 'withdrawn',
      reason: 'устарело',
    }
  );
  assert.equal(CH.publicationTransitionBody(pp, 'failed', ''), null);
  assert.deepEqual(
    CH.publicationTransitionBody(
      { status: 'pending', revision: 1 },
      'published',
      ''
    ),
    { expectedRevision: 1, to: 'published' }
  );
  assert.equal(CH.withdrawTakesDownPage('site'), true);
  assert.equal(CH.withdrawTakesDownPage('own'), false);
  assert.equal(CH.withdrawTakesDownPage(undefined), false);
}
// Словари каналов: все виды, статусы и переходы подписаны (×3).
for (const d of [pubContentUk, pubContentRu, pubContentEn]) {
  for (const k of ['own', 'community', 'paid_venue', 'site'] as const)
    assert.ok(d.channels.kinds[k], k);
  for (const k of ['available', 'unavailable'] as const)
    assert.ok(d.channels.statuses[k], k);
  for (const k of ['published', 'failed', 'withdrawn'] as const)
    assert.ok(d.materials.pubTo[k], k);
}

// ═══ P-R Reddit (M1): матрица §5, selfReview, тексты причин ══════════════
{
  const { readFileSync } = await import('node:fs');
  const back = (f: string) =>
    readFileSync(
      new URL(
        `../../sites-backend/src/modules/publisher/${f}`,
        import.meta.url
      ),
      'utf8'
    );
  // selfReview зеркала ≡ core/roles.ts (рантайм-сверка ролей — publisher-api).
  const ROLES_SRC = back('core/roles.ts');
  const ab: Record<string, string> = {
    PO: 'product_owner',
    ED: 'editor',
    OP: 'operator',
    AN: 'analyst',
    SA: 'sales',
    VW: 'viewer',
  };
  const server: Record<string, string[]> = {};
  for (const m of ROLES_SRC.matchAll(
    /'([a-z_.]+)': \{[^}]*selfReview: \[([^\]]*)\]/g
  ))
    server[m[1]] = [...m[2].matchAll(/[A-Z]{2}/g)].map((x) => ab[x[0]]);
  const mine: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(PUB_PERMISSIONS) as Array<
    [string, { selfReview?: readonly string[] }]
  >)
    if (v.selfReview) mine[k] = [...v.selfReview];
  assert.deepEqual(mine, server, 'selfReview ≠ core/roles.ts');
  assert.deepEqual(server['reddit.rules.review'], ['product_owner', 'editor']);
  // Матрица Reddit по ролям (AT-RD-02: VW не подтверждает правила).
  const rows: Array<[MyRoles, [boolean, boolean, boolean, boolean]]> = [
    [role(['product_owner']), [true, true, true, true]],
    [role(['editor']), [true, true, true, false]],
    [role(['operator']), [true, false, false, true]],
    [role(['analyst']), [true, false, false, false]],
    [role(['sales']), [false, false, false, false]],
    [role(['viewer']), [true, false, false, false]],
    [role([], true), [true, false, false, false]],
    [role([], true, true), [true, true, true, true]],
  ];
  for (const [my, exp] of rows) {
    assert.deepEqual(
      [
        canDo(my, 'reddit.read'),
        canDo(my, 'reddit.manage'),
        canDo(my, 'reddit.rules.review'),
        canDo(my, 'reddit.handoff'),
      ],
      exp,
      JSON.stringify(my)
    );
  }
  // Вкладка раздела — `reddit.read`: продажи её не видят.
  assert.equal(canAny(role(['sales']), ['reddit.read']), false);
  assert.equal(canAny(viewer, ['reddit.read']), true);
  // Причины отказа импорта (P-B1 + P-R `reddit_manual_only`) — словами.
  const IMPORT = back('content/source-import.ts');
  const reasons = [
    ...(/export const IMPORT_BLOCK_REASONS = \[([\s\S]*?)\] as const/.exec(
      IMPORT
    ) ?? ['', ''])[1].matchAll(/'([a-z_0-9]+)'/g),
  ].map((x) => x[1]);
  assert.ok(reasons.includes('reddit_manual_only'));
  for (const d of [pubUk, pubRu, pubEn])
    for (const x of reasons)
      assert.ok(
        (d.errors.importReasons as Record<string, string>)[x],
        `importReasons.${x}`
      );
  // Коды полей P-R — словами (`PUB_VALIDATION.details.fields[].code`).
  for (const d of [pubUk, pubRu, pubEn])
    for (const c of [
      'community_mismatch',
      'project_mismatch',
      'derived',
      'future',
      'profile_ref',
      'unknown',
      'unknown_field',
      'pii',
    ])
      assert.ok((d.errors.fieldCodes as Record<string, string>)[c], c);
  // Объекты журнала P-R ведут в раздел «Reddit».
  for (const ot of [
    'reddit_project',
    'reddit_community',
    'reddit_rule_snapshot',
    'reddit_keyword',
    'reddit_opportunity',
    'reddit_brief',
  ])
    assert.equal(objectSection(ot), 'reddit', ot);
  // Раунд 2 P-R: правка источника Reddit в общем разделе → 409
  // `reddit_evidence_locked` — словами, без «перезагрузить» (это правило,
  // а не устаревшая версия); все причины `PUB_CONFLICT` сервисов источников.
  const SRC = back('content/sources.service.ts');
  const conflictReasons = [
    ...SRC.matchAll(/PUB_CONFLICT', \{ reason: '([a-z_]+)' \}/g),
  ].map((x) => x[1]);
  assert.ok(conflictReasons.includes('reddit_evidence_locked'));
  for (const d of [pubUk, pubRu, pubEn]) {
    for (const x of conflictReasons)
      assert.ok(
        (d.errors.conflictReasons as Record<string, string>)[x],
        `conflictReasons.${x}`
      );
    const v = describePubError(
      new ApiError('PUB_CONFLICT', 'x', 409, 'rq', {
        reason: 'reddit_evidence_locked',
      }),
      d
    );
    assert.deepEqual(v.lines, [
      d.errors.conflictReasons.reddit_evidence_locked,
    ]);
    assert.equal(v.conflict, false);
    // CAS-конфликт по-прежнему — «перезагрузить».
    const cas = describePubError(
      new ApiError('PUB_CONFLICT', 'x', 409, 'rq', { currentRevision: 2 }),
      d
    );
    assert.equal(cas.conflict, true);
    assert.deepEqual(cas.lines, [d.errors.conflictText]);
  }
  // Параметр свежести правил — подписан и в группе экрана «Запуск».
  assert.ok(S.PARAMETER_KEYS.includes('reddit_rules_stale_days'));
  for (const d of [pubUk, pubRu, pubEn])
    assert.ok(d.params.keys.reddit_rules_stale_days);
}

// Аудит ui-3 (15.10.2026): двухшаговое подтверждение — второй щелчок
// двойного клика и нажатие раньше паузы не подтверждают.
{
  assert.equal(V.confirmClick(null, 0, 1), 'arm');
  assert.equal(V.confirmClick(0, 100, 2), 'ignore');
  assert.equal(V.confirmClick(0, V.CONFIRM_GUARD_MS - 1, 1), 'ignore');
  assert.equal(V.confirmClick(0, V.CONFIRM_GUARD_MS + 1000, 2), 'ignore');
  assert.equal(V.confirmClick(0, V.CONFIRM_GUARD_MS, 1), 'confirm');
  assert.equal(V.confirmClick(0, V.CONFIRM_GUARD_MS, 0), 'confirm');
}

console.log('publisher-view: ok');
