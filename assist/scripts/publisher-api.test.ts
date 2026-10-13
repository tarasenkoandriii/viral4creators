/**
 * AI Publisher (P-G1, §14.3): декодеры кабинета против фикстур и против
 * ключей типов `sites-backend/src/modules/publisher/contracts/*-api.ts`
 * (исходник читается текстом, как `ai-api.test.ts`), закрытые списки и
 * коды ошибок — как у сервера, матрица ролей — как `core/roles.ts`, пути
 * клиента — из `*_ROUTES`, `opKey` в теле, CSV (в т. ч. в конверте),
 * опрос AI-вызова.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, type ApiClient } from '../src/kit';
import * as ai from '../src/lib/publisher/ai-api';
import * as cal from '../src/lib/publisher/calendar-api';
import {
  OP_KEY_RE,
  createPublisherHttp,
  newOpKey,
  queryString,
  type RawGet,
} from '../src/lib/publisher/common-api';
import * as content from '../src/lib/publisher/content-api';
import * as core from '../src/lib/publisher/core-api';
import { computable, PubDecodeError } from '../src/lib/publisher/decode';
import { PUB_ERROR_CODES } from '../src/lib/publisher/errors';
import { PUB_PERMISSIONS, PUB_ROLES } from '../src/lib/publisher/permissions';
import * as S from '../src/lib/publisher/states';
import { bodyIssues, bodyKeys, routesOf } from './publisher-contract-lib';

const BACK = '../../sites-backend/src/modules/publisher/';
const src = (rel: string) =>
  readFileSync(new URL(`${BACK}${rel}`, import.meta.url), 'utf8');
const FX = JSON.parse(
  readFileSync(new URL('./fixtures/publisher/g1.json', import.meta.url), 'utf8')
) as Record<string, Record<string, unknown>>;

function constList(file: string, name: string): string[] {
  const m = file.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`)
  );
  assert.ok(m, `нет ${name}`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Ключи верхнего уровня `export interface Name {…}` исходника. */
function interfaceKeys(file: string, name: string): string[] {
  const start = file.search(new RegExp(`export interface ${name}\\b[^{]*\\{`));
  assert.ok(start >= 0, `нет интерфейса ${name}`);
  const open = file.indexOf('{', start);
  let depth = 0;
  let i = open;
  const keys: string[] = [];
  let line = '';
  for (; i < file.length; i++) {
    const ch = file[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) break;
    }
    if (ch === '\n') {
      line = '';
      continue;
    }
    line += ch;
    if (depth === 1) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:$/.exec(line);
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

const STATES = src('contracts/states.ts');
const COMMON = src('contracts/common.ts');
const CORE = src('contracts/core-api.ts');
const CONTENT = src('contracts/content-api.ts');
const AI = src('contracts/ai-api.ts');
const AIT = src('contracts/ai.ts');
const DIST = src('contracts/distribution-api.ts');
const PARAMS = src('contracts/parameters.ts');
const ERRORS = src('contracts/errors.ts');
const ROLES = src('core/roles.ts');

// ═══ 1. Закрытые списки — как у сервера ═════════════════════════════════
for (const name of [
  'PRODUCT_KINDS',
  'PRODUCT_MODES',
  'PRODUCT_STATUSES',
  'PARAMETER_STATUSES',
  'DEPENDENT_STAGES',
  'REVIEW_REASONS',
  'REVIEW_SEVERITIES',
  'REVIEW_STATUSES',
  'SOURCE_KINDS',
  'SOURCE_USAGES',
  'SOURCE_VISIBILITIES',
  'SOURCE_FRESHNESS',
  'SOURCE_IMPORTED_VIA',
  'QUESTION_STAGES',
  'QUESTION_GROUP_STATUSES',
  'QUESTION_STATUSES',
  'QUESTION_SCORE_KEYS',
  'BRAND_FACT_KINDS',
  'BRAND_FACT_STATUSES',
  'OFFER_STATUSES',
  'BRIEF_FORMATS',
  'BRIEF_STATUSES',
  'CONTENT_KINDS',
  'CONTENT_STATUSES',
  'VERSION_STATUSES',
  'CLAIM_TYPES',
  'CLAIM_RISKS',
  'CLAIM_STATUSES',
  'CLAIM_SUPPORTS',
  'QA_CHECK_KINDS',
  'QA_RESULTS',
  'APPROVAL_STATUSES',
  'CHANNEL_KINDS',
  'CHANNEL_STATUSES',
  'DISTRIBUTION_STATUSES',
  'DISTRIBUTION_BLOCK_REASONS',
  'PUBLICATION_STAGES',
  'PUBLICATION_STATUSES',
  'PUBLICATION_VERIFY_STATUSES',
  'AI_TASK_STATUSES',
  'AI_CALL_STATUSES',
  'AI_COST_STATUSES',
] as const) {
  assert.deepEqual(
    [...(S as unknown as Record<string, readonly string[]>)[name]],
    constList(STATES, name),
    name
  );
}
assert.deepEqual([...PUB_ROLES], constList(STATES, 'PUB_ROLES'));
assert.deepEqual([...S.GATE_NAMES], constList(COMMON, 'GATE_NAMES'));
assert.deepEqual(
  [...S.GATE_MISSING_KINDS],
  constList(COMMON, 'GATE_MISSING_KINDS')
);
assert.deepEqual([...S.GENERATOR_IDS], constList(AIT, 'GENERATOR_IDS'));
{
  const m = AIT.match(/P0_ENABLED_GENERATORS = \[([\s\S]*?)\] as const/);
  assert.ok(m);
  assert.deepEqual(
    [...S.P0_ENABLED_GENERATORS],
    [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  );
}
assert.deepEqual([...S.PARAMETER_KEYS], constList(PARAMS, 'PARAMETER_KEYS'));
// Группы «Запуска» покрывают ключи ровно по одному разу.
{
  const grouped = Object.values(S.PARAMETER_GROUPS).flat();
  assert.equal(new Set(grouped).size, grouped.length, 'ключ в двух группах');
  assert.deepEqual([...grouped].sort(), [...S.PARAMETER_KEYS].sort());
}
// Блокеры согласования и «чего не хватает» брифа — из контракта P-B1.
{
  const m = CONTENT.match(
    /export interface ApprovalBlocker \{\s*code:([\s\S]*?);/
  );
  assert.ok(m);
  assert.deepEqual(
    [...S.APPROVAL_BLOCKER_CODES],
    [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  );
  const b = CONTENT.match(/export type BriefMissing =([\s\S]*?);/);
  assert.ok(b);
  assert.deepEqual(
    [...S.BRIEF_MISSING],
    [...b![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  );
}

// ═══ 2. Коды ошибок и матрица ролей ══════════════════════════════════════
{
  const block = ERRORS.slice(
    ERRORS.indexOf('export const PUB_ERROR_STATUS = {'),
    ERRORS.indexOf(
      '} as const;',
      ERRORS.indexOf('export const PUB_ERROR_STATUS')
    )
  );
  const codes = [...block.matchAll(/^\s+(PUB_[A-Z_]+):/gm)].map((x) => x[1]);
  assert.deepEqual([...PUB_ERROR_CODES].sort(), codes.sort());
}
{
  const ab: Record<string, string> = {
    PO: 'product_owner',
    ED: 'editor',
    OP: 'operator',
    AN: 'analyst',
    SA: 'sales',
    VW: 'viewer',
    AD: 'admin',
  };
  const block = ROLES.slice(
    ROLES.indexOf('export const PUB_PERMISSIONS = {'),
    ROLES.indexOf('} as const satisfies')
  );
  const server: Record<string, string[]> = {};
  for (const m of block.matchAll(/'([a-z_.]+)': \{ roles: (\[[^\]]*\]|ALL)/g)) {
    server[m[1]] =
      m[2] === 'ALL'
        ? [
            'product_owner',
            'editor',
            'operator',
            'analyst',
            'sales',
            'viewer',
            'admin',
          ]
        : [...m[2].matchAll(/[A-Z]{2}/g)].map((x) => ab[x[0]]);
  }
  const mine: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(PUB_PERMISSIONS)) mine[k] = [...v.roles];
  assert.deepEqual(mine, server, 'матрица §4.2 расходится с core/roles.ts');
  assert.ok(
    /'restore.apply': \{ roles: \[\], accountOwnerOnly: true \}/.test(block)
  );
}

// ═══ 3. Фикстуры ≡ ключи контрактов, декодеры их принимают ════════════════
const CASES: Array<[string, string, (v: unknown) => unknown]> = [
  ['ProductView', COMMON, core.decodeProduct],
  ['ParameterView', COMMON, core.decodeParameter],
  ['ParameterDecisionView', COMMON, core.decodeDecision],
  ['ParameterProposalView', CORE, core.decodeProposal],
  ['AuditEventView', CORE, core.decodeAudit],
  ['ReviewTaskView', CORE, core.decodeReviewTask],
  ['RoleGrantView', CORE, core.decodeGrant],
  ['SourceView', CONTENT, content.decodeSource],
  ['QuestionView', CONTENT, content.decodeQuestion],
  ['QuestionGroupView', CONTENT, content.decodeGroup],
  ['BrandFactView', CONTENT, content.decodeFact],
  ['OfferVersionView', CONTENT, content.decodeOffer],
  ['ContextPreview', CONTENT, content.decodeContextPreview],
  ['BriefView', CONTENT, content.decodeBrief],
  ['ContentView', CONTENT, content.decodeContent],
  ['VersionView', CONTENT, content.decodeVersion],
  ['VersionDiff', CONTENT, content.decodeDiff],
  ['ClaimView', CONTENT, content.decodeClaim],
  ['QaCheckView', CONTENT, content.decodeQaCheck],
  ['ApprovalView', CONTENT, content.decodeApproval],
  ['AiCallView', AIT, ai.decodeCall],
  ['AiStartResponse', AI, ai.decodeStart],
  ['AiCallListItem', AI, ai.decodeCallItem],
  ['AiTaskView', AI, ai.decodeTask],
  ['AiConfigView', AI, ai.decodeConfig],
  ['AiBindingView', AI, ai.decodeBinding],
  ['EvalRunSummary', AI, ai.decodeEvalRun],
  ['EvalResultView', AI, ai.decodeEvalResult],
  ['ChannelView', DIST, cal.decodeChannel],
  ['DistributionActionView', DIST, cal.decodeAction],
  ['PublicationView', DIST, cal.decodePublication],
];
for (const [name, file, decode] of CASES) {
  const fx = FX[name];
  assert.ok(fx, `нет фикстуры ${name}`);
  assert.deepEqual(
    Object.keys(fx).sort(),
    interfaceKeys(file, name).sort(),
    `фикстура ${name} ≠ контракт`
  );
  const out = decode(fx) as Record<string, unknown>;
  const allowed = new Set(interfaceKeys(file, name));
  for (const k of Object.keys(out)) {
    assert.ok(allowed.has(k), `${name}: декодер придумал ключ ${k}`);
  }
}
// Гейты: все пять, зелёный только без пунктов — проверяет view-тест.
assert.deepEqual(
  Object.keys(core.decodeGates(FX.GateResults)).sort(),
  [...S.GATE_NAMES].sort()
);

// Неизвестное значение закрытого списка — ошибка разбора, не «как-нибудь».
assert.throws(() =>
  content.decodeContent({ ...FX.ContentView, status: 'teleported' })
);
try {
  content.decodeSource({ ...FX.SourceView, usage: 'maybe' });
  assert.ok(false, 'должно бросить');
} catch (e) {
  assert.ok(e instanceof PubDecodeError);
  assert.equal((e as ApiError).code, 'PUB_RESPONSE_INVALID');
}
// Частотность null — null (не 0); оценка вне 0..2 — ошибка.
assert.equal(content.decodeQuestion(FX.QuestionView).frequency, null);
assert.equal(content.decodeQuestion(FX.QuestionView).scores.cost?.score, null);
assert.throws(() =>
  content.decodeQuestion({
    ...FX.QuestionView,
    scores: { cost: { score: 3, why: null } },
  })
);
// Стоимость AI null — null; «0» строкой — 0, а не «неизвестно».
assert.equal(ai.decodeCall(FX.AiCallView).costMicroUsd, null);
assert.equal(ai.decodeCallItem(FX.AiCallListItem).costMicroUsd, '1234');
assert.throws(() => ai.decodeCall({ ...FX.AiCallView, costMicroUsd: 12 }));
// Computable: not_computable с исходными числами.
{
  const c = computable(
    {
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: { leads: 0, spend: '1000' },
    },
    (x) => Number(x)
  );
  assert.equal(c.kind, 'not_computable');
  assert.throws(() =>
    computable({ kind: 'not_computable', reason: 'nope', inputs: {} }, Number)
  );
  assert.throws(() =>
    computable({ kind: 'value' }, (x) => {
      if (typeof x !== 'number') throw new Error('x');
      return x;
    })
  );
}
// Выход генераторов (§12.2).
assert.equal(ai.decodeBriefDraft(FX.AiCallView.output).cta.text, 'CTA');
assert.throws(() =>
  ai.decodeBriefDraft({ ...(FX.AiCallView.output as object), format: 'essay' })
);
// Последнее решение по флагу.
assert.equal(
  ai.latestFlagResolutions(ai.decodeEvalResult(FX.EvalResultView)).get('fl1')
    ?.resolution,
  'dismissed'
);

// ═══ 4. Пути, методы и тела клиента ≡ *_ROUTES сервера ═══════════════════
function routes(file: string): Set<string> {
  const out = new Set<string>();
  const prefix = (/const (?:C|P) = '([^']+)'/.exec(file) ?? [])[1] ?? '';
  for (const m of file.matchAll(
    /method: '([A-Z]+)',\s*path: (`[^`]+`|'[^']+')/g
  )) {
    const p = m[2]
      .slice(1, -1)
      .replace(/\$\{(?:C|P)\}/, prefix)
      .replace(/\$\{PUBLIC\}/, '/public/publisher/v1');
    out.add(`${m[1]} ${p.replace(/:[A-Za-z]+/g, ':x')}`);
  }
  return out;
}
const SERVER = new Set([
  ...routes(CORE),
  ...routes(CONTENT),
  ...routes(AI),
  ...routes(DIST),
]);

const calls: Array<{ method: string; path: string; body: unknown }> = [];
const fake: ApiClient = {
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const key = path.split('?')[0];
    // Ответ под форму: список, объект или старт AI.
    if (/\/ai\/calls\/[^/]+$/.test(key)) return FX.AiCallView as T;
    if (method === 'GET') return { items: [], nextBefore: null } as T;
    return {} as T;
  },
};
const raw: RawGet = async () => ({
  status: 200,
  contentType: 'text/csv; charset=utf-8',
  disposition: 'attachment; filename="publisher-sources.csv"',
  text: 'id,title\r\n1,a\r\n',
});
const http = createPublisherHttp(fake, raw);
const norm = (method: string, path: string) =>
  `${method} /${path.split('?')[0]}`
    .replace(/\/(products|sites)\/[^/]+/, '/$1/:x')
    .replace(
      /\/(sources|questions|question-groups|brand-facts|offers|briefs|contents|versions|claims|approvals|ai\/calls|ai\/tasks|ai\/configs|ai\/bindings|ai\/eval-runs|results|flags|parameters|proposals|roles|review-tasks|distribution\/actions|publications|channels|diff)\/(?!import-url|draft|cluster|extract|decisions|ai-review|qa-checks)[^/]+/g,
      '/$1/:x'
    );

const pid = 'prod1';
const C = content.createContentApi(http, pid);
const A = ai.createAiApi(http, http, pid);
const K = core.createCoreApi(http);
const L = cal.createCalendarApi(http, pid);
const tolerate = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch {
    /* формы ответа заглушки — не предмет этой проверки */
  }
};
await Promise.all(
  [
    K.siteProduct('site1'),
    K.createProduct('site1', { name: 'n', kind: 'working' }),
    K.product(pid),
    K.rename(pid, { name: 'n', expectedRevision: 1 }),
    K.changeMode(pid, { mode: 'test', expectedRevision: 1 }),
    K.parameters(pid),
    K.decisions(pid, { key: 'niche' }),
    K.propose(pid, 'niche', { text: 'x' }),
    K.withdraw(pid, 'niche', 'prop1'),
    K.proposals(pid, 'niche', { status: 'open', limit: 5 }),
    K.decide(pid, 'niche', {
      toStatus: 'approved',
      basis: 'b',
      expectedRevision: 1,
    }),
    K.gates(pid),
    K.roles(pid),
    K.grant(pid, { memberId: 'm2', role: 'editor' }),
    K.revoke(pid, 'g1', 'r'),
    K.audit(pid, { objectType: 'content' }),
    K.reviewTasks(pid, { status: 'open' }),
    K.resolveTask(pid, 'rt1', {
      status: 'resolved',
      resolution: 'ok',
      expectedRevision: 1,
    }),
    K.assignTask(pid, 'rt1', { assigneeMemberId: 'm1', expectedRevision: 1 }),
    K.resetRateLimit(pid),
    C.sources({ usage: 'allowed' }),
    C.source('src1'),
    C.createSource({
      kind: 'manual_text',
      title: 't',
      fragment: 'f',
      visibility: 'public',
      usage: 'allowed',
    }),
    C.importUrl({ url: 'https://e.com', visibility: 'public' }),
    C.patchSource('src1', { usage: 'allowed', expectedRevision: 1 }),
    C.revokeSource('src1', 'r'),
    C.questions(),
    C.createQuestion({ text: 't' }),
    C.patchQuestion('q1', { expectedRevision: 1 }),
    C.groups(),
    C.createGroup({
      key: 'k',
      task: 't',
      stage: 'decision',
      rationale: 'r',
      questionIds: ['q1'],
    }),
    C.patchGroup('grp1', { expectedRevision: 1 }),
    C.facts(),
    C.createFact({ factKey: 'k', kind: 'fact', value: 'v' }),
    C.factDecision('f1', 'activate', {}),
    C.factDecision('f1', 'resolve', { keepId: 'f1', reason: 'r' }),
    C.factDecision('f1', 'retire', { reason: 'r' }),
    C.offers(),
    C.createOffer({ title: 't', text: 'x' }),
    C.activateOffer('o1', 'b'),
    C.contextPreview({ purpose: 'helper' }),
    C.briefs(),
    C.brief('b1'),
    C.createBrief({ questionId: 'q1', goal: 'g', format: 'instruction' }),
    C.patchBrief('b1', { expectedRevision: 1 }),
    C.briefReady('b1', 1),
    C.contents(),
    C.content('c1'),
    C.createContent({ kind: 'article' }),
    C.patchContent('c1', { expectedRevision: 1 }),
    C.transition('c1', { to: 'approved', expectedRevision: 1 }),
    C.versions('c1'),
    C.version('c1', 'v1'),
    C.diff('c1', 'v1', 'v2'),
    C.createVersion('c1', { title: 't', body: 'b', offerVersionId: 'ov1' }),
    C.patchVersion('c1', 'v1', { expectedRevision: 1 }),
    C.submitVersion('c1', 'v1', 1),
    C.claims({ versionId: 'v1' }),
    C.createClaim({ statement: 's', type: 'fact', risk: 'normal' }),
    C.patchClaim('cl1', { expectedRevision: 1 }),
    C.claimSource('cl1', { sourceId: 'src1', supports: 'yes' }),
    C.verifyClaim('cl1', { status: 'supported', expectedRevision: 1 }),
    C.qaChecks('v1'),
    C.qaCheck('v1', { kind: 'editorial', result: 'pass' }),
    C.approve('v1', { versionHash: 'h' }),
    C.approvals({ objectId: 'v1' }),
    C.revokeApproval('ap1', 'r'),
    A.helperAnswer({ question: 'q' }),
    A.briefDraft({ questionId: 'q1' }),
    A.qaReview('v1'),
    A.adaptationDraft('c1', { format: 'post' }),
    A.questionsCluster(['q1', 'q2']),
    A.draftWrite('c1'),
    A.claimsExtract('v1'),
    A.call('call1'),
    A.calls({ generator: 'pub.helper.answer' }),
    A.task('t1'),
    A.extra('t1', 'r'),
    A.accept('t1', 'call1'),
    A.configs(),
    A.configDecision('cfg1', { evalStatus: 'failed', basis: 'b' }),
    A.evalRuns(),
    A.evalRun('run1'),
    A.resolveFlag('run1', 'res1', 'fl1', {
      resolution: 'dismissed',
      explanation: 'e',
    }),
    A.reviewResult('run1', 'res1', {
      criticalPass: true,
      usefulnessPass: true,
      explanation: 'e',
    }),
    A.bindings(),
    A.bind('cfg1', 'b'),
    A.unbind('bind1', 'r'),
    L.channels(),
    L.actions({ status: 'planned' }),
    L.createAction({
      versionId: 'v1',
      channelId: 'ch1',
      format: 'post',
      goal: 'g',
      plannedAt: '2026-10-14T09:00:00.000Z',
      ownerMemberId: 'm1',
    }),
    L.actionTransition('da1', { to: 'done', expectedRevision: 1 }),
    L.aiPlan('c1'),
    L.publications({ versionId: 'v1' }),
    L.createPublication({ versionId: 'v1', channelId: 'ch1' }),
    L.verifyPublication('pub1', { result: 'ok', expectedRevision: 1 }),
    L.createChannel({
      code: 'tg',
      title: 't',
      kind: 'own',
      utmSource: 'telegram',
      utmMedium: 'social',
      adsAllowed: null,
    }),
    L.patchChannel('ch1', { expectedRevision: 1, status: 'unavailable' }),
    L.publicationTransition('pub1', {
      expectedRevision: 1,
      to: 'withdrawn',
      reason: 'r',
    }),
  ].map(tolerate)
);
assert.ok(calls.length >= 95, `вызовов ${calls.length}`);
for (const c of calls) {
  assert.ok(c.path.startsWith('publisher/'), c.path);
  const key = norm(c.method, c.path);
  assert.ok(SERVER.has(key), `маршрута нет у сервера: ${key} (${c.path})`);
  if (c.method === 'GET') {
    assert.equal(c.body, undefined, `GET с телом: ${c.path}`);
  } else {
    const b = c.body as Record<string, unknown>;
    assert.ok(b && OP_KEY_RE.test(String(b.opKey)), `нет opKey: ${c.path}`);
  }
}
// Тело каждой мутации = `*Body` маршрута контракта (лишних ключей нет,
// обязательные есть) — расхождения вида `approverDisplayName` (P-G аудит
// A8) или неполного тела ловятся здесь, а не на сервере.
{
  const defs = [CORE, CONTENT, AI, DIST]
    .flatMap(routesOf)
    // Литеральный сегмент важнее параметра (`sources/import-url`).
    .sort((a, b) => a.path.split(':').length - b.path.split(':').length);
  let checked = 0;
  for (const c of calls) {
    if (c.method === 'GET') continue;
    const path = `/${c.path.split('?')[0]}`;
    const def = defs.find((d) => d.method === c.method && d.re.test(path));
    assert.ok(def, `нет маршрута ${c.method} ${path}`);
    const { opKey: _op, ...body } = c.body as Record<string, unknown>;
    void _op;
    const issues = bodyIssues(body, bodyKeys(def!.body));
    assert.deepEqual(issues, [], `${def!.name} (${def!.body}): ${issues}`);
    checked++;
  }
  assert.ok(checked >= 55, `проверено тел ${checked}`);
  // Сама сверка не слепа: старое тело согласования (A8) — расхождение.
  const ap = bodyKeys('ApproveBody');
  assert.deepEqual(bodyIssues({ versionHash: 'h' }, ap), []);
  assert.deepEqual(
    bodyIssues({ versionHash: 'h', approverDisplayName: 'x' }, ap),
    ['лишний ключ approverDisplayName']
  );
  assert.deepEqual(bodyIssues({}, ap), ['нет ключа versionHash']);
  assert.deepEqual(content.approveBody('h', ''), { versionHash: 'h' });
  assert.deepEqual(content.approveBody('h', ' ok '), {
    versionHash: 'h',
    reason: 'ok',
  });
  console.log(`publisher-api: тел = *Body: ${checked}`);
}
// Повтор той же попытки — тот же opKey; новая попытка — новый.
{
  calls.length = 0;
  await C.revokeSource(
    'src1',
    'r',
    '11111111-2222-4333-8444-555555555555'
  ).catch(() => undefined);
  await C.revokeSource(
    'src1',
    'r',
    '11111111-2222-4333-8444-555555555555'
  ).catch(() => undefined);
  assert.equal(
    (calls[0].body as { opKey: string }).opKey,
    (calls[1].body as { opKey: string }).opKey
  );
  const a = newOpKey();
  const b = newOpKey();
  assert.ok(OP_KEY_RE.test(a) && OP_KEY_RE.test(b) && a !== b);
}
assert.equal(
  queryString({ a: 1, b: '', c: null, d: undefined, e: 'x y' }),
  '?a=1&e=x%20y'
);
// Сегмент пути проверяется (инъекция пути невозможна).
await assert.rejects(C.source('../../etc'));

// ═══ 5. CSV: файл, файл в конверте, ошибка-конверт ═════════════════════════
{
  const h1 = createPublisherHttp(fake, raw);
  const f1 = await h1.csv('products/p/sources', { usage: 'allowed' });
  assert.equal(f1.filename, 'publisher-sources.csv');
  assert.ok(f1.text.startsWith('id,title'));
  let asked = '';
  const enveloped: RawGet = async (p) => {
    asked = p;
    return {
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      disposition: '',
      text: JSON.stringify({
        success: true,
        data: 'callId,status\r\n',
        meta: {},
      }),
    };
  };
  const f2 = await createPublisherHttp(fake, enveloped).csv(
    'products/p/ai/calls'
  );
  assert.equal(f2.text, 'callId,status\r\n');
  assert.ok(asked.endsWith('?format=csv'), asked);
  const denied: RawGet = async () => ({
    status: 403,
    contentType: 'application/json',
    disposition: '',
    text: JSON.stringify({
      success: false,
      error: {
        code: 'PUB_ROLE_REQUIRED',
        message: 'no',
        details: { action: 'audit.read' },
      },
      meta: {},
    }),
  });
  try {
    await createPublisherHttp(fake, denied).csv('products/p/audit');
    assert.ok(false);
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal((e as ApiError).code, 'PUB_ROLE_REQUIRED');
  }
  const html: RawGet = async () => ({
    status: 200,
    contentType: 'text/html',
    disposition: '',
    text: '<html>',
  });
  await assert.rejects(createPublisherHttp(fake, html).csv('products/p/x'));
}

// ═══ 6. Опрос AI-вызова до финального статуса ══════════════════════════════
{
  let n = 0;
  const seq = ['running', 'running', 'ok'] as const;
  const last = await ai.pollCall(
    {
      call: async () => ({
        ...ai.decodeCall(FX.AiCallView),
        status: seq[Math.min(n++, seq.length - 1)],
      }),
    },
    'call1',
    { sleep: async () => undefined, intervalMs: 10 }
  );
  assert.equal(last.status, 'ok');
  assert.equal(n, 3);
  // Не дольше maxMs: остаётся running — экран честно скажет «ещё идёт».
  let m = 0;
  const stuck = await ai.pollCall(
    {
      call: async () => {
        m++;
        return { ...ai.decodeCall(FX.AiCallView), status: 'running' as const };
      },
    },
    'call1',
    { sleep: async () => undefined, intervalMs: 1000, maxMs: 3000 }
  );
  assert.equal(stuck.status, 'running');
  assert.equal(m, 4);
}

console.log('publisher-api: ok');
