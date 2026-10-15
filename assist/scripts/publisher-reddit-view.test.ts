/**
 * AI Publisher (P-R, Reddit Manual MVP, M1) — чистый слой экранов
 * `lib/publisher/reddit-view.ts` и части раздела без браузера:
 *  1. нормализация `r/name` и URL треда ≡ серверной (`reddit/normalize.ts`)
 *     на общем наборе входов;
 *  2. ссылки: только сохранённый `https://www.reddit.com/r/…` (A3);
 *  3. факторы: пусто = «не оценено» (null, не 0), `why` при значении,
 *     `policy_risk` не уходит; правка — только изменённые;
 *  4. переходы возможности — машина сервера (Р-RD-23);
 *  5. тела форм (лишнего нет, обязательное есть) и проверки ввода;
 *  6. тона: зелёный только у «можно/подтверждён/подходит»;
 *  7. ошибки P-R словами (409 `policy_block` с причинами, дубль — id);
 *  8. selfReview — подсказка по `createdBy`;
 *  9. словари uk/ru/en: паритет, плейсхолдеры, подписи всех значений;
 * 10. рендер (react-dom/server): цитата с HTML — текстом, ссылка
 *     «Открыть на Reddit» — `rel="noopener noreferrer" target="_blank"`,
 *     `javascript:` — не ссылка.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../src/kit';
import { pubUk } from '../src/i18n/publisher-uk';
import { pubRedditEn } from '../src/i18n/publisher-reddit-en';
import { pubRedditRu } from '../src/i18n/publisher-reddit-ru';
import { pubRedditUk } from '../src/i18n/publisher-reddit-uk';
import { canDo, selfReviewOf } from '../src/lib/publisher/permissions';
import * as R from '../src/lib/publisher/reddit-api';
import * as V from '../src/lib/publisher/reddit-view';
import * as SN from '../../sites-backend/src/modules/publisher/reddit/normalize';
import {
  PublisherContext,
  type PublisherValue,
} from '../src/screens/publisher/publisher-context';
import {
  GateReasons,
  PlainQuote,
  RedditErrorAlert,
  ConflictPanel,
  RedditLink,
  RevokeEvidence,
  SourceLink,
} from '../src/screens/publisher/reddit/reddit-parts';

// ═══ 1. Нормализация ≡ сервер ═══════════════════════════════════════════
const COMMUNITY_INPUTS = [
  'r/SaaS',
  '/r/saas/',
  'saas',
  'SaaS',
  'r/a',
  'r/' + 'x'.repeat(22),
  'r/saas/top',
  'https://www.reddit.com/r/SaaS/',
  'https://old.reddit.com/r/saas/comments/abc/x',
  'www.reddit.com/r/saas',
  'reddit.com/r/saas',
  'http://www.reddit.com/r/saas',
  'https://evil.com/r/saas',
  'https://www.reddit.com.evil.com/r/saas',
  'https://evilreddit.com/r/saas',
  'https://foo.reddit.com/r/saas',
  'r/u_spez',
  'u_spez',
  '/R/U_Spez/',
  'https://www.reddit.com/r/u_spez/',
  'r/u_',
  'https://user:pw@www.reddit.com/r/saas',
  'https://www.reddit.com:8443/r/saas',
  'javascript:alert(1)',
  'https://www.reddit.com/user/someone',
  'r/sa-as',
  'r/саас',
  '',
  '   ',
  'r/saas ',
  ' r/micro_saas ',
  'u/someone',
];
for (const x of COMMUNITY_INPUTS) {
  assert.equal(V.normalizeSubreddit(x), SN.normalizeSubreddit(x), `«${x}»`);
  assert.equal(V.subredditIssue(x), SN.subredditIssue(x), `код «${x}»`);
}
assert.equal(V.subredditIssue('r/u_spez'), 'profile_ref');
assert.equal(V.normalizeSubreddit('r/u_spez'), null);
assert.equal(V.normalizeSubreddit('r/SaaS'), 'saas');
assert.equal(V.normalizeSubreddit('https://evil.com/r/saas'), null);
assert.equal(V.normalizeSubreddit('https://evilreddit.com/r/saas'), null);
const THREAD_INPUTS = [
  'https://www.reddit.com/r/SaaS/comments/Abc123/Which_CRM/',
  'https://old.reddit.com/r/saas/comments/abc123/which_crm/?utm=1#c',
  'https://m.reddit.com/r/saas/comments/abc123',
  'https://np.reddit.com/r/saas/comments/abc123/x/comment/def',
  'www.reddit.com/r/saas/comments/abc123/x',
  'http://www.reddit.com/r/saas/comments/abc123/x',
  'https://redd.it/abc123',
  'https://www.reddit.com/r/saas/s/AbCdEf',
  'https://www.reddit.com/r/saas/',
  'https://www.reddit.com/user/x/comments/abc123',
  'https://www.reddit.com/r/saas/comments/abc-123/x',
  'https://www.reddit.com/r/saas/comments/' + 'a'.repeat(14),
  'https://evil.com/r/saas/comments/abc123',
  'https://evilreddit.com/r/saas/comments/abc123',
  'https://i.reddit.com/r/saas/comments/abc123',
  'https://old.reddit.com/r/u_spez/comments/abc12/x',
  'https://www.reddit.com/r/U_Spez/comments/abc12',
  'javascript:alert(1)//www.reddit.com/r/saas/comments/abc123',
  '',
];
for (const x of THREAD_INPUTS) {
  assert.deepEqual(V.normalizeThreadUrl(x), SN.normalizeThreadUrl(x), `«${x}»`);
  assert.equal(V.threadUrlIssue(x), SN.threadUrlIssue(x), `код «${x}»`);
}
assert.equal(
  V.threadUrlIssue('https://old.reddit.com/r/u_spez/comments/abc12/x'),
  'profile_ref'
);
assert.equal(
  V.normalizeThreadUrl(THREAD_INPUTS[1])?.url,
  'https://www.reddit.com/r/saas/comments/abc123/which_crm'
);

// ═══ 2. Ссылки ═══════════════════════════════════════════════════════════
assert.equal(
  V.redditHref('https://www.reddit.com/r/saas/comments/abc123/x'),
  'https://www.reddit.com/r/saas/comments/abc123/x'
);
assert.equal(
  V.redditHref('https://www.reddit.com/r/saas'),
  'https://www.reddit.com/r/saas'
);
for (const bad of [
  'javascript:alert(1)',
  'http://www.reddit.com/r/saas',
  'https://old.reddit.com/r/saas',
  'https://evil.com/r/saas',
  'https://www.reddit.com/user/x',
  'https://a:b@www.reddit.com/r/saas',
  'data:text/html,x',
  '',
  null,
  undefined,
])
  assert.equal(V.redditHref(bad), null, String(bad));
assert.equal(
  V.httpsHref('https://wiki.example/rules'),
  'https://wiki.example/rules'
);
for (const bad of ['http://x.example', 'javascript:1', 'x', '', null])
  assert.equal(V.httpsHref(bad), null, String(bad));

// ═══ 3. Факторы ═══════════════════════════════════════════════════════════
{
  const f = V.factorForm(null);
  assert.deepEqual(Object.keys(f), [...R.REDDIT_OPERATOR_FACTORS]);
  assert.ok(!('policy_risk' in f));
  assert.deepEqual(V.factorsBody(f), { body: {}, issues: [] });
  f.topic_fit = { value: '80', why: ' тема ' };
  f.intent_fit = { value: '', why: '' };
  assert.deepEqual(V.factorsBody(f).body, {
    topic_fit: { value: 80, why: 'тема' },
  });
  assert.equal(V.parseFactorValue(''), null, 'пусто — null, не 0');
  assert.equal(V.parseFactorValue('0'), 0);
  for (const bad of ['101', '-1', '5.5', 'x', '1e2'])
    assert.equal(V.parseFactorValue(bad), undefined, bad);
  f.audience_fit = { value: '50', why: '' };
  assert.deepEqual(V.factorsBody(f).issues, [
    { factor: 'audience_fit', code: 'why' },
  ]);
  f.audience_fit = { value: '150', why: 'x' };
  assert.equal(V.factorsBody(f).issues[0].code, 'value');
  f.audience_fit = { value: '1', why: 'я'.repeat(301) };
  assert.equal(V.factorsBody(f).issues[0].code, 'whyLength');
  // Правка: только изменённые; очистка — явный null.
  const op = R.decodeRedditOpportunity({
    ...BASE_OPP(),
  });
  const ef = V.factorForm(op.factors);
  assert.equal(ef.evidence_gap.value, '', 'null показывается пустым');
  assert.deepEqual(V.factorsBody(ef, V.factorForm(op.factors)), {
    body: {},
    issues: [],
  });
  ef.topic_fit = { value: '', why: '' };
  ef.evidence_gap = { value: '40', why: 'нужны цифры' };
  assert.deepEqual(V.factorsBody(ef, V.factorForm(op.factors)).body, {
    topic_fit: { value: null, why: null },
    evidence_gap: { value: 40, why: 'нужны цифры' },
  });
}
function BASE_OPP(): Record<string, unknown> {
  const factors = Object.fromEntries(
    R.REDDIT_SCORE_FACTORS.map((k) => [
      k,
      k === 'evidence_gap'
        ? { value: null, why: null }
        : k === 'policy_risk'
          ? { value: 100, why: null, reasons: ['rules_missing'] }
          : { value: 50, why: `w ${k}` },
    ])
  );
  return {
    id: 'ro1',
    projectId: 'rp1',
    communityId: 'rc1',
    subreddit: 'saas',
    threadUrl: 'https://www.reddit.com/r/saas/comments/abc123/x',
    threadKey: 'abc123',
    titleManual: 'T',
    excerpt: null,
    intent: 'how_to',
    angle: null,
    keywordIds: [],
    factors,
    score: {
      scoreVersion: 'v1',
      relevance: 50,
      risk: null,
      priority: null,
      missing: ['evidence_gap'],
    },
    ruleSnapshotId: null,
    ruleSnapshotVersion: null,
    policy: 'ok',
    policyReasons: [],
    policyNow: 'ok',
    policyNowReasons: [],
    status: 'new',
    revision: 4,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  };
}

// ═══ 4. Переходы — машина сервера ═══════════════════════════════════════
// Решает гейт СЕЙЧАС (`policyNow`), а не хранимый «на момент оценки».
for (const status of R.REDDIT_OPPORTUNITY_STATUSES) {
  for (const policyNow of R.REDDIT_POLICY_VERDICTS) {
    const a = V.opportunityActions({ status, policyNow });
    const stale = status === 'qualified' && policyNow !== 'ok';
    assert.equal(a.stale, stale, `${status}/${policyNow} stale`);
    assert.equal(
      a.qualify,
      status === 'new' && policyNow === 'ok',
      `${status}/${policyNow}`
    );
    // «Устаревший» отбор не тупик: skip/archive доступны (UI-аудит S3-4).
    assert.equal(
      a.skip,
      ['new', 'qualified', 'recheck_required', 'blocked'].includes(status)
    );
    assert.equal(a.archive, status !== 'archived');
    assert.equal(a.edit, status !== 'archived');
    assert.equal(a.rescore, status !== 'archived', 'пересчёт доступен');
  }
}
assert.deepEqual(
  V.NEED_RESCORE.map((x) => `${x.status}/${x.policyNow}`),
  ['qualified/recheck_required', 'qualified/block']
);
// policy_risk: коды → слова (все 8, все языки), сырых кодов нет.
for (const d of [pubRedditUk, pubRedditRu, pubRedditEn]) {
  const txt = V.policyRiskText(R.REDDIT_POLICY_RISK_REASONS, d);
  assert.equal(txt.length, 8);
  for (const x of txt) assert.ok(!/[a-z]+_[a-z]+/.test(x), x);
  assert.equal(txt[0], d.gate.reasons.rules_missing);
  assert.ok(txt[2].includes(d.rules.promotion.prohibited), txt[2]);
  assert.ok(txt[5].includes(d.rules.links.restricted), txt[5]);
}
assert.deepEqual(V.policyRiskText(undefined, pubRedditUk), []);
// Выдержка: правка/отвязка; отозванная и архивная — не правятся.
{
  const ex = (usage: 'allowed' | 'restricted' | 'revoked') => ({
    sourceId: 's1',
    text: 'old',
    injectionFlag: null,
    usage,
  });
  assert.equal(V.excerptEditable({ status: 'new', excerpt: null }), true);
  assert.equal(
    V.excerptEditable({ status: 'new', excerpt: ex('restricted') }),
    true
  );
  assert.equal(
    V.excerptEditable({ status: 'qualified', excerpt: ex('revoked') }),
    false
  );
  assert.equal(
    V.excerptEditable({ status: 'archived', excerpt: ex('restricted') }),
    false
  );
  const o = { revision: 5, excerpt: ex('restricted') };
  assert.equal(V.excerptPatchBody(o, ' old '), null, 'без изменений');
  assert.deepEqual(V.excerptPatchBody(o, ' new text '), {
    expectedRevision: 5,
    excerpt: 'new text',
  });
  assert.deepEqual(V.excerptPatchBody(o, '   '), {
    expectedRevision: 5,
    excerpt: null,
  });
  assert.equal(V.excerptPatchBody({ revision: 5, excerpt: null }, ''), null);
  assert.equal(V.excerptPatchBody(o, 'я'.repeat(2001)), null);
}
assert.deepEqual(V.transitionBody({ revision: 3 }, '  '), {
  expectedRevision: 3,
});
assert.deepEqual(V.transitionBody({ revision: 3 }, ' дубль '), {
  expectedRevision: 3,
  reason: 'дубль',
});

// ═══ 5. Тела форм ════════════════════════════════════════════════════════
{
  assert.equal(V.projectBody({ title: ' ', locale: 'uk', market: 'UA' }), null);
  assert.equal(
    V.projectBody({ title: 'T', locale: 'ukr_UA', market: 'UA' }),
    null
  );
  assert.equal(V.projectBody({ title: 'T', locale: 'uk', market: '' }), null);
  assert.deepEqual(
    V.projectBody({ title: ' T ', locale: 'en-US', market: 'US' }),
    {
      title: 'T',
      locale: 'en-US',
      market: 'US',
    }
  );
  const p = R.decodeRedditProject({
    id: 'rp1',
    title: 'T',
    locale: 'uk',
    market: 'UA',
    status: 'active',
    revision: 5,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  });
  assert.equal(V.projectPatchBody(p, V.projectForm(p)), null, 'без изменений');
  assert.deepEqual(
    V.projectPatchBody(p, { ...V.projectForm(p), market: 'EU' }),
    {
      expectedRevision: 5,
      market: 'EU',
    }
  );
}
{
  const cf = V.communityForm(null);
  assert.equal(V.communityBody('rp1', { ...cf, community: 'r/a' }), null);
  assert.equal(V.communityBody('', { ...cf, community: 'r/saas' }), null);
  assert.deepEqual(
    V.communityBody('rp1', { ...cf, community: ' r/SaaS ', topics: 'a, ,b' }),
    { projectId: 'rp1', community: 'r/SaaS', topics: ['a', 'b'] }
  );
  assert.equal(
    V.communityBody('rp1', {
      ...cf,
      community: 'saas',
      topics: Array.from({ length: 21 }, (_, i) => `t${i}`).join(','),
    }),
    null
  );
  assert.equal(V.topicsOf('a,' + 'x'.repeat(65)), null);
  const c = R.decodeRedditCommunity({
    id: 'rc1',
    projectId: 'rp1',
    channelId: 'ch1',
    subreddit: 'saas',
    canonicalUrl: 'https://www.reddit.com/r/saas',
    descriptionManual: 'old',
    language: null,
    topics: ['a'],
    status: 'active',
    rules: null,
    staleDays: 30,
    revision: 2,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  });
  const f = V.communityForm(c);
  assert.equal(f.community, 'r/saas');
  assert.equal(V.communityPatchBody(c, f), null);
  assert.deepEqual(
    V.communityPatchBody(c, { ...f, descriptionManual: '', topics: 'a, b' }),
    { expectedRevision: 2, descriptionManual: null, topics: ['a', 'b'] }
  );
}
{
  const now = new Date('2026-10-13T12:00:00.000Z');
  const ok: V.RulesForm = {
    sourceUrl: 'https://www.reddit.com/r/saas/about/rules',
    sourceExcerpt: ' Self-promo only in weekly thread ',
    promotionPolicy: 'allowed_with_conditions',
    linksPolicy: 'restricted',
    flair: 'unknown',
    conditions: 'weekly thread\n\n10:1 ',
    checkedAt: '2026-10-13T10:00:00.000Z',
  };
  const b = V.rulesBody(ok, now);
  assert.deepEqual(b.issues, []);
  assert.deepEqual(b.body, {
    sourceUrl: 'https://www.reddit.com/r/saas/about/rules',
    sourceExcerpt: 'Self-promo only in weekly thread',
    promotionPolicy: 'allowed_with_conditions',
    linksPolicy: 'restricted',
    flairRequired: null,
    conditions: ['weekly thread', '10:1'],
    checkedAt: '2026-10-13T10:00:00.000Z',
  });
  assert.equal(
    V.rulesBody({ ...ok, flair: 'no' }, now).body?.flairRequired,
    false
  );
  assert.ok(
    V.rulesBody({ ...ok, sourceUrl: 'http://x.example' }, now).issues.includes(
      'url'
    )
  );
  assert.ok(
    V.rulesBody(
      { ...ok, checkedAt: '2026-10-14T10:00:00.000Z' },
      now
    ).issues.includes('future')
  );
  assert.ok(V.rulesBody({ ...ok, checkedAt: '' }, now).issues.includes('date'));
  assert.ok(
    V.rulesBody({ ...ok, linksPolicy: '' }, now).issues.includes('policy')
  );
  assert.ok(
    V.rulesBody({ ...ok, sourceExcerpt: ' ' }, now).issues.includes('excerpt')
  );
  assert.ok(
    V.rulesBody(
      { ...ok, conditions: Array(21).fill('c').join('\n') },
      now
    ).issues.includes('conditions')
  );
  assert.equal(V.flairOf(null), 'unknown');
  assert.equal(V.flairOf(true), 'yes');
}
{
  const community = { id: 'rc1', subreddit: 'saas' };
  const base: V.OpportunityForm = {
    ...V.emptyOpportunityForm('rc1'),
    threadUrl: 'https://old.reddit.com/r/SaaS/comments/abc123/x/',
    titleManual: ' Which CRM ',
    intent: 'recommendation',
  };
  const ok = V.opportunityBody('rp1', base, community);
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.body, {
    projectId: 'rp1',
    communityId: 'rc1',
    threadUrl: 'https://old.reddit.com/r/SaaS/comments/abc123/x/',
    titleManual: 'Which CRM',
    intent: 'recommendation',
  });
  // A15: сообщество в ссылке ≠ выбранному — не отправляется.
  const mm = V.opportunityBody(
    'rp1',
    { ...base, threadUrl: 'https://www.reddit.com/r/crm/comments/abc123' },
    community
  );
  assert.equal(mm.body, null);
  assert.ok(mm.issues.includes('mismatch'));
  assert.deepEqual(
    V.threadMismatch('https://www.reddit.com/r/crm/comments/abc123', community),
    { url: 'crm', picked: 'saas' }
  );
  assert.equal(V.threadMismatch(base.threadUrl, community), null);
  assert.ok(
    V.opportunityBody(
      'rp1',
      { ...base, threadUrl: 'https://redd.it/abc123' },
      community
    ).issues.includes('thread')
  );
  assert.ok(
    V.opportunityBody(
      'rp1',
      { ...base, communityId: 'other' },
      community
    ).issues.includes('community')
  );
  assert.ok(
    V.opportunityBody(
      'rp1',
      { ...base, intent: '' },
      community
    ).issues.includes('intent')
  );
  assert.ok(
    V.opportunityBody(
      'rp1',
      { ...base, excerpt: 'я'.repeat(2001) },
      community
    ).issues.includes('excerpt')
  );
  const withF = V.opportunityBody(
    'rp1',
    {
      ...base,
      excerpt: ' text ',
      factors: { ...base.factors, topic_fit: { value: '90', why: 'w' } },
      keywordIds: ['k1'],
    },
    community
  );
  assert.deepEqual(withF.body?.factors, { topic_fit: { value: 90, why: 'w' } });
  assert.equal(withF.body?.excerpt, 'text');
  const badF = V.opportunityBody(
    'rp1',
    {
      ...base,
      factors: { ...base.factors, topic_fit: { value: '90', why: '' } },
    },
    community
  );
  assert.equal(badF.body, null);
  assert.deepEqual(badF.factorIssues, [{ factor: 'topic_fit', code: 'why' }]);
  const op = R.decodeRedditOpportunity(BASE_OPP());
  assert.equal(
    V.opportunityPatchBody(op, {
      titleManual: 'T',
      intent: 'how_to',
      angle: '',
      keywordIds: [],
    }),
    null
  );
  assert.deepEqual(
    V.opportunityPatchBody(op, {
      titleManual: 'T2',
      intent: 'other',
      angle: 'a',
      keywordIds: ['k1'],
    }),
    {
      expectedRevision: 4,
      titleManual: 'T2',
      intent: 'other',
      angle: 'a',
      keywordIds: ['k1'],
    }
  );
}
{
  const kf = V.emptyKeywordForm();
  assert.equal(kf.priority, '3');
  assert.equal(
    V.keywordBody('rp1', { ...kf, phrase: 'crm' }),
    null,
    'нет intent'
  );
  assert.deepEqual(
    V.keywordBody('rp1', {
      ...kf,
      phrase: ' crm  tools ',
      intent: 'comparison',
    }),
    {
      projectId: 'rp1',
      phrase: 'crm  tools',
      intent: 'comparison',
      priority: 3,
    }
  );
  assert.equal(
    V.keywordBody('rp1', {
      ...kf,
      phrase: 'x',
      intent: 'other',
      priority: '6',
    }),
    null
  );
  const k = R.decodeRedditKeyword({
    id: 'rk1',
    projectId: 'rp1',
    phrase: 'crm',
    phraseNorm: 'crm',
    intent: 'comparison',
    locale: null,
    priority: 3,
    status: 'active',
    revision: 2,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  });
  const ef = {
    phrase: 'crm',
    intent: 'comparison' as const,
    locale: '',
    priority: '3',
  };
  assert.equal(V.keywordPatchBody(k, ef), null);
  assert.deepEqual(
    V.keywordPatchBody(k, { ...ef, priority: '5', locale: 'en' }),
    {
      expectedRevision: 2,
      locale: 'en',
      priority: 5,
    }
  );
}

// ═══ 5б. Правка «только изменённое» и перебазирование после 409 (S2-1) ═══
{
  // Сценарий аудитора: ED открыл форму (rev 9); PO через API поменял
  // topic_fit; ED поменял только answerability → 409 → перечитали → save.
  const o9 = R.decodeRedditOpportunity(BASE_OPP());
  const base = V.factorForm(o9.factors);
  const mine = { ...base, answerability: { value: '70', why: 'є кейси' } };
  const fresh = {
    ...base,
    topic_fit: { value: '92', why: 'PO: точно наша тема' },
  };
  // Первое сохранение до перечитывания: только своё поле.
  assert.deepEqual(Object.keys(V.factorsBody(mine, base).body), [
    'answerability',
  ]);
  const rb = V.rebaseForm(base, mine, fresh);
  assert.deepEqual(rb.conflicts, []);
  assert.deepEqual(
    rb.mine.topic_fit,
    fresh.topic_fit,
    'чужая правка подтянута'
  );
  assert.deepEqual(rb.mine.answerability, mine.answerability, 'своя осталась');
  const body = V.factorsBody(rb.mine, fresh).body;
  assert.deepEqual(body, {
    answerability: { value: 70, why: 'є кейси' },
  });
  assert.ok(!('topic_fit' in body), 'чужой фактор не затирается');
  // Конфликт по одному полю — явно, со значениями обеих сторон.
  const mine2 = { ...base, topic_fit: { value: '10', why: 'ED: не тема' } };
  const rb2 = V.rebaseForm(base, mine2, fresh);
  assert.deepEqual(rb2.conflicts, [
    { key: 'topic_fit', mine: mine2.topic_fit, theirs: fresh.topic_fit },
  ]);
  assert.deepEqual(rb2.mine.topic_fit, mine2.topic_fit, 'выбор — за человеком');
  // Совпали (оба поставили одно) — не конфликт.
  assert.deepEqual(V.rebaseForm(base, fresh, fresh).conflicts, []);
  // Заголовок/кут: PO меняет заголовок, ED — только кут.
  const eb = V.opportunityEditForm(o9);
  const eMine = { ...eb, angle: 'показати шаблон' };
  const o10 = { ...o9, titleManual: 'PO: новий заголовок', revision: 10 };
  const eFresh = V.opportunityEditForm(o10);
  const eRb = V.rebaseForm(eb, eMine, eFresh);
  assert.equal(eRb.mine.titleManual, 'PO: новий заголовок');
  assert.deepEqual(V.opportunityPatchBody(o10, eRb.mine, eFresh), {
    expectedRevision: 10,
    angle: 'показати шаблон',
  });
  // Без перебазирования старый заголовок бы ушёл — функция тела от base его не шлёт.
  assert.deepEqual(V.opportunityPatchBody(o10, eMine, eb), {
    expectedRevision: 10,
    angle: 'показати шаблон',
  });
  // Проект, сообщество, запрос — то же правило.
  const pBase = { title: 'T', locale: 'uk', market: 'UA' };
  assert.deepEqual(
    V.projectPatchBody(
      { revision: 3 },
      { title: 'T', locale: 'uk', market: 'EU' },
      pBase
    ),
    { expectedRevision: 3, market: 'EU' }
  );
  const kBase = {
    phrase: 'crm',
    intent: 'comparison' as const,
    locale: '',
    priority: '3',
  };
  const kv = R.decodeRedditKeyword({
    id: 'rk1',
    projectId: 'rp1',
    phrase: 'PO фраза',
    phraseNorm: 'po фраза',
    intent: 'comparison',
    locale: null,
    priority: 3,
    status: 'active',
    revision: 5,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  });
  assert.deepEqual(
    V.keywordPatchBody(
      kv,
      { ...kBase, phrase: 'PO фраза', priority: '5' },
      {
        ...kBase,
        phrase: 'PO фраза',
      }
    ),
    { expectedRevision: 5, priority: 5 }
  );
  // Выдержка: не трогал — не шлём, даже если на сервере текст другой.
  const ex = {
    revision: 4,
    excerpt: {
      sourceId: 's',
      text: 'новий від PO',
      injectionFlag: null,
      usage: 'restricted' as const,
    },
  };
  assert.equal(V.excerptPatchBody(ex, 'старий', 'старий'), null);
  assert.deepEqual(V.excerptPatchBody(ex, 'мій', 'старий'), {
    expectedRevision: 4,
    excerpt: 'мій',
  });
  assert.deepEqual(V.changedKeys(pBase, { ...pBase, title: ' T ' }), []);
}

// ═══ 5в. Подписи полей 400 словами (S3-3) ═══════════════════════════════
for (const d of [pubRedditUk, pubRedditRu, pubRedditEn]) {
  assert.equal(
    V.fieldLabel('titleManual', d),
    d.opportunities.fields.titleManual
  );
  assert.equal(
    V.fieldLabel('factors.topic_fit.why', d),
    `${d.opportunities.factors.topic_fit}: ${d.opportunities.why}`
  );
  assert.ok(V.fieldLabel('conditions.3', d).includes('4'));
  assert.equal(V.fieldLabel('somethingNew', d), d.common.formField);
  assert.equal(V.fieldLabel('constructor', d), d.common.formField);
  for (const f of [
    'sourceExcerpt',
    'community',
    'threadUrl',
    'excerpt',
    'angle',
    'phrase',
    'descriptionManual',
    'topics',
    'checkedAt',
    'sourceUrl',
  ])
    assert.notEqual(V.fieldLabel(f, d), d.common.formField, f);
}

// ═══ 6. Тона ══════════════════════════════════════════════════════════════
assert.equal(V.verdictTone('ok'), 'success');
assert.equal(V.verdictTone('block'), 'danger');
assert.equal(V.verdictTone('recheck_required'), 'warning');
assert.equal(V.verdictTone(null), 'warning');
for (const s of R.REDDIT_SNAPSHOT_STATES)
  assert.equal(V.snapshotStateTone(s) === 'success', s === 'reviewed', s);
// Отозванный первоисточник — не зелёный (S3-5).
assert.equal(
  V.snapshotStateTone('reviewed', ['rules_source_revoked']),
  'danger'
);
assert.equal(V.snapshotStateTone('reviewed', [], 'revoked'), 'danger');
assert.equal(
  V.historicVerdictTone('ok'),
  'neutral',
  '«на момент оценки» — не зелёный'
);
assert.equal(V.historicVerdictTone('block'), 'danger');
for (const s of R.REDDIT_OPPORTUNITY_STATUSES)
  assert.equal(V.opportunityTone(s) === 'success', s === 'qualified', s);
assert.equal(V.opportunityTone('blocked'), 'danger');

// ═══ 7. Ошибки P-R словами ═══════════════════════════════════════════════
{
  const r = pubRedditUk;
  const e = (code: string, status: number, details: Record<string, unknown>) =>
    new ApiError(code, 'server', status, 'rq', details);
  const pb = V.describeRedditError(
    e('PUB_TRANSITION_INVALID', 409, {
      reason: 'policy_block',
      from: 'blocked',
      reasons: ['promotion_prohibited', 'rules_unreviewed'],
    }),
    pubUk,
    r,
    r.opportunities.statuses
  );
  const txt = pb.lines.join(' ');
  assert.ok(txt.includes(r.gate.reasons.promotion_prohibited), txt);
  assert.ok(txt.includes(r.gate.reasons.rules_unreviewed), txt);
  assert.ok(
    !/policy_block|promotion_prohibited|rules_unreviewed/.test(txt),
    txt
  );
  assert.equal(pb.conflict, false);
  const st = V.describeRedditError(
    e('PUB_TRANSITION_INVALID', 409, { reason: 'status', from: 'skipped' }),
    pubUk,
    r,
    r.opportunities.statuses
  );
  assert.ok(
    st.lines[0].includes(r.opportunities.statuses.skipped),
    st.lines[0]
  );
  const dup = V.describeRedditError(
    e('PUB_CONFLICT', 409, { reason: 'duplicate', existingId: 'ro9' }),
    pubUk,
    r
  );
  assert.equal(dup.existingId, 'ro9');
  assert.equal(dup.conflict, false, 'дубль — не «устаревшая версия»');
  assert.deepEqual(dup.lines, [r.errors.duplicate]);
  assert.equal(
    V.isDuplicate(e('PUB_CONFLICT', 409, { reason: 'duplicate' })),
    true
  );
  const cas = V.describeRedditError(
    e('PUB_CONFLICT', 409, { currentRevision: 7 }),
    pubUk,
    r
  );
  assert.equal(cas.conflict, true, 'CAS — перезагрузка');
  const val = V.describeRedditError(
    e('PUB_VALIDATION', 400, {
      fields: [
        { field: 'threadUrl', code: 'community_mismatch' },
        { field: 'factors.policy_risk', code: 'derived' },
      ],
    }),
    pubUk,
    r
  );
  assert.ok(val.lines[0].includes(pubUk.errors.fieldCodes.community_mismatch));
  assert.ok(val.lines[0].includes(pubUk.errors.fieldCodes.derived));
  const rv = V.describeRedditError(
    e('PUB_SOURCE_NOT_ALLOWED', 409, {
      sourceIds: ['src9'],
      reason: 'revoked',
    }),
    pubUk,
    r
  );
  assert.deepEqual(rv.lines, [r.errors.excerptRevoked]);
  const locked = V.describeRedditError(
    e('PUB_CONFLICT', 409, { reason: 'reddit_evidence_locked' }),
    pubUk,
    r
  );
  assert.deepEqual(locked.lines, [
    pubUk.errors.conflictReasons.reddit_evidence_locked,
  ]);
  assert.equal(locked.conflict, false, 'не версия — без «перезагрузить»');
  const arch = V.describeRedditError(
    e('PUB_TRANSITION_INVALID', 409, {
      reason: 'community_archived',
      from: 'archived',
    }),
    pubUk,
    r
  );
  assert.deepEqual(arch.lines, [r.errors.transition.community_archived]);
  const val2 = V.describeRedditError(
    e('PUB_VALIDATION', 400, {
      fields: [
        { field: 'titleManual', code: 'profile_ref' },
        { field: 'conditions.3', code: 'profile_ref' },
        { field: 'factors.topic_fit.why', code: 'pii' },
      ],
    }),
    pubUk,
    r
  );
  const vt = val2.lines.join(' ');
  assert.ok(!/titleManual|conditions\.3|factors\./.test(vt), vt);
  assert.ok(vt.includes(r.opportunities.fields.titleManual), vt);
  assert.ok(vt.includes(pubUk.errors.fieldCodes.profile_ref), vt);
  const imp = V.describeRedditError(
    e('PUB_IMPORT_BLOCKED', 400, { reason: 'reddit_manual_only' }),
    pubUk,
    r
  );
  assert.ok(imp.lines.includes(pubUk.errors.importReasons.reddit_manual_only));
}

// ═══ 8. selfReview и права ════════════════════════════════════════════════
{
  const snap = {
    createdBy: 'member:m1',
    status: 'current' as const,
    reviewState: 'unreviewed' as const,
    source: { url: 'https://www.reddit.com/r/x/about/rules' },
  };
  assert.equal(V.isOwnSnapshot(snap, 'm1'), true);
  assert.equal(V.isOwnSnapshot(snap, 'm2'), false);
  assert.equal(V.isOwnSnapshot({ createdBy: 'restore:x' }, 'x'), false);
  assert.equal(
    selfReviewOf('reddit.manage', 'member:m1', 'm1'),
    false,
    'без (с)'
  );
  assert.equal(V.canReviewSnapshot(snap), true);
  assert.equal(
    V.canReviewSnapshot({ ...snap, reviewState: 'reviewed' }),
    false
  );
  assert.equal(V.canReviewSnapshot({ ...snap, status: 'superseded' }), false);
  // Р-RD-AUD-3: без первоисточника подтвердить нельзя — подсказка вместо кнопки.
  const noSrc = { ...snap, source: { url: '' } };
  assert.equal(V.canReviewSnapshot(noSrc), false);
  assert.equal(V.needsSourceForReview(noSrc), true);
  assert.equal(V.needsSourceForReview(snap), false);
  assert.equal(
    V.needsSourceForReview({ ...noSrc, reviewState: 'reviewed' }),
    false
  );
  const role = (roles: string[], admin = false, owner = false) => ({
    roles: roles as never[],
    admin,
    accountOwner: owner,
  });
  // Матрица §5: SA — ничего; VW/AN/OP — только чтение; PO/ED — всё M1.
  const M: Record<string, [boolean, boolean, boolean, boolean]> = {
    product_owner: [true, true, true, true],
    editor: [true, true, true, false],
    operator: [true, false, false, true],
    analyst: [true, false, false, false],
    sales: [false, false, false, false],
    viewer: [true, false, false, false],
  };
  for (const [rl, [read, manage, review, handoff]] of Object.entries(M)) {
    const my = role([rl]);
    assert.equal(canDo(my, 'reddit.read'), read, `${rl} read`);
    assert.equal(canDo(my, 'reddit.manage'), manage, `${rl} manage`);
    assert.equal(canDo(my, 'reddit.rules.review'), review, `${rl} review`);
    assert.equal(canDo(my, 'reddit.handoff'), handoff, `${rl} handoff`);
  }
  assert.equal(canDo(role([], true), 'reddit.read'), true, 'admin читает');
  assert.equal(canDo(role([], true), 'reddit.manage'), false);
  assert.equal(canDo(role([], true, true), 'reddit.rules.review'), true);
}

// ═══ 9. Словари ═══════════════════════════════════════════════════════════
function shape(v: unknown, prefix = ''): string[] {
  if (typeof v === 'string') {
    assert.ok(v.trim().length > 0, `пустая строка: ${prefix}`);
    return [`${prefix}:${(v.match(/\{\w+\}/g) ?? []).sort().join(',')}`];
  }
  assert.ok(v !== null && typeof v === 'object', `не объект: ${prefix}`);
  return Object.keys(v as object)
    .sort()
    .flatMap((k) =>
      shape((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k)
    );
}
assert.deepEqual(shape(pubRedditUk), shape(pubRedditRu));
assert.deepEqual(shape(pubRedditEn), shape(pubRedditRu));
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  return Object.values(v as object).flatMap(strings);
}
for (const [name, a] of [
  ['uk', pubRedditUk],
  ['en', pubRedditEn],
] as const) {
  const x = strings(a);
  const y = strings(pubRedditRu);
  const same = x.filter((s, i) => s === y[i] && /[а-яёіїє]{4}/i.test(s)).length;
  assert.ok(same / x.length < 0.05, `${name}: не переведено ${same}`);
}
for (const d of [pubRedditUk, pubRedditRu, pubRedditEn]) {
  for (const s of R.REDDIT_PROJECT_STATUSES) assert.ok(d.statuses[s], s);
  for (const s of R.REDDIT_KEYWORD_STATUSES)
    assert.ok(d.keywords.statuses[s], s);
  for (const s of R.REDDIT_OPPORTUNITY_STATUSES)
    assert.ok(d.opportunities.statuses[s], s);
  for (const s of R.REDDIT_INTENTS) assert.ok(d.opportunities.intents[s], s);
  for (const s of R.REDDIT_SCORE_FACTORS)
    assert.ok(d.opportunities.factors[s], s);
  for (const s of R.REDDIT_POLICY_VERDICTS) assert.ok(d.gate.verdicts[s], s);
  for (const s of R.REDDIT_POLICY_REASONS) assert.ok(d.gate.reasons[s], s);
  for (const s of R.REDDIT_POLICY_WARNINGS) assert.ok(d.gate.warnings[s], s);
  for (const s of R.REDDIT_PROMOTION_POLICIES)
    assert.ok(d.rules.promotion[s], s);
  for (const s of R.REDDIT_LINKS_POLICIES) assert.ok(d.rules.links[s], s);
  for (const s of R.REDDIT_SNAPSHOT_STATES) assert.ok(d.rules.states[s], s);
  for (const s of R.REDDIT_SNAPSHOT_STATUSES)
    assert.ok(d.rules.snapshotStatuses[s], s);
  for (const s of R.SOURCE_USAGES_R) assert.ok(d.rules.usage[s], s);
  for (const s of R.REDDIT_TRANSITION_REASONS)
    assert.ok((d.errors.transition as Record<string, string>)[s], s);
  for (const k of Object.keys(d.tabs)) assert.ok(k);
}

// ═══ 10. Рендер: цитата — текстом, ссылка — без превью ════════════════════
{
  const ctx = {
    siteId: 's1',
    product: { id: 'pid1', features: { reddit: true } },
    roles: { roles: ['editor'], admin: false, accountOwner: false },
    can: () => true,
    reloadProduct: () => undefined,
    http: {},
    aiHttp: {},
    locale: 'uk',
    t: pubUk,
    href: (s?: string | null, i?: string | null) =>
      `#/sites/s1/publisher/${s ?? ''}${i ? `/${i}` : ''}`,
    go: () => undefined,
    memberId: 'm1',
  } as unknown as PublisherValue;
  const html = (el: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(
      createElement(PublisherContext.Provider, { value: ctx }, el)
    );
  const XSS =
    '<img src=x onerror="window.__xss=1"><script>alert(1)</script>**bold** [link](javascript:alert(2))';
  const q = html(
    createElement(PlainQuote, { text: XSS, injectionFlag: 'ignore_previous' })
  );
  assert.ok(!/<img|<script/i.test(q), q);
  assert.ok(
    q.includes('&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;'),
    q
  );
  assert.ok(
    q.includes('**bold** [link](javascript:alert(2))'),
    'markdown не рендерится'
  );
  assert.ok(!/<a\b/.test(q), 'в цитате нет ссылок');
  assert.ok(/<pre[^>]*data-reddit-quote/.test(q));
  assert.ok(q.includes('ignore_previous'));
  const l = html(
    createElement(RedditLink, {
      url: 'https://www.reddit.com/r/saas/comments/abc123/x',
    })
  );
  assert.ok(
    /target="_blank"/.test(l) && /rel="noopener noreferrer"/.test(l),
    l
  );
  assert.ok(
    l.includes('href="https://www.reddit.com/r/saas/comments/abc123/x"')
  );
  assert.ok(l.includes(pubRedditUk.common.openOnReddit));
  assert.ok(!/<img|<iframe|favicon/i.test(l), 'без превью и favicon');
  const bad = html(createElement(RedditLink, { url: 'javascript:alert(1)' }));
  assert.ok(!/<a\b/.test(bad) && !/href=/.test(bad), bad);
  const src = html(createElement(SourceLink, { url: 'http://evil.example' }));
  assert.ok(!/href=/.test(src), src);
  const g = html(
    createElement(GateReasons, {
      reasons: ['rules_stale'],
      warnings: ['links_restricted'],
    })
  );
  assert.ok(g.includes(pubRedditUk.gate.reasons.rules_stale));
  assert.ok(g.includes(pubRedditUk.gate.warnings.links_restricted));
  const er = html(
    createElement(RedditErrorAlert, {
      error: new ApiError('PUB_CONFLICT', 'x', 409, 'rq', {
        reason: 'duplicate',
        existingId: 'rc7',
      }),
      existingTab: 'communities',
    })
  );
  assert.ok(er.includes('#/sites/s1/publisher/reddit/rc7'), er);
  assert.ok(!er.includes(pubUk.common.reload), 'дубль без «перезагрузить»');
  // Отзыв — только при `source.manage` (защита в глубину, S3-7).
  const rv = html(
    createElement(RevokeEvidence, {
      sourceId: 'src1',
      label: pubRedditUk.common.revokeExcerpt,
      onDone: () => undefined,
    })
  );
  assert.ok(rv.includes(pubRedditUk.common.revokeExcerpt), rv);
  const noManage = renderToStaticMarkup(
    createElement(
      PublisherContext.Provider,
      {
        value: {
          ...ctx,
          can: (a: string) => a !== 'source.manage',
        } as PublisherValue,
      },
      createElement(RevokeEvidence, {
        sourceId: 'src1',
        label: pubRedditUk.common.revokeExcerpt,
        onDone: () => undefined,
      })
    )
  );
  assert.equal(noManage, '', 'без source.manage кнопки отзыва нет');
  // Конфликт полей — оба значения на экране (S2-1).
  const cp = html(
    createElement(ConflictPanel<{ title: string }>, {
      conflicts: [{ key: 'title', mine: 'МОЄ', theirs: 'СЕРВЕРНЕ' }],
      label: () => 'Назва',
      resolve: () => undefined,
    })
  );
  assert.ok(cp.includes('МОЄ') && cp.includes('СЕРВЕРНЕ'), cp);
  assert.ok(cp.includes(pubRedditUk.common.takeTheirs));
  const cas = html(
    createElement(RedditErrorAlert, {
      error: new ApiError('PUB_CONFLICT', 'x', 409, 'rq', {
        currentRevision: 3,
      }),
    })
  );
  assert.ok(cas.includes(pubUk.common.reload), '409 CAS — перезагрузка');
}

// Аудит ui-6/ui-7 (15.10.2026): повтор загрузки и «исход неизвестен».
{
  const e = (code: string, status: number) => new ApiError(code, 'x', status);
  assert.equal(V.isReloadable(e('network', 0)), true);
  assert.equal(V.isReloadable(e('Bad Gateway', 502)), true);
  assert.equal(V.isReloadable(e('PUB_INTERNAL', 500)), true);
  assert.equal(V.isReloadable(e('PUB_BUSY', 409)), true);
  assert.equal(V.isReloadable(e('UPSTREAM_TIMEOUT', 504)), true);
  assert.equal(V.isReloadable(e('PUB_NOT_FOUND', 404)), false);
  assert.equal(V.isReloadable(e('PUB_CONFLICT', 409)), false);
  assert.equal(V.isReloadable(null), false);
  assert.equal(V.isUncertainOutcome(e('network', 0)), true);
  assert.equal(V.isUncertainOutcome(e('http_503', 503)), true);
  assert.equal(V.isUncertainOutcome(e('UPSTREAM_TIMEOUT', 504)), true);
  assert.equal(V.isUncertainOutcome(e('PUB_VALIDATION', 400)), false);
  assert.equal(V.isUncertainOutcome(e('PUB_PAYLOAD_TOO_LARGE', 413)), false);
  assert.equal(V.isUncertainOutcome(e('PUB_INTERNAL', 500)), false);
  assert.equal(V.isUncertainOutcome(undefined), false);
  // 503 с прикладным кодом — исход известен (отказ модели), не «шлюз».
  assert.equal(V.isUncertainOutcome(e('PUB_AI_UNAVAILABLE', 503)), false);
  assert.equal(V.isReloadable(e('PUB_AI_UNAVAILABLE', 503)), false);
  assert.equal(V.isUncertainOutcome(e('http_504', 504)), true);
  assert.equal(V.isUncertainOutcome(e('PUB_BUSY', 503)), true);
  assert.equal(V.isReloadable(e('http_503', 503)), true);
}

console.log('publisher-reddit-view: ok');
