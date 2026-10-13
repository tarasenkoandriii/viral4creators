/**
 * AI Publisher (P-R, Reddit Manual MVP, M1) — клиент `lib/publisher/
 * reddit-api.ts` против контракта бэкенда (`contracts/reddit-api.ts`,
 * `contracts/states.ts`; исходники читаются текстом):
 *  1. закрытые списки — как у сервера;
 *  2. фикстуры ≡ ключи интерфейсов контракта, декодеры не придумывают
 *     ключей; строгость: чужая форма → `PUB_RESPONSE_INVALID`, `null`
 *     фактора остаётся `null` (не 0);
 *  3. КАЖДЫЙ из `REDDIT_ROUTES` вызывается клиентом ровно своим методом и
 *     путём; GET — без тела, мутации — с `opKey`; тело = `*Body`;
 *  4. фильтры списков, CSV-путь, сегмент пути (инъекция невозможна),
 *     повтор попытки — тот же `opKey`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, type ApiClient } from '../src/kit';
import {
  OP_KEY_RE,
  createPublisherHttp,
  type RawGet,
} from '../src/lib/publisher/common-api';
import { PubDecodeError } from '../src/lib/publisher/decode';
import * as R from '../src/lib/publisher/reddit-api';
import {
  bodyIssues,
  bodyKeys,
  contractSrc,
  routesOf,
} from './publisher-contract-lib';

const STATES = contractSrc('states.ts');
const RAPI = contractSrc('reddit-api.ts');
const FX = JSON.parse(
  readFileSync(
    new URL('./fixtures/publisher/reddit.json', import.meta.url),
    'utf8'
  )
) as Record<string, Record<string, unknown>>;

function constList(file: string, name: string): string[] {
  const m = file.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`)
  );
  assert.ok(m, `нет ${name}`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Ключи верхнего уровня `export interface Name {…}`. */
function interfaceKeys(file: string, name: string): string[] {
  const start = file.search(new RegExp(`export interface ${name}\\b[^{]*\\{`));
  assert.ok(start >= 0, `нет интерфейса ${name}`);
  let depth = 0;
  const keys: string[] = [];
  let line = '';
  for (let i = file.indexOf('{', start); i < file.length; i++) {
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

const throwsDecode = (fn: () => unknown, msg: string) => {
  try {
    fn();
    assert.ok(false, `должно бросить: ${msg}`);
  } catch (e) {
    assert.ok(e instanceof PubDecodeError, `${msg}: ${String(e)}`);
    assert.equal((e as ApiError).code, 'PUB_RESPONSE_INVALID');
  }
};

// ═══ 1. Закрытые списки ═════════════════════════════════════════════════
const same = (mine: readonly string[], file: string, name: string) =>
  assert.deepEqual([...mine], constList(file, name), name);
same(R.REDDIT_PROJECT_STATUSES, STATES, 'REDDIT_PROJECT_STATUSES');
same(R.REDDIT_COMMUNITY_STATUSES, STATES, 'REDDIT_COMMUNITY_STATUSES');
same(R.REDDIT_PROMOTION_POLICIES, STATES, 'REDDIT_PROMOTION_POLICIES');
same(R.REDDIT_LINKS_POLICIES, STATES, 'REDDIT_LINKS_POLICIES');
same(R.REDDIT_REVIEW_STATES, STATES, 'REDDIT_REVIEW_STATES');
same(R.REDDIT_SNAPSHOT_STATUSES, STATES, 'REDDIT_SNAPSHOT_STATUSES');
same(R.REDDIT_INTENTS, STATES, 'REDDIT_INTENTS');
same(R.REDDIT_KEYWORD_STATUSES, STATES, 'REDDIT_KEYWORD_STATUSES');
same(R.REDDIT_POLICY_VERDICTS, STATES, 'REDDIT_POLICY_VERDICTS');
same(R.REDDIT_OPPORTUNITY_STATUSES, STATES, 'REDDIT_OPPORTUNITY_STATUSES');
same(R.REDDIT_SCORE_FACTORS, STATES, 'REDDIT_SCORE_FACTORS');
same(R.REDDIT_POLICY_REASONS, RAPI, 'REDDIT_POLICY_REASONS');
same(R.REDDIT_POLICY_WARNINGS, RAPI, 'REDDIT_POLICY_WARNINGS');
same(R.SOURCE_USAGES_R, STATES, 'SOURCE_USAGES');
// Коды `policy_risk.reasons` — как строит `reddit/policy.ts` из политик снимка.
{
  const POLICY = readFileSync(
    new URL(
      '../../sites-backend/src/modules/publisher/reddit/policy.ts',
      import.meta.url
    ),
    'utf8'
  );
  assert.ok(/`promotion_\$\{snapshot\.promotionPolicy\}`/.test(POLICY));
  assert.ok(/`links_\$\{snapshot\.linksPolicy\}`/.test(POLICY));
  assert.ok(/\['rules_missing'\]/.test(POLICY));
  assert.deepEqual(
    [...R.REDDIT_POLICY_RISK_REASONS],
    [
      'rules_missing',
      ...constList(STATES, 'REDDIT_PROMOTION_POLICIES').map(
        (x) => `promotion_${x}`
      ),
      ...constList(STATES, 'REDDIT_LINKS_POLICIES').map((x) => `links_${x}`),
    ]
  );
}
assert.deepEqual(
  [...R.REDDIT_SNAPSHOT_STATES],
  [
    ...(/export type RedditSnapshotState =([^;]+);/.exec(RAPI) ?? [
      '',
      '',
    ])[1].matchAll(/'([^']+)'/g),
  ].map((x) => x[1])
);
assert.deepEqual(
  [...R.REDDIT_OPERATOR_FACTORS],
  R.REDDIT_SCORE_FACTORS.filter((f) => f !== 'policy_risk')
);
// Списки CSV — как `REDDIT_CSV_COLUMNS`.
{
  const m = /export const REDDIT_CSV_COLUMNS = \{([\s\S]*?)\} as const/.exec(
    RAPI
  );
  assert.ok(m);
  assert.deepEqual(
    [...m![1].matchAll(/^\s{2}(\w+):/gm)].map((x) => x[1]),
    [...R.REDDIT_LISTS]
  );
}
// Причины 409 переходов — все, что бросают сервисы P-R.
{
  const back = (f: string) =>
    readFileSync(
      new URL(
        `../../sites-backend/src/modules/publisher/reddit/${f}`,
        import.meta.url
      ),
      'utf8'
    );
  const thrown = new Set<string>();
  for (const f of [
    'projects.service.ts',
    'communities.service.ts',
    'opportunities.service.ts',
  ]) {
    const src = back(f);
    // `PUB_TRANSITION_INVALID {reason: …}` (в т. ч. тернарники) и
    // `invalid('…')` машины переходов возможности.
    for (const m of src.matchAll(
      /PUB_TRANSITION_INVALID',\s*\{\s*reason:([^}]*?)from:/g
    ))
      for (const x of m[1].matchAll(/'([a-z_]+)'/g))
        if (x[1] !== 'active' && x[1] !== 'current') thrown.add(x[1]);
    for (const m of src.matchAll(/invalid\('([a-z_]+)'/g)) thrown.add(m[1]);
  }
  for (const x of thrown)
    assert.ok(
      (R.REDDIT_TRANSITION_REASONS as readonly string[]).includes(x),
      `причина ${x} без текста`
    );
  for (const x of R.REDDIT_TRANSITION_REASONS)
    assert.ok(thrown.has(x), `причина ${x} не встречается у сервера`);
}

// ═══ 2. Фикстуры ≡ контракт, декодеры строгие ═════════════════════════════
const CASES: Array<[string, (v: unknown) => object]> = [
  ['RedditGateView', (v) => R.decodeGate(v)],
  ['RedditProjectView', R.decodeRedditProject],
  ['RedditRulesSummary', R.decodeRulesSummary],
  ['RedditCommunityView', R.decodeRedditCommunity],
  ['RedditRuleSnapshotView', R.decodeRuleSnapshot],
  ['RedditKeywordView', R.decodeRedditKeyword],
  ['RedditScoreView', R.decodeScore],
  ['RedditOpportunityView', R.decodeRedditOpportunity],
  ['RedditEvidenceView', R.decodeEvidence],
  ['RedditExcerptsView', R.decodeExcerpts],
  ['RedditRulesSourceView', R.decodeRulesSource],
];
for (const [name, decode] of CASES) {
  const fx = FX[name];
  assert.ok(fx, `нет фикстуры ${name}`);
  const keys = interfaceKeys(RAPI, name).sort();
  assert.deepEqual(Object.keys(fx).sort(), keys, `фикстура ${name} ≠ контракт`);
  const out = decode(fx) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out).sort(), keys, `${name}: ключи декодера`);
}
// Вложенные формы: source снимка и excerpt возможности.
{
  const block = (iface: string, key: string) => {
    const s = RAPI.slice(
      RAPI.search(new RegExp(`export interface ${iface}\\b`))
    );
    const i = s.indexOf(`${key}: {`);
    const body = s.slice(i, s.indexOf('}', i));
    return [...body.matchAll(/^\s+(\w+):/gm)].map((x) => x[1]).sort();
  };
  const snap = R.decodeRuleSnapshot(FX.RedditRuleSnapshotView);
  assert.deepEqual(
    Object.keys(snap.source).sort(),
    block('RedditRuleSnapshotView', 'source')
  );
  const op = R.decodeRedditOpportunity(FX.RedditOpportunityView);
  assert.deepEqual(
    Object.keys(op.excerpt!).sort(),
    block('RedditOpportunityView', 'excerpt')
  );
  // «Не оценено» — null, не 0; все 8 факторов на месте.
  assert.equal(op.factors.evidence_gap.value, null);
  assert.equal(op.score.risk, null);
  assert.deepEqual(Object.keys(op.factors), [...R.REDDIT_SCORE_FACTORS]);
  assert.equal(snap.flairRequired, null);
}
// Доказательства для отзыва (раунд 3): строгие формы, отозванные — с причиной.
{
  const ex = R.decodeExcerpts(FX.RedditExcerptsView);
  assert.equal(ex.items[0].usage, 'revoked');
  assert.equal(ex.items[0].revokeReason, 'автор попросив');
  assert.equal(ex.items[1].current, true);
  assert.equal(
    R.decodeRulesSource(FX.RedditRulesSourceView).status,
    'superseded'
  );
  throwsDecode(
    () =>
      R.decodeExcerpts({
        ...FX.RedditExcerptsView,
        items: [{ ...FX.RedditEvidenceView, usage: 'gone' }],
      }),
    'usage доказательства'
  );
  throwsDecode(
    () => R.decodeEvidence({ ...FX.RedditEvidenceView, revision: '2' }),
    'revision строкой'
  );
  throwsDecode(
    () => R.decodeRulesSource({ ...FX.RedditRulesSourceView, source: null }),
    'нет source'
  );
}
const fxo = FX.RedditOpportunityView;
throwsDecode(
  () => R.decodeRedditOpportunity({ ...fxo, status: 'teleported' }),
  'статус'
);
throwsDecode(
  () => R.decodeRedditOpportunity({ ...fxo, policy: 'maybe' }),
  'политика'
);
throwsDecode(
  () =>
    R.decodeRedditOpportunity({
      ...fxo,
      factors: {
        ...(fxo.factors as object),
        topic_fit: { value: 101, why: 'x' },
      },
    }),
  'фактор > 100'
);
throwsDecode(
  () =>
    R.decodeRedditOpportunity({
      ...fxo,
      factors: {
        ...(fxo.factors as object),
        topic_fit: { value: 50.5, why: 'x' },
      },
    }),
  'дробный фактор'
);
throwsDecode(() => {
  const f = { ...(fxo.factors as Record<string, unknown>) };
  delete f.answerability;
  R.decodeRedditOpportunity({ ...fxo, factors: f });
}, 'нет фактора');
throwsDecode(
  () =>
    R.decodeRedditOpportunity({
      ...fxo,
      factors: { ...(fxo.factors as object), size: { value: 1, why: 'x' } },
    }),
  'лишний фактор'
);
throwsDecode(
  () => R.decodeRedditOpportunity({ ...fxo, policyReasons: ['vibes'] }),
  'причина гейта'
);
throwsDecode(() => {
  const x = { ...fxo };
  delete x.policyNow;
  R.decodeRedditOpportunity(x);
}, 'нет policyNow');
throwsDecode(
  () => R.decodeRedditOpportunity({ ...fxo, policyNowReasons: ['vibes'] }),
  'причина гейта сейчас'
);
const withRisk = (pr: unknown, extra: Record<string, unknown> = {}) => ({
  ...fxo,
  factors: { ...(fxo.factors as object), policy_risk: pr, ...extra },
});
throwsDecode(
  () =>
    R.decodeRedditOpportunity(
      withRisk({ value: 50, why: 'Правила v2: просування …', reasons: [] })
    ),
  'текст в policy_risk.why'
);
throwsDecode(
  () =>
    R.decodeRedditOpportunity(
      withRisk({ value: 50, why: null, reasons: ['links_maybe'] })
    ),
  'незнакомый код policy_risk'
);
throwsDecode(
  () => R.decodeRedditOpportunity(withRisk({ value: 50, why: null })),
  'нет reasons у policy_risk'
);
throwsDecode(
  () =>
    R.decodeRedditOpportunity(
      withRisk((fxo.factors as Record<string, unknown>).policy_risk, {
        topic_fit: { value: 1, why: 'x', reasons: ['rules_missing'] },
      })
    ),
  'reasons у фактора оператора'
);
{
  const op = R.decodeRedditOpportunity(fxo);
  assert.equal(op.policyNow, 'recheck_required');
  assert.deepEqual(op.policyNowReasons, ['rules_changed']);
  assert.deepEqual(op.factors.policy_risk.reasons, [
    'promotion_allowed_with_conditions',
    'links_restricted',
  ]);
  assert.equal(op.factors.topic_fit.reasons, undefined);
  assert.deepEqual(
    R.decodeRedditCommunity(FX.RedditCommunityView).rules?.gate.reasons,
    ['rules_source_revoked']
  );
}
throwsDecode(
  () => R.decodeRedditOpportunity({ ...fxo, excerpt: undefined }),
  'excerpt отсутствует (а не null)'
);
throwsDecode(
  () =>
    R.decodeRedditOpportunity({
      ...fxo,
      score: { ...(fxo.score as object), scoreVersion: 'v2' },
    }),
  'версия score'
);
throwsDecode(
  () =>
    R.decodeRedditCommunity({ ...FX.RedditCommunityView, rules: undefined }),
  'rules отсутствует'
);
throwsDecode(
  () =>
    R.decodeRuleSnapshot({
      ...FX.RedditRuleSnapshotView,
      state: 'fresh',
    }),
  'state снимка'
);
throwsDecode(
  () =>
    R.decodeRuleSnapshot({
      ...FX.RedditRuleSnapshotView,
      gate: { verdict: 'ok', reasons: [], warnings: ['emoji'] },
    }),
  'warning гейта'
);
assert.equal(
  R.decodeRedditOpportunity({ ...fxo, excerpt: null }).excerpt,
  null
);
assert.equal(
  R.decodeRedditCommunity({ ...FX.RedditCommunityView, rules: null }).rules,
  null
);

// ═══ 3. Каждый маршрут REDDIT_ROUTES — свой вызов клиента ═════════════════
const ROUTES = routesOf(RAPI);
assert.equal(ROUTES.length, 25, `маршрутов P-R ${ROUTES.length}`);
for (const r of ROUTES) {
  assert.ok(
    r.path.startsWith('/publisher/products/:pid/reddit/'),
    `${r.name}: ${r.path}`
  );
}
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const respond = (method: string, path: string): unknown => {
  const p = path.split('?')[0];
  const listOf = (x: unknown) => ({ items: [x], nextBefore: null });
  if (method === 'GET') {
    if (/\/projects$/.test(p)) return listOf(FX.RedditProjectView);
    if (/\/projects\/[^/]+$/.test(p)) return FX.RedditProjectView;
    if (/\/communities$/.test(p)) return listOf(FX.RedditCommunityView);
    if (/\/communities\/[^/]+$/.test(p)) return FX.RedditCommunityView;
    if (/\/rules$/.test(p)) return listOf(FX.RedditRuleSnapshotView);
    if (/\/rules\/[^/]+\/source$/.test(p)) return FX.RedditRulesSourceView;
    if (/\/excerpts$/.test(p)) return FX.RedditExcerptsView;
    if (/\/opportunities$/.test(p)) return listOf(FX.RedditOpportunityView);
    if (/\/opportunities\/[^/]+$/.test(p)) return FX.RedditOpportunityView;
    if (/\/keywords$/.test(p)) return listOf(FX.RedditKeywordView);
  }
  if (/\/projects/.test(p)) return FX.RedditProjectView;
  if (/\/rules/.test(p)) return FX.RedditRuleSnapshotView;
  if (/\/communities/.test(p)) return FX.RedditCommunityView;
  if (/\/opportunities/.test(p)) return FX.RedditOpportunityView;
  if (/\/keywords/.test(p)) return FX.RedditKeywordView;
  throw new Error(`нет ответа ${method} ${p}`);
};
const fake: ApiClient = {
  request: async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return respond(method, path) as T;
  },
};
let csvAsked = '';
const raw: RawGet = async (p) => {
  csvAsked = p;
  return {
    status: 200,
    contentType: 'text/csv; charset=utf-8',
    disposition: 'attachment; filename="publisher-reddit-opportunities.csv"',
    text: 'id,projectId\r\n',
  };
};
const http = createPublisherHttp(fake, raw);
const api = R.createRedditApi(http, 'prod1');
const k = () => '11111111-2222-4333-8444-555555555555';
const outs = await Promise.all([
  api.projects({ status: 'active', q: '  saas  ', limit: 500 }),
  api.project('rp1'),
  api.createProject(k(), { title: 't', locale: 'uk', market: 'UA' }),
  api.patchProject('rp1', k(), { expectedRevision: 1, title: 't2' }),
  api.archiveProject('rp1', k(), 1),
  api.communities({ projectId: 'rp1' }),
  api.community('rc1'),
  api.createCommunity(k(), { projectId: 'rp1', community: 'r/SaaS' }),
  api.patchCommunity('rc1', k(), { expectedRevision: 3, status: 'archived' }),
  api.rules('rc1'),
  api.createRules('rc1', k(), {
    sourceUrl: 'https://www.reddit.com/r/saas/about/rules',
    sourceExcerpt: 'x',
    promotionPolicy: 'unknown',
    linksPolicy: 'unknown',
    flairRequired: null,
    checkedAt: '2026-10-13T07:00:00.000Z',
  }),
  api.reviewRules('rs3', k()),
  api.rulesSource('rc1', 'rs2'),
  api.excerpts('ro1'),
  api.opportunities({
    projectId: 'rp1',
    communityId: 'rc1',
    status: 'qualified',
    policyNow: 'block',
  }),
  api.opportunity('ro1'),
  api.createOpportunity(k(), {
    projectId: 'rp1',
    communityId: 'rc1',
    threadUrl: 'https://old.reddit.com/r/saas/comments/abc123/x/',
    titleManual: 't',
    intent: 'how_to',
    factors: { topic_fit: { value: 50, why: 'w' } },
  }),
  api.patchOpportunity('ro1', k(), {
    expectedRevision: 2,
    excerpt: null,
    factors: { evidence_gap: { value: null, why: null } },
  }),
  api.scoreOpportunity('ro1', k(), 2),
  api.transitionOpportunity('ro1', 'qualify', k(), { expectedRevision: 2 }),
  api.transitionOpportunity('ro1', 'skip', k(), {
    expectedRevision: 2,
    reason: '  не наша тема ',
  }),
  api.transitionOpportunity('ro1', 'archive', k(), {
    expectedRevision: 2,
    reason: '   ',
  }),
  api.keywords({ projectId: 'rp1' }),
  api.createKeyword(k(), {
    projectId: 'rp1',
    phrase: 'crm',
    intent: 'comparison',
    priority: 3,
  }),
  api.patchKeyword('rk1', k(), { expectedRevision: 1, status: 'archived' }),
]);
assert.equal(outs.length, 25);
const covered = new Set<string>();
for (const c of calls) {
  assert.ok(c.path.startsWith('publisher/products/prod1/reddit/'), c.path);
  const path = `/${c.path.split('?')[0]}`;
  const def = ROUTES.filter(
    (d) => d.method === c.method && d.re.test(path)
  ).sort((a, b) => a.path.split(':').length - b.path.split(':').length)[0];
  assert.ok(def, `маршрута нет у сервера: ${c.method} ${path}`);
  covered.add(def.name);
  if (c.method === 'GET') {
    assert.equal(c.body, undefined, `GET с телом: ${c.path}`);
    assert.ok(!/opKey/.test(c.path), `opKey в query: ${c.path}`);
    continue;
  }
  const { opKey, ...body } = c.body as Record<string, unknown>;
  assert.ok(OP_KEY_RE.test(String(opKey)), `нет opKey: ${c.path}`);
  const issues = bodyIssues(body, bodyKeys(def.body));
  assert.deepEqual(issues, [], `${def.name} (${def.body}): ${issues}`);
}
assert.deepEqual(
  [...covered].sort(),
  ROUTES.map((r) => r.name).sort(),
  'не все маршруты P-R вызываются клиентом'
);
// Фильтры: limit 1..100, q обрезан, пустое не уходит.
{
  const list = calls.find((c) => /\/projects\?/.test(c.path));
  assert.ok(list);
  assert.equal(list!.path.split('?')[1], 'limit=100&status=active&q=saas');
  assert.deepEqual(R.listQuery({ status: '', q: '   ', limit: 0 }), {
    limit: 1,
  });
  const ops = calls.find((c) => /\/opportunities\?/.test(c.path));
  assert.ok(
    /projectId=rp1/.test(ops!.path) && /communityId=rc1/.test(ops!.path)
  );
  assert.ok(/status=qualified&.*policyNow=block/.test(ops!.path), ops!.path);
  assert.deepEqual(R.listQuery({ policyNow: '' }), {});
  const pe = calls.find(
    (c) => c.method === 'PATCH' && /opportunities\/ro1$/.test(c.path)
  );
  assert.equal((pe!.body as { excerpt: unknown }).excerpt, null, 'отвязка');
  // Причина перехода: пробелы обрезаны, пустая — без ключа.
  const skip = calls.find((c) => c.path.endsWith('/skip'));
  assert.equal((skip!.body as { reason: string }).reason, 'не наша тема');
  const arch = calls.find((c) => c.path.endsWith('opportunities/ro1/archive'));
  assert.ok(!('reason' in (arch!.body as object)));
  // Review — только opKey (ReviewRedditRulesBody = MutationBody).
  const rev = calls.find((c) => c.path.endsWith('/review'));
  assert.deepEqual(Object.keys(rev!.body as object), ['opKey']);
}
// Сегмент пути проверяется (инъекция пути невозможна).
await assert.rejects(api.project('../../etc'));
await assert.rejects(api.rules('a/b'));
await assert.rejects(
  api.transitionOpportunity('ro1', 'x/../../y' as R.RedditTransition, k(), {
    expectedRevision: 1,
  })
);
// Повтор той же попытки — тот же opKey (сервер вернёт прежний результат).
{
  calls.length = 0;
  const key = '11111111-2222-4333-8444-666666666666';
  await api.scoreOpportunity('ro1', key, 2);
  await api.scoreOpportunity('ro1', key, 2);
  assert.equal(
    (calls[0].body as { opKey: string }).opKey,
    (calls[1].body as { opKey: string }).opKey
  );
}
// CSV: тот же путь списка + `format=csv`, фильтр тот же.
{
  const f = await http.csv(R.redditListPath('prod1', 'opportunities'), {
    status: 'new',
    projectId: 'rp1',
  });
  assert.equal(f.filename, 'publisher-reddit-opportunities.csv');
  assert.ok(
    csvAsked.startsWith(
      'publisher/products/prod1/reddit/opportunities?status=new&projectId=rp1&format=csv'
    ),
    csvAsked
  );
}
// Ошибка сервера доходит как ApiError (не «пустой список»).
{
  const failing = R.createRedditApi(
    createPublisherHttp(
      {
        request: async () => {
          throw new ApiError('PUB_NOT_FOUND', 'nf', 404);
        },
      },
      raw
    ),
    'prod1'
  );
  const e = await failing.projects().then(
    () => null,
    (x: unknown) => x
  );
  assert.ok(e instanceof ApiError && e.code === 'PUB_NOT_FOUND', String(e));
}

console.log(
  `publisher-reddit-api: ok (${ROUTES.length} маршрутов, ${CASES.length} форм)`
);
