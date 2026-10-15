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
import * as S from '../src/lib/publisher/reddit-studio-api';
import {
  bodyIssuesOf,
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
    [...R.REDDIT_LISTS, ...S.REDDIT_STUDIO_LISTS]
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

// Формы M2 из общих фикстур (контент, AI, публикации — g1.json).
const G1 = JSON.parse(
  readFileSync(new URL('./fixtures/publisher/g1.json', import.meta.url), 'utf8')
) as Record<string, Record<string, unknown>>;
const PUBLICATION = {
  ...G1.PublicationView,
  reportKind: 'user_reported',
  contentId: 'c1',
  communityId: 'rc1',
  subreddit: 'saas',
};
const MATERIAL = {
  content: { ...G1.ContentView, kind: 'reddit_comment', redditBriefId: 'rb1' },
  briefId: 'rb1',
  contentType: 'comment',
  communityId: 'rc1',
  subreddit: 'saas',
  canonicalUrl: 'https://www.reddit.com/r/saas/',
  threadUrl: 'https://www.reddit.com/r/saas/comments/abc123/how_to_reuse/',
  openUrl: 'https://www.reddit.com/r/saas/comments/abc123/how_to_reuse/',
  rules: (FX.RedditCommunityView as { rules: unknown }).rules,
  currentVersion: G1.VersionView,
  approvedVersion: null,
  approval: null,
  policyCheck: {
    ...G1.QaCheckView,
    kind: 'reddit_policy',
    warnings: [{ code: 'reddit_links_restricted', text: 'w' }],
  },
  copies: { count: 1, lastAt: '2026-10-14T09:00:00.000Z' },
  publications: [PUBLICATION],
  lastGeneration: {
    callId: 'call1',
    status: 'ok',
    requestedAt: '2026-10-14T08:30:00.000Z',
  },
};
const GENERATE = {
  callId: 'call1',
  status: 'ok',
  call: {
    ...G1.AiCallView,
    generator: 'pub.reddit.draft',
    output: FX.RedditDraftOutput,
  },
};
// ═══ 2b. M2: списки, фикстуры и декодеры студии ════════════════════════
{
  const CHECKS = readFileSync(
    new URL(
      '../../sites-backend/src/modules/publisher/reddit/checks.ts',
      import.meta.url
    ),
    'utf8'
  );
  same(S.REDDIT_CONTENT_TYPES, STATES, 'REDDIT_CONTENT_TYPES');
  same(S.REDDIT_AFFILIATIONS, STATES, 'REDDIT_AFFILIATIONS');
  same(S.REDDIT_BRIEF_STATUSES, STATES, 'REDDIT_BRIEF_STATUSES');
  same(S.REDDIT_DRAFT_TEMPLATES, RAPI, 'REDDIT_DRAFT_TEMPLATES');
  same(S.REDDIT_CHECK_BLOCKERS, CHECKS, 'REDDIT_CHECK_BLOCKERS');
  same(S.REDDIT_CHECK_WARNINGS, CHECKS, 'REDDIT_CHECK_WARNINGS');
  // Чего не хватает брифу — `RedditBriefMissing` (шаблон тезиса — отдельно).
  const miss = /export type RedditBriefMissing =([^;]+);/.exec(RAPI);
  assert.deepEqual(
    [...miss![1].matchAll(/\| '([a-z_]+)'/g)].map((x) => x[1]).sort(),
    [...S.REDDIT_BRIEF_MISSING].sort()
  );
  assert.ok(/`key_points\[\$\{number\}\]`/.test(miss![1]));
  // Находки генератора.
  const GEN = readFileSync(
    new URL(
      '../../sites-backend/src/modules/publisher/ai/generators/reddit-draft.generator.ts',
      import.meta.url
    ),
    'utf8'
  );
  for (const f of S.REDDIT_AI_FINDINGS)
    assert.ok(GEN.includes(`'${f}'`), `находка ${f} у генератора`);
  // Причины недоступности AI — как в `RedditBriefView.ai`.
  assert.ok(
    /reason: 'flag_off' \| 'generator_disabled' \| null/.test(RAPI),
    'ai.reason'
  );

  const M2_CASES: Array<[string, (v: unknown) => object, unknown]> = [
    ['RedditBriefView', S.decodeRedditBrief, FX.RedditBriefView],
    ['RedditCopyView', S.decodeCopy, FX.RedditCopyView],
    ['RedditMaterialView', S.decodeMaterial, MATERIAL],
    ['RedditPublicationView', S.decodeRedditPublication, PUBLICATION],
    ['RedditGenerateResponse', S.decodeGenerate, GENERATE],
  ];
  for (const [name, decode, fx] of M2_CASES) {
    const keys = interfaceKeys(RAPI, name);
    const own = Object.keys(fx as object);
    // RedditPublicationView расширяет PublicationView (общий P-C).
    if (name !== 'RedditPublicationView')
      assert.deepEqual(own.sort(), [...keys].sort(), `фикстура ${name}`);
    else for (const key of keys) assert.ok(own.includes(key), key);
    const out = decode(fx) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(out).sort(),
      own.sort(),
      `${name}: ключи декодера`
    );
  }
  const b = S.decodeRedditBrief(FX.RedditBriefView);
  assert.equal(b.keyPoints[1].sourceIds, 'needs_verification');
  assert.deepEqual(b.ai, { available: false, reason: 'generator_disabled' });
  const fb = FX.RedditBriefView;
  throwsDecode(
    () => S.decodeRedditBrief({ ...fb, missing: ['vibes'] }),
    'missing'
  );
  assert.deepEqual(
    S.decodeRedditBrief({ ...fb, missing: ['brief_ready', 'key_points[1]'] })
      .missing,
    ['brief_ready', 'key_points[1]']
  );
  throwsDecode(
    () => S.decodeRedditBrief({ ...fb, affiliation: 'friend' }),
    'affiliation'
  );
  throwsDecode(
    () => S.decodeRedditBrief({ ...fb, ai: { available: true, reason: 'x' } }),
    'ai.reason'
  );
  throwsDecode(
    () =>
      S.decodeRedditBrief({
        ...fb,
        keyPoints: [{ text: 't', sourceIds: 'maybe' }],
      }),
    'sourceIds тезиса'
  );
  assert.equal(
    S.decodeRedditBrief({ ...fb, affiliation: null }).affiliation,
    null
  );
  // Варианты: 2..3, строго.
  const out = S.decodeDraftOutput(FX.RedditDraftOutput);
  assert.equal(out.length, 3);
  const vs = (FX.RedditDraftOutput as { variants: unknown[] }).variants;
  throwsDecode(
    () => S.decodeDraftOutput({ variants: vs.slice(0, 1) }),
    '1 вариант'
  );
  throwsDecode(
    () => S.decodeDraftOutput({ variants: [...vs, vs[0]] }),
    '4 варианта'
  );
  throwsDecode(
    () =>
      S.decodeDraftOutput({
        variants: [{ ...(vs[0] as object), body: 5 }, vs[1]],
      }),
    'body числом'
  );
  throwsDecode(() => S.decodeRedditBrief({ ...fb, brand: 5 }), 'brand числом');
  assert.equal(S.decodeRedditBrief({ ...fb, brand: null }).brand, null);
  assert.deepEqual(S.decodeRedditBrief({ ...fb, missing: ['brand'] }).missing, [
    'brand',
  ]);
  throwsDecode(
    () =>
      S.decodeMaterial({
        ...MATERIAL,
        lastGeneration: {
          callId: 'c',
          status: 'maybe',
          requestedAt: '2026-10-14T08:30:00.000Z',
        },
      }),
    'lastGeneration.status'
  );
  throwsDecode(() => {
    const x: Record<string, unknown> = { ...MATERIAL };
    delete x.lastGeneration;
    S.decodeMaterial(x);
  }, 'нет lastGeneration');
  assert.equal(
    S.decodeMaterial({ ...MATERIAL, lastGeneration: null }).lastGeneration,
    null
  );
  // P-R-ADM v1.3: активное согласование утверждённой версии (id отзыва).
  const APPROVAL = {
    id: 'ap1',
    versionId: 'v1',
    status: 'active',
    selfReview: true,
    decidedAt: '2026-10-14T09:10:00.000Z',
  };
  assert.deepEqual(
    S.decodeMaterial({ ...MATERIAL, approval: APPROVAL }).approval,
    APPROVAL
  );
  assert.equal(S.decodeMaterial(MATERIAL).approval, null);
  throwsDecode(() => {
    const x: Record<string, unknown> = { ...MATERIAL };
    delete x.approval;
    S.decodeMaterial(x);
  }, 'нет approval');
  throwsDecode(
    () =>
      S.decodeMaterial({
        ...MATERIAL,
        approval: { ...APPROVAL, status: 'revoked' },
      }),
    'approval.status'
  );
  throwsDecode(
    () =>
      S.decodeMaterial({ ...MATERIAL, approval: { ...APPROVAL, id: '../x' } }),
    'approval.id'
  );
  throwsDecode(
    () =>
      S.decodeMaterial({
        ...MATERIAL,
        approval: { ...APPROVAL, selfReview: 'yes' },
      }),
    'approval.selfReview'
  );
  const mat = S.decodeMaterial(MATERIAL);
  assert.equal(mat.policyCheck?.warnings[0].code, 'reddit_links_restricted');
  assert.equal(mat.publications[0].reportKind, 'user_reported');
  throwsDecode(
    () => S.decodeMaterial({ ...MATERIAL, contentType: 'thread' }),
    'contentType'
  );
  throwsDecode(
    () =>
      S.decodeMaterial({ ...MATERIAL, copies: { count: null, lastAt: null } }),
    'copies.count null'
  );
  throwsDecode(
    () =>
      S.decodeRedditPublication({ ...PUBLICATION, reportKind: 'confirmed' }),
    'reportKind'
  );
  throwsDecode(
    () => S.decodeCopy({ ...FX.RedditCopyView, copyToken: null }),
    'copyToken'
  );
  // Точный текст копирования не трогается декодером (пробелы, переводы строк).
  const raw = '  **x**\n\n<b>y</b>  ';
  assert.equal(S.decodeCopy({ ...FX.RedditCopyView, body: raw }).body, raw);
  assert.equal(S.decodeGenerate({ ...GENERATE, call: null }).call, null);
}

// ═══ 3. Каждый маршрут REDDIT_ROUTES — свой вызов клиента ═════════════════
const ROUTES = routesOf(RAPI);
const ROUTES_CONTENT = routesOf(contractSrc('content-api.ts'));
assert.equal(ROUTES.length, 40, `маршрутов P-R ${ROUTES.length}`);
// M2 — ровно `REDDIT_M2_ROUTE_NAMES` (14); их вызывает клиент студии.
const M2_NAMES = (() => {
  const m = /REDDIT_M2_ROUTE_NAMES[^=]*=\s*\[([\s\S]*?)\];/.exec(RAPI);
  assert.ok(m, 'нет REDDIT_M2_ROUTE_NAMES');
  return [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
})();
assert.equal(M2_NAMES.length, 14);
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
    if (/\/briefs$/.test(p)) return listOf(FX.RedditBriefView);
    if (/\/briefs\/[^/]+\/contents$/.test(p)) return { items: [MATERIAL] };
    if (/\/briefs\/[^/]+$/.test(p)) return FX.RedditBriefView;
    if (/\/reddit\/contents\/[^/]+$/.test(p)) return MATERIAL;
    if (/\/reddit\/publications$/.test(p)) return listOf(PUBLICATION);
  }
  if (/\/briefs\/[^/]+\/generate$/.test(p)) return GENERATE;
  if (/\/briefs\/[^/]+\/contents$/.test(p)) return MATERIAL;
  if (/\/briefs/.test(p)) return FX.RedditBriefView;
  if (/\/check$/.test(p)) return G1.QaCheckView;
  if (/\/copy$/.test(p)) return FX.RedditCopyView;
  if (/\/report-publication$/.test(p)) return PUBLICATION;
  if (/\/contents\/[^/]+\/versions/.test(p)) return G1.VersionView;
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
  api.restoreProject('rp1', k(), 2),
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
assert.equal(outs.length, 26);
const studio = S.createRedditStudioApi(http, 'prod1');
const vcalls: typeof calls = [];
const outs2 = await Promise.all([
  studio.briefs({ status: 'ready', contentType: 'comment', q: '  crm ' }),
  studio.brief('rb1'),
  studio.createBrief(k(), {
    projectId: 'rp1',
    contentType: 'comment',
    opportunityId: 'ro1',
    objective: 'o',
    context: 'c',
    keyPoints: [{ text: 't', sourceIds: 'needs_verification' }],
    affiliation: 'founder',
    linksAllowed: false,
  }),
  studio.patchBrief('rb1', k(), { expectedRevision: 3, affiliation: null }),
  studio.briefReady('rb1', k(), 3),
  studio.archiveBrief('rb1', k(), 3),
  studio.generate('rb1', k(), {
    template: 'helpful_answer',
    variants: 3,
    rewrite: { versionId: 'v1', paragraph: 1 },
  }),
  studio.briefContents('rb1'),
  studio.createContent('rb1', k(), {}),
  studio.material('c1'),
  studio.check('c1', k()),
  studio.copy('c1', k(), { acknowledgedWarnings: ['reddit_duplicate'] }),
  studio.reportPublication('c1', k(), {
    url: 'https://www.reddit.com/r/saas/comments/abc123/x/comment/def456',
    postedAt: '2026-10-14T09:30:00.000Z',
  }),
  studio.publications({ stage: 'test', status: 'published' }),
]);
assert.equal(outs2.length, 14);
// Версии Reddit-материала — общие маршруты контента (ветвь Reddit, §3.1).
{
  const before = calls.length;
  await studio.createVersion('c1', k(), {
    body: 'b',
    meta: { disclosure: '', claimMap: [] },
    aiCallId: 'call1',
    variantIndex: 2,
  });
  await studio.patchVersion('c1', 'v1', k(), {
    expectedRevision: 1,
    title: 't',
    meta: { flairSuggestion: null },
  });
  vcalls.push(...calls.splice(before));
}
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
  const issues = bodyIssuesOf(body, def.body);
  assert.deepEqual(issues, [], `${def.name} (${def.body}): ${issues}`);
}
assert.deepEqual(
  [...covered].sort(),
  ROUTES.map((r) => r.name).sort(),
  'не все маршруты P-R вызываются клиентом'
);
for (const n of M2_NAMES) assert.ok(covered.has(n), `M2 ${n} не вызван`);
// Версии Reddit-ветви: общий путь контента, тела — РОВНО
// `CreateRedditVersionBody`/`PatchRedditVersionBody` (контракт §9.9), без
// производных ключей; у comment нет `title`; `meta` — `RedditVersionClientMeta`.
{
  const DERIVED = ['offerVersionId', 'sourceIds', 'parentVersionId'];
  assert.equal(vcalls.length, 2);
  const [cv, pv] = vcalls;
  assert.equal(cv.method, 'POST');
  assert.equal(cv.path, 'publisher/products/prod1/contents/c1/versions');
  assert.equal(pv.method, 'PATCH');
  assert.equal(pv.path, 'publisher/products/prod1/contents/c1/versions/v1');
  const metaKeys = [...bodyKeys('RedditVersionClientMeta').keys()];
  for (const [c, name] of [
    [cv, 'CreateRedditVersionBody'],
    [pv, 'PatchRedditVersionBody'],
  ] as const) {
    const { opKey, ...b } = c.body as Record<string, unknown>;
    assert.ok(OP_KEY_RE.test(String(opKey)));
    const issues = bodyIssuesOf(b, name);
    assert.deepEqual(issues, [], `${name}: ${issues}`);
    for (const key of Object.keys(b))
      assert.ok(!DERIVED.includes(key), `производный ключ ${key}`);
    // Общий маршрут типизирован объединением — Reddit-тело в нём есть.
    const def = ROUTES_CONTENT.find(
      (d) => d.method === c.method && d.re.test(`/${c.path}`)
    );
    assert.ok(def && def.body.includes(name), `${c.method}: ${def?.body}`);
    const metaIn = (b.meta ?? {}) as Record<string, unknown>;
    for (const mk of Object.keys(metaIn))
      assert.ok(
        metaKeys.includes(mk),
        `meta.${mk} вне RedditVersionClientMeta`
      );
    for (const mk of Object.keys(metaIn))
      assert.ok(
        (S.REDDIT_VERSION_META_KEYS as readonly string[]).includes(mk),
        `meta.${mk} ставит сервер`
      );
  }
  assert.ok(!('title' in (cv.body as object)), 'comment без title');
  // `REDDIT_VERSION_META_KEYS` — как у сервера.
  assert.deepEqual(
    [...S.REDDIT_VERSION_META_KEYS],
    constList(
      readFileSync(
        new URL(
          '../../sites-backend/src/modules/publisher/content/rules.ts',
          import.meta.url
        ),
        'utf8'
      ),
      'REDDIT_VERSION_META_KEYS'
    )
  );
}
// Фильтры M2: брифы и публикации, q обрезан.
{
  const b = calls.find((c) => /reddit\/briefs\?/.test(c.path));
  assert.equal(b!.path.split('?')[1], 'status=ready&contentType=comment&q=crm');
  const pb = calls.find((c) => /reddit\/publications\?/.test(c.path));
  assert.equal(pb!.path.split('?')[1], 'stage=test&status=published');
  const g = calls.find((c) => c.path.endsWith('/generate'));
  assert.deepEqual((g!.body as { rewrite: unknown }).rewrite, {
    versionId: 'v1',
    paragraph: 1,
  });
  const cp = calls.find((c) => c.path.endsWith('/copy'));
  assert.deepEqual((cp!.body as Record<string, unknown>).acknowledgedWarnings, [
    'reddit_duplicate',
  ]);
  for (const tail of ['/check'])
    assert.deepEqual(
      Object.keys(calls.find((c) => c.path.endsWith(tail))!.body as object),
      ['opKey'],
      `${tail}: только opKey`
    );
}
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
  `publisher-reddit-api: ok (${ROUTES.length} маршрутов, ${CASES.length} + 5 форм)`
);
