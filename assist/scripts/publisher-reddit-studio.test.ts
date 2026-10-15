/**
 * AI Publisher (P-R, Reddit Manual MVP, M2 AI Content Studio) — чистый слой
 * студии `lib/publisher/reddit-studio-view.ts` и части экранов без браузера:
 *  1. бриф: comment — только с тредом и контекстом уже при создании (A13);
 *     тезисы — источник продукта или «нужна проверка»; правка — только
 *     изменённое; бриф из возможности (контекст — её выдержка);
 *  2. «чего не хватает» словами (uk/ru/en), включая `key_points[N]`;
 *  3. вариант → тело версии (у comment нет `title`), правка черновика —
 *     только изменённое, `meta` с картой утверждений сохраняется;
 *  4. абзацы, «перегенерировать абзац» (в черновик), счётчик слов;
 *  5. раскрытие A08 (подсказка) и предпросмотр markdown — без HTML/ссылок
 *     (дерево и рендер);
 *  6. согласование: WARN подтверждаются все, ровно коды проверки;
 *  7. шаги материала по статусам (копирование только после согласования,
 *     отметка — только после копирования, `scheduled` — сначала снять);
 *  8. URL отчёта ≡ серверный `normalizeReportedUrl`; дата не в будущем;
 *  9. ошибки M2 словами; ручной путь при `PUB_AI_DISABLED`;
 * 10. копирование: ровно переданная строка (`copyText` кита), запасной
 *     путь без Clipboard API; рендер копируемого текста — как есть.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, copyText } from '../src/kit';
import { pubUk } from '../src/i18n/publisher-uk';
import { pubRedditEn } from '../src/i18n/publisher-reddit-en';
import { pubRedditRu } from '../src/i18n/publisher-reddit-ru';
import { pubRedditUk } from '../src/i18n/publisher-reddit-uk';
import type { VersionView } from '../src/lib/publisher/content-api';
import * as S from '../src/lib/publisher/reddit-studio-api';
import * as V from '../src/lib/publisher/reddit-studio-view';
import { rebaseForm, changedKeys } from '../src/lib/publisher/reddit-view';
import { actorLabel } from '../src/lib/publisher/view';
import { describePubError } from '../src/lib/publisher/errors';
import * as SN from '../../sites-backend/src/modules/publisher/reddit/normalize';
import {
  PublisherContext,
  type PublisherValue,
} from '../src/screens/publisher/publisher-context';
import {
  CopyBlock,
  MarkdownPreview,
  StudioErrorAlert,
  WordCount,
} from '../src/screens/publisher/reddit/studio-parts';
import {
  ApprovePanel,
  CopyResult,
  PublicationLine,
} from '../src/screens/publisher/reddit/StudioTab';
import { PlainQuote } from '../src/screens/publisher/reddit/reddit-parts';

const DICTS = { uk: pubRedditUk, ru: pubRedditRu, en: pubRedditEn };
const r = pubRedditUk;

// ═══ 1. Бриф ═════════════════════════════════════════════════════════════
{
  const f = V.briefForm();
  assert.deepEqual(V.briefIssues(f).sort(), ['contentType', 'objective']);
  // comment без треда и контекста — не создаётся (A13).
  const c: V.BriefForm = { ...f, contentType: 'comment', objective: 'o' };
  assert.deepEqual(V.briefIssues(c).sort(), ['context', 'opportunity']);
  assert.equal(V.briefCreateBody('rp1', c), null);
  assert.deepEqual(
    V.briefIssues({ ...c, opportunityId: 'ro1', context: '   ' }),
    ['context']
  );
  // post — сообщество или возможность.
  const p: V.BriefForm = { ...f, contentType: 'post', objective: 'o' };
  assert.deepEqual(V.briefIssues(p), ['community']);
  assert.deepEqual(V.briefIssues({ ...p, communityId: 'rc1' }), []);
  // Тезисы: источник продукта или пометка; > 5 — нельзя.
  assert.equal(
    V.keyPointBody({ text: 't', sources: '', needsVerification: false }),
    null
  );
  assert.equal(
    V.keyPointBody({ text: 't', sources: 'a/b', needsVerification: false }),
    null,
    'id источника — без слэшей'
  );
  assert.deepEqual(
    V.keyPointBody({
      text: ' t ',
      sources: 'src1, src2 src1',
      needsVerification: false,
    }),
    { text: 't', sourceIds: ['src1', 'src2'] }
  );
  assert.deepEqual(
    V.keyPointBody({ text: 't', sources: 'src1', needsVerification: true }),
    { text: 't', sourceIds: 'needs_verification' }
  );
  assert.equal(
    V.keyPointBody({
      text: 'x'.repeat(301),
      sources: 'a',
      needsVerification: false,
    }),
    null
  );
  const kp = V.keyPointForm();
  const many = {
    ...p,
    communityId: 'rc1',
    keyPoints: Array(6).fill({ ...kp, text: 't', needsVerification: true }),
  };
  assert.ok(V.briefIssues(many).includes('keyPoints'));
  // Создание: только заданное, communityId не уходит вместе с возможностью.
  const full: V.BriefForm = {
    ...c,
    opportunityId: 'ro1',
    communityId: 'rc1',
    context: ' ctx ',
    affiliation: 'founder',
    brand: ' Пілот ',
    constraints: 'a\n\n b ',
    keyPoints: [{ text: 't', sources: 'src1', needsVerification: false }],
  };
  assert.deepEqual(V.briefCreateBody('rp1', full), {
    projectId: 'rp1',
    contentType: 'comment',
    opportunityId: 'ro1',
    objective: 'o',
    context: 'ctx',
    keyPoints: [{ text: 't', sourceIds: ['src1'] }],
    affiliation: 'founder',
    brand: 'Пілот',
    linksAllowed: false,
    constraints: ['a', 'b'],
  });
  // Бренд: 2..64 (пусто — по умолчанию сервера).
  assert.ok(V.briefIssues({ ...full, brand: 'X' }).includes('brand'));
  assert.ok(!('brand' in V.briefCreateBody('rp1', { ...full, brand: ' ' })!));
  // Из возможности: comment к её треду, контекст — выдержка (не отозванная).
  const o = {
    id: 'ro1',
    communityId: 'rc1',
    excerpt: {
      sourceId: 's',
      text: 'EX',
      injectionFlag: null,
      usage: 'allowed' as const,
    },
  };
  const fo = V.briefFormFromOpportunity(o);
  assert.equal(fo.contentType, 'comment');
  assert.equal(fo.opportunityId, 'ro1');
  assert.equal(fo.context, 'EX');
  assert.equal(
    V.briefFormFromOpportunity({
      ...o,
      excerpt: { ...o.excerpt, usage: 'revoked' },
    }).context,
    ''
  );
  // Правка — только изменённое; affiliation очищается в null.
  const b = S.decodeRedditBrief({
    id: 'rb1',
    projectId: 'rp1',
    communityId: 'rc1',
    subreddit: 'saas',
    canonicalUrl: 'https://www.reddit.com/r/saas/',
    opportunityId: 'ro1',
    threadUrl: 'https://www.reddit.com/r/saas/comments/abc123/x/',
    offerVersionId: 'ov1',
    contentType: 'comment',
    objective: 'o',
    audience: null,
    context: 'ctx',
    keyPoints: [],
    affiliation: 'founder',
    brand: 'Demo',
    linksAllowed: false,
    tone: null,
    language: 'en',
    constraints: [],
    forbiddenClaims: [],
    cta: null,
    status: 'ready',
    missing: [],
    gate: { verdict: 'ok', reasons: [], warnings: [] },
    ai: { available: true, reason: null },
    contentIds: [],
    revision: 4,
    createdAt: '2026-10-14T08:00:00.000Z',
    updatedAt: '2026-10-14T08:00:00.000Z',
  });
  const base = V.briefForm(b);
  assert.equal(
    V.briefPatchBody(b, base, base),
    null,
    'без изменений — нет тела'
  );
  assert.deepEqual(
    V.briefPatchBody(b, { ...base, affiliation: '', tone: ' calm ' }, base),
    { expectedRevision: 4, affiliation: null, tone: 'calm' }
  );
  // Бренд: правка и очистка (→ null, сервер посчитает missing `brand`).
  assert.deepEqual(V.briefPatchBody(b, { ...base, brand: ' Pilot ' }, base), {
    expectedRevision: 4,
    brand: 'Pilot',
  });
  assert.deepEqual(V.briefPatchBody(b, { ...base, brand: '' }, base), {
    expectedRevision: 4,
    brand: null,
  });
  // Чужая правка того же поля не перетирается: тело — от base.
  const theirs = { ...base, audience: 'devs' };
  assert.deepEqual(V.briefPatchBody(b, { ...theirs, cta: 'x' }, theirs), {
    expectedRevision: 4,
    cta: 'x',
  });
  assert.equal(V.briefUsable(b), true);
  assert.equal(V.briefUsable({ status: 'ready', missing: ['context'] }), false);
}

// ═══ 2. «Чего не хватает» словами ════════════════════════════════════════
for (const [l, d] of Object.entries(DICTS)) {
  for (const m of S.REDDIT_BRIEF_MISSING) {
    const t = V.missingText(m, d);
    assert.ok(t && t !== m, `${l}: missing ${m}`);
  }
  assert.ok(V.missingText('key_points[1]', d).includes('2'), `${l}: тезис N+1`);
  assert.equal(V.missingText('constructor', d), 'constructor');
  for (const k of S.REDDIT_CHECK_BLOCKERS)
    assert.ok(d.studio.blockers[k], `${l} ${k}`);
  for (const k of S.REDDIT_CHECK_WARNINGS)
    assert.ok(d.studio.warnings[k], `${l} ${k}`);
  for (const k of S.REDDIT_AI_FINDINGS)
    assert.ok(d.studio.generate.findingCodes[k], `${l} ${k}`);
  for (const k of S.REDDIT_DRAFT_TEMPLATES)
    assert.ok(d.studio.generate.templates[k], `${l} ${k}`);
  for (const k of S.REDDIT_AFFILIATIONS)
    assert.ok(d.briefs.affiliations[k], `${l} ${k}`);
  for (const k of S.REDDIT_BRIEF_STATUSES)
    assert.ok(d.briefs.statuses[k], `${l} ${k}`);
  for (const k of S.REDDIT_CONTENT_TYPES)
    assert.ok(d.briefs.contentTypes[k], `${l} ${k}`);
  for (const k of S.REDDIT_AI_UNAVAILABLE)
    assert.ok(d.briefs.ai[k], `${l} ${k}`);
  // Никаких «подтверждено/соответствует правилам Reddit» в текстах студии.
  const all = JSON.stringify([d.studio, d.publications]);
  assert.ok(
    !/підтверджено Reddit|подтверждено Reddit|verified by Reddit|complies with Reddit|соответствует правилам Reddit|відповідає правилам Reddit/i.test(
      all
    ),
    l
  );
  assert.ok(/≠/.test(d.studio.copy.note), `${l}: копирование ≠ публикация`);
}

// ═══ 3. Вариант → версия, правка черновика ═══════════════════════════════
const VARIANT: S.RedditDraftVariant = {
  title: 'T',
  body: 'Disclosure: I am the founder.\n\nPara two.\n\nPara three.',
  disclosure: 'Disclosure: I am the founder.',
  flair_suggestion: 'Tips',
  claim_map: [
    { text: 'c', source_ids: ['src1'] },
    { text: 'n', source_ids: 'needs_verification' },
  ],
  uncertainties: ['u'],
};
{
  const c = V.variantVersionBody('comment', VARIANT, 'call1', 2);
  assert.ok(!('title' in c), 'comment без title');
  assert.deepEqual(c, {
    body: VARIANT.body,
    meta: {
      disclosure: VARIANT.disclosure,
      flairSuggestion: 'Tips',
      claimMap: [
        { text: 'c', sourceIds: ['src1'] },
        { text: 'n', sourceIds: 'needs_verification' },
      ],
      uncertainties: ['u'],
    },
    aiCallId: 'call1',
    variantIndex: 2,
  });
  assert.equal(V.variantVersionBody('post', VARIANT, 'call1', 0).title, 'T');
  // Ручной путь.
  assert.equal(V.manualVersionBody('post', V.draftForm()), null);
  assert.equal(
    V.manualVersionBody('comment', { ...V.draftForm(), body: '  ' }),
    null
  );
  const mc = V.manualVersionBody('comment', {
    ...V.draftForm(),
    title: 'ignored',
    body: 'b',
  });
  assert.ok(mc && !('title' in mc));
  assert.ok(
    V.draftIssues('post', { ...V.draftForm(), title: ' ' }).includes('title')
  );
  assert.deepEqual(
    V.draftIssues('comment', { ...V.draftForm(), body: 'x'.repeat(10_001) }),
    ['body']
  );
  assert.deepEqual(
    V.draftIssues('post', {
      ...V.draftForm(),
      title: 't',
      body: 'x'.repeat(10_001),
    }),
    []
  );
  // Правка: только изменённое; meta целиком с картой утверждений версии.
  const v = {
    revision: 5,
    meta: {
      disclosure: 'D',
      flairSuggestion: null,
      claimMap: [{ text: 'c', sourceIds: ['src1'] }],
      uncertainties: ['u'],
    },
  } as unknown as Pick<VersionView, 'revision' | 'meta'>;
  const base: V.DraftForm = {
    title: '',
    body: 'b',
    disclosure: 'D',
    flair: '',
  };
  assert.equal(V.draftPatchBody('comment', v, base, base), null);
  assert.deepEqual(
    V.draftPatchBody('comment', v, { ...base, body: 'b2', title: 'x' }, base),
    {
      expectedRevision: 5,
      body: 'b2',
    }
  );
  assert.deepEqual(
    V.draftPatchBody('comment', v, { ...base, flair: ' F ' }, base),
    {
      expectedRevision: 5,
      meta: {
        disclosure: 'D',
        flairSuggestion: 'F',
        claimMap: [{ text: 'c', sourceIds: ['src1'] }],
        uncertainties: ['u'],
      },
    }
  );
}

// ═══ 4. Абзацы, перегенерация, счётчик ═══════════════════════════════════
{
  assert.deepEqual(V.paragraphs('a\r\n\r\n b \n\n\n\nc\n'), ['a', 'b', 'c']);
  const body = 'one\n\ntwo\n\nthree';
  assert.equal(V.replaceParagraph(body, 1, ' TWO '), 'one\n\nTWO\n\nthree');
  assert.equal(
    V.replaceParagraph(body, 7, 'x'),
    body,
    'вне диапазона — без изменений'
  );
  // Вариант перегенерации — вся чернетка; берём только нужный абзац.
  assert.equal(V.rewrittenParagraph('one\n\nNEW two\n\nthree', 1), 'NEW two');
  assert.equal(V.rewrittenParagraph('one', 3), null);
  assert.deepEqual(V.wordCount('  Hello,  світ!\nтри  '), {
    words: 3,
    chars: 21,
  });
  assert.deepEqual(V.wordCount(''), { words: 0, chars: 0 });
  // Варианты вызова: только `ok` и строгая форма.
  const call = {
    status: 'ok' as const,
    output: { variants: [VARIANT, VARIANT] },
  };
  assert.equal(V.variantsOf(call)?.length, 2);
  assert.equal(V.variantsOf({ ...call, status: 'disabled' }), null);
  assert.equal(
    V.variantsOf({ ...call, output: { variants: [VARIANT] } }),
    null
  );
  assert.equal(V.variantsOf(null), null);
}

// ═══ 5. Раскрытие и предпросмотр ═════════════════════════════════════════
{
  // A08 (`markers@3`, §10.3): клиент НЕ судит раскрытие (паритет со словарями
  // сервера дорог) — только подсказка правила; вердикт — коды проверки.
  assert.ok(
    !('disclosureIssue' in V),
    'на клиенте нет своего вердикта раскрытия'
  );
  assert.deepEqual(
    [...V.DISCLOSURE_CODES].sort(),
    [...S.REDDIT_CHECK_BLOCKERS, ...S.REDDIT_CHECK_WARNINGS]
      .filter((c) => c.includes('disclosure'))
      .sort(),
    'панель раскрытия — все коды раскрытия'
  );
  for (const c of V.DISCLOSURE_CODES)
    assert.ok(
      (S.REDDIT_CHECK_BLOCKERS as readonly string[]).includes(c) ||
        (S.REDDIT_CHECK_WARNINGS as readonly string[]).includes(c),
      c
    );
  for (const [l, d] of Object.entries(DICTS)) {
    assert.ok(/20/.test(d.studio.draft.disclosureRule), `${l}: ≥ 20 в правиле`);
    assert.ok(/300/.test(d.studio.draft.disclosureRule), `${l}: окно 300`);
    assert.ok(d.studio.disclosure.verdict, l);
  }
  // Вариант переписывания → черновик: aiCallId + variantIndex с правкой тела.
  const pv = { expectedRevision: 3, body: 'b' };
  assert.deepEqual(V.withAiChoice(pv, { aiCallId: 'c9', variantIndex: 1 }), {
    expectedRevision: 3,
    body: 'b',
    aiCallId: 'c9',
    variantIndex: 1,
  });
  assert.deepEqual(V.withAiChoice(pv, null), pv);
  assert.equal(V.withAiChoice(null, { aiCallId: 'c9', variantIndex: 1 }), null);
  assert.deepEqual(
    V.withAiChoice(
      { expectedRevision: 3, title: 't' },
      { aiCallId: 'c9', variantIndex: 0 }
    ),
    { expectedRevision: 3, title: 't' },
    'без правки тела — выбор не уходит'
  );
  const XSS =
    '<script>alert(1)</script> **b** [l](javascript:alert(2)) ![i](https://x/i.png)\n\n- a\n- *e*\n\n> q `c`\n\n1. one';
  const tree = V.parseMarkdownSubset(XSS);
  assert.deepEqual(
    tree.map((b) => b.t),
    ['p', 'ul', 'quote', 'ol']
  );
  const text = JSON.stringify(tree);
  assert.ok(text.includes('<script>alert(1)</script>'), 'HTML — текстом');
  assert.ok(text.includes('[l](javascript:alert(2))'), 'ссылка — текстом');
  assert.ok(!/"t":"(a|img|link|html)"/.test(text));
}

// ═══ 6. Согласование: WARN подтверждаются все ════════════════════════════
{
  const check = {
    warnings: [
      { code: 'reddit_links_restricted', text: 'w' },
      { code: 'reddit_duplicate', text: 'd' },
      { code: 'reddit_duplicate', text: 'd2' },
    ],
  };
  assert.equal(
    V.approveRedditBody('h', '', check, new Set(['reddit_duplicate'])),
    null
  );
  assert.deepEqual(
    V.approveRedditBody(
      'h',
      ' ok ',
      check,
      new Set(['reddit_duplicate', 'reddit_links_restricted', 'extra'])
    ),
    {
      versionHash: 'h',
      reason: 'ok',
      acknowledgedWarnings: ['reddit_links_restricted', 'reddit_duplicate'],
    }
  );
  assert.deepEqual(V.approveRedditBody('h', '', { warnings: [] }, new Set()), {
    versionHash: 'h',
  });
  assert.deepEqual(V.approveRedditBody('h', '', null, new Set()), {
    versionHash: 'h',
  });
  // QA человека: «не пройдено» — только с причиной.
  assert.deepEqual(V.humanQaBody('editorial', true, 'ignored'), {
    kind: 'editorial',
    result: 'pass',
  });
  assert.equal(V.humanQaBody('technical', false, '  '), null);
  assert.deepEqual(V.humanQaBody('technical', false, ' typo '), {
    kind: 'technical',
    result: 'fail',
    blockers: [{ code: 'other', text: 'typo' }],
  });
}

// ═══ 7. Шаги материала ═══════════════════════════════════════════════════
{
  const ver = (status: string, hash: string | null = 'h') =>
    ({ status, hash }) as unknown as VersionView;
  const steps = (
    st: string,
    cur: VersionView | null,
    appr: VersionView | null = null
  ) =>
    V.materialSteps({
      content: { status: st } as unknown as S.RedditMaterialView['content'],
      currentVersion: cur,
      approvedVersion: appr,
    });
  const s0 = steps('drafting', null);
  assert.ok(s0.newDraft && !s0.editDraft && !s0.copy && !s0.report);
  const s1 = steps('drafting', ver('draft', null));
  assert.ok(s1.editDraft && s1.submit && !s1.newDraft && !s1.approve);
  const s2 = steps('editorial_review', ver('submitted'));
  assert.ok(s2.approve && !s2.copy && !s2.editDraft && !s2.newDraft);
  const s3 = steps('approved', ver('approved'), ver('approved'));
  assert.ok(s3.copy && !s3.report, 'отметка — только после копирования');
  const s4 = steps('scheduled', ver('approved'), ver('approved'));
  assert.ok(
    s4.copy && s4.report && s4.unscheduleFirst && !s4.newDraft && !s4.editDraft
  );
  const s5 = steps('published', ver('approved'), ver('approved'));
  assert.ok(s5.copy && s5.report && s5.newDraft);
  assert.ok(!steps('withdrawn', null).newDraft);
  assert.ok(
    !steps('approved', ver('approved'), null).copy,
    'без согласованной — не копируем'
  );
  const basis = V.rulesBasis(
    {
      rules: {
        version: 3,
        checkedAt: '2026-10-13T07:00:00.000Z',
      } as S.RedditMaterialView['rules'],
    },
    r,
    () => '13.10.2026'
  );
  assert.equal(
    basis,
    'Перевірки P-R пройдено на знімку правил v3 від 13.10.2026'
  );
  assert.equal(
    V.rulesBasis({ rules: null }, r, () => ''),
    r.studio.rulesNone
  );
}

// ═══ 8. URL отчёта ≡ сервер; дата ════════════════════════════════════════
{
  const INPUTS = [
    'https://www.reddit.com/r/SaaS/comments/abc123/how_to/',
    'https://old.reddit.com/r/saas/comments/abc123/how_to/def456/',
    'https://www.reddit.com/r/saas/comments/abc123/comment/def456/?context=3',
    'https://new.reddit.com/r/saas/comments/abc123/_/def456',
    'reddit.com/r/saas/comments/abc123',
    'https://sh.reddit.com/r/saas/comments/abc123/x',
    'https://np.reddit.com/r/saas/comments/abc123/x#frag',
    'http://www.reddit.com/r/saas/comments/abc123/x',
    'https://www.reddit.com/r/u_someone/comments/abc123/x',
    'https://www.reddit.com/user/someone/comments/abc123/x',
    'https://redd.it/abc123',
    'https://www.reddit.com/r/saas/s/AbCdEf',
    'https://evilreddit.com/r/saas/comments/abc123/x',
    'https://www.reddit.com.evil.com/r/saas/comments/abc123/x',
    'https://user:pw@www.reddit.com/r/saas/comments/abc123/x',
    'https://www.reddit.com:8443/r/saas/comments/abc123/x',
    'javascript:alert(1)//reddit.com/r/saas/comments/abc123',
    'https://www.reddit.com/r/saas/comments/abc123/x/' + 'y'.repeat(2048),
    'https://www.reddit.com/r/saas/comments/ab-c/x',
    'https://www.reddit.com/r/saas/comments/abc123/x/ZZ!/',
    '  https://www.reddit.com/r/saas/comments/abc123/x  ',
    '',
    // Новый вид со slug: id — после `comment` (Р-RD-72); без id — format.
    'https://www.reddit.com/r/saas/comments/abc123/x/comment/def456',
    'https://www.reddit.com/r/saas/comments/abc123/x/comment/',
    'https://www.reddit.com/r/saas/comments/abc123/comment/def456/?context=3',
  ];
  assert.equal(
    (
      V.normalizeReportedUrl(
        'https://www.reddit.com/r/saas/comments/abc123/x/comment/def456'
      ) as { ok: { commentId: string } }
    ).ok.commentId,
    'def456'
  );
  for (const x of INPUTS)
    assert.deepEqual(V.normalizeReportedUrl(x), SN.normalizeReportedUrl(x), x);
  assert.deepEqual(V.normalizeReportedUrl(5), SN.normalizeReportedUrl(5));
  const now = new Date('2026-10-14T12:00:00Z');
  const cm = {
    contentType: 'comment' as const,
    subreddit: 'saas',
    threadUrl: 'https://www.reddit.com/r/saas/comments/abc123/x/',
  };
  const ok = V.reportIssues(
    cm,
    'https://www.reddit.com/r/saas/comments/abc123/x/def456/',
    '2026-10-14T11:00',
    '',
    now
  );
  assert.deepEqual(ok.issues, []);
  assert.equal(
    ok.canon,
    'https://www.reddit.com/r/saas/comments/abc123/comment/def456'
  );
  assert.deepEqual(
    V.reportIssues(
      cm,
      'https://www.reddit.com/r/saas/comments/abc123/x',
      '2026-10-14T11:00',
      '',
      now
    ).issues,
    ['comment_required']
  );
  assert.deepEqual(
    V.reportIssues(
      cm,
      'https://www.reddit.com/r/saas/comments/zzz999/x/comment/d1',
      '2026-10-14T11:00',
      '',
      now
    ).issues,
    ['thread_mismatch']
  );
  assert.deepEqual(
    V.reportIssues(
      { ...cm, contentType: 'post' },
      'https://www.reddit.com/r/other/comments/abc123/x',
      '2026-10-14T11:00',
      '',
      now
    ).issues,
    ['community_mismatch']
  );
  assert.deepEqual(
    V.reportIssues(
      { ...cm, contentType: 'post' },
      'https://www.reddit.com/r/saas/comments/abc123/x',
      '2099-01-01T00:00',
      'x'.repeat(1001),
      now
    ).issues,
    ['future', 'notes']
  );
  assert.deepEqual(V.reportIssues(cm, '', '', '', now).issues, [
    'format',
    'date',
  ]);
}

// ═══ 9. Ошибки M2 словами, ручной путь ═══════════════════════════════════
{
  const t = pubUk;
  const e = (code: string, status: number, details: Record<string, unknown>) =>
    new ApiError(code, 'x', status, 'rq', details);
  const nr = V.describeStudioError(
    e('PUB_BRIEF_NOT_READY', 409, {
      missing: ['brief_ready', 'key_points[0]'],
    }),
    t,
    r
  );
  assert.equal(nr.lines[0], r.briefs.notReady);
  assert.ok(nr.lines.includes(r.briefs.missing.brief_ready));
  assert.ok(nr.lines.some((l) => l.includes('1')));
  const wa = V.describeStudioError(
    e('PUB_CONFLICT', 409, {
      reason: 'warnings_not_acknowledged',
      codes: ['reddit_duplicate'],
    }),
    t,
    r
  );
  assert.equal(wa.conflict, false, 'не «перезагрузить», а отметить WARN');
  assert.ok(wa.lines.includes(r.studio.warnings.reddit_duplicate));
  const bo = V.describeStudioError(
    e('PUB_BLOCKERS_OPEN', 409, {
      blockers: [
        { code: 'reddit_policy_block', id: 'qa1' },
        { code: 'reddit_pii' },
      ],
    }),
    t,
    r
  );
  assert.ok(
    bo.lines.includes(r.studio.blockers.reddit_pii),
    JSON.stringify(bo)
  );
  // §9.6: `reddit_policy_block {codes}` — причины проверки словами.
  const pb = V.describeStudioError(
    e('PUB_BLOCKERS_OPEN', 409, {
      blockers: [
        {
          code: 'reddit_policy_block',
          codes: ['reddit_disclosure_missing', 'reddit_unverified_claim'],
        },
      ],
    }),
    t,
    r
  );
  assert.ok(
    pb.lines.includes(r.studio.blockers.reddit_disclosure_missing),
    JSON.stringify(pb)
  );
  assert.ok(pb.lines.includes(r.studio.blockers.reddit_unverified_claim));
  // §9.7: новые WARN при копировании → коды для подтверждения.
  assert.deepEqual(
    V.copyWarningCodes(
      e('PUB_CONFLICT', 409, {
        reason: 'warnings_not_acknowledged',
        codes: ['reddit_duplicate', 'reddit_duplicate'],
      })
    ),
    ['reddit_duplicate']
  );
  assert.equal(
    V.copyWarningCodes(e('PUB_CONFLICT', 409, { currentRevision: 2 })),
    null
  );
  assert.equal(V.copyWarningCodes(new Error('x')), null);
  // §9.3/§9.8: бриф не ready при заморозке; ПД в meta — подпись поля словами.
  const fr = V.describeStudioError(
    e('PUB_BRIEF_NOT_READY', 409, { missing: ['brief_ready', 'brand'] }),
    t,
    r
  );
  assert.ok(fr.lines.includes(r.briefs.missing.brand));
  const pii = V.describeStudioError(
    e('PUB_VALIDATION', 400, {
      fields: [
        { field: 'meta.claimMap[1].text', code: 'pii' },
        { field: 'meta.uncertainties[0]', code: 'profile_ref' },
      ],
    }),
    t,
    r
  );
  const pj = pii.lines.join(' | ');
  assert.ok(
    pj.includes(r.studio.evidence.title) &&
      pj.includes(r.studio.generate.uncertainties),
    pj
  );
  assert.ok(
    !/meta\.|claimMap|uncertainties\[/.test(pj),
    `сырое имя поля: ${pj}`
  );
  assert.deepEqual(
    V.describeStudioError(
      e('PUB_TRANSITION_INVALID', 409, {
        reason: 'not_copied',
        from: 'approved',
      }),
      t,
      r
    ).lines,
    [r.studio.notCopied]
  );
  assert.deepEqual(
    V.describeStudioError(
      e('PUB_TRANSITION_INVALID', 409, { hint: 'submit_first' }),
      t,
      r
    ).lines,
    [r.studio.submitFirst]
  );
  assert.deepEqual(
    V.describeStudioError(
      e('PUB_CONFLICT', 409, {
        reason: 'already_published',
        publicationId: 'p1',
      }),
      t,
      r
    ).lines,
    [t.errors.conflictReasons.already_published]
  );
  assert.deepEqual(
    V.describeStudioError(
      e('PUB_TRANSITION_INVALID', 409, {
        machine: 'ai_task',
        from: 'done',
        to: 'generate',
      }),
      t,
      r
    ).lines,
    [r.studio.generate.taskClosed]
  );
  assert.ok(V.isManualPath(e('PUB_AI_DISABLED', 409, { manual: true })));
  assert.ok(V.isManualPath(e('PUB_AI_UNAVAILABLE', 503, {})));
  assert.ok(!V.isManualPath(e('PUB_BRIEF_NOT_READY', 409, {})));
  assert.ok(!V.isManualPath(new Error('x')));
  // Подсказка ручного пути: AI недоступен заранее или вызов отказал.
  assert.equal(
    V.manualPathShown(
      { available: true },
      e('PUB_AI_DISABLED', 409, { manual: true })
    ),
    true
  );
  assert.equal(V.manualPathShown({ available: false }, null), true);
  assert.equal(V.manualPathShown({ available: true }, null), false);
  assert.equal(
    V.manualPathShown({ available: true }, e('PUB_BRIEF_NOT_READY', 409, {})),
    false
  );
}

// ═══ 10. Копирование и рендер ════════════════════════════════════════════
{
  const exact = '  Disclosure: I am the founder.\n\n**b** <i>x</i>\t\n';
  const g = globalThis as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let got: string | null = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (s: string) => void (got = s) } },
  });
  assert.equal(await copyText(exact), true);
  assert.equal(got, exact, 'копируется ровно утверждённая строка');
  // Без Clipboard API и без DOM — честное «не удалось».
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    },
  });
  assert.equal(g.document, undefined);
  assert.equal(await copyText(exact), false);
  if (desc) Object.defineProperty(globalThis, 'navigator', desc);

  const ctx = {
    siteId: 's1',
    product: { id: 'pid1', features: { reddit: true } },
    roles: { roles: ['owner'], admin: false, accountOwner: false },
    can: () => true,
    reloadProduct: () => undefined,
    http: {},
    aiHttp: {},
    locale: 'uk',
    t: pubUk,
    href: () => '#',
    go: () => undefined,
    memberId: 'm1',
  } as unknown as PublisherValue;
  const html = (el: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(
      createElement(PublisherContext.Provider, { value: ctx }, el)
    );
  const XSS =
    '<img src=x onerror="window.__xss=1"><script>alert(1)</script> **жирний** [l](javascript:alert(2)) ![i](https://x/i.png)\n\n- a\n\n> q';
  const pv = html(createElement(MarkdownPreview, { text: XSS }));
  assert.ok(!/<img|<script|<a\b|href=|<iframe/i.test(pv), pv);
  assert.ok(pv.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), pv);
  assert.ok(pv.includes('<strong>жирний</strong>'), pv);
  assert.ok(pv.includes('[l](javascript:alert(2))'));
  assert.ok(pv.includes(r.studio.preview.note), 'пометка «приблизно»');
  assert.ok(/<blockquote/.test(pv) && /<ul/.test(pv));
  const cb = html(
    createElement(CopyBlock, {
      label: 'L',
      text: exact,
      buttonLabel: r.studio.copy.copyBody,
    })
  );
  assert.ok(/<pre[^>]*data-reddit-approved/.test(cb));
  assert.ok(
    cb.includes('&lt;i&gt;x&lt;/i&gt;'),
    'текст как есть, без разметки'
  );
  assert.ok(cb.includes(r.studio.copy.copyBody));
  const wc = html(createElement(WordCount, { text: 'a b c' }));
  assert.ok(wc.includes('3 слів'), wc);
  const ea = html(
    createElement(StudioErrorAlert, {
      error: new ApiError('PUB_CONFLICT', 'x', 409, 'rq', {
        reason: 'warnings_not_acknowledged',
        codes: ['reddit_offensive'],
      }),
    })
  );
  assert.ok(ea.includes(r.studio.warnings.reddit_offensive), ea);
  assert.ok(!ea.includes(pubUk.common.reload));
}

// ═══ 11. Раунд 4 (аудит экранов M2) ═══════════════════════════════════════
{
  // S2-1: проверка дала A → при согласовании сервер видит A+B → 409 →
  // чекбоксы A и B → повтор РОВНО [A, B] (details.codes).
  const err409 = new ApiError('PUB_CONFLICT', 'x', 409, 'rq', {
    reason: 'warnings_not_acknowledged',
    codes: ['reddit_claim_needs_verification', 'reddit_duplicate'],
    warnings: [
      { code: 'reddit_claim_needs_verification', params: { claims: [1] } },
      { code: 'reddit_duplicate', params: {} },
    ],
    policyCheckId: 'qa-fresh',
  });
  const ack = V.ackWarningsOf(err409)!;
  assert.deepEqual(ack.codes, [
    'reddit_claim_needs_verification',
    'reddit_duplicate',
  ]);
  assert.equal(ack.policyCheckId, 'qa-fresh');
  assert.deepEqual(
    ack.warnings.map((w) => w.code),
    ack.codes
  );
  const onlyA = new Set(['reddit_claim_needs_verification']);
  assert.equal(V.approveAckBody('h', '', ack.codes, onlyA), null);
  assert.deepEqual(
    V.approveAckBody(
      'h',
      ' ok ',
      ack.codes,
      new Set([...onlyA, 'reddit_duplicate', 'x'])
    ),
    {
      versionHash: 'h',
      reason: 'ok',
      acknowledgedWarnings: [
        'reddit_claim_needs_verification',
        'reddit_duplicate',
      ],
    }
  );
  // Коды без детали — всё равно чекбокс.
  assert.deepEqual(
    V.ackWarningsOf(
      new ApiError('PUB_CONFLICT', 'x', 409, 'rq', {
        reason: 'warnings_not_acknowledged',
        codes: ['reddit_guarantee'],
      })
    )!.warnings,
    [{ code: 'reddit_guarantee' }]
  );
  const ev = V.describeStudioError(err409, pubUk, r);
  assert.equal(ev.title, r.studio.approve.warnTitle, 'не «є новіша версія»');
  assert.ok(
    ev.lines.some((l) => l.includes(r.studio.warnings.reddit_duplicate))
  );

  // S3-1: «перегенерировать абзац» — прочие абзацы байт-в-байт.
  const body =
    'Intro line  \r\n\r\n\r\nOld second\n\n    indented code line 1\n    indented code line 2\n\n\nTail  ';
  const ps = V.paragraphs(body);
  assert.equal(ps.length, 4);
  const out = V.replaceParagraph(body, 1, 'New second');
  assert.equal(out, body.replace('Old second', 'New second'));
  const sp = V.paragraphSpans(body);
  assert.equal(body.slice(sp[2].start, sp[2].end), ps[2]);
  assert.equal(V.replaceParagraph(body, 9, 'x'), body);

  // S3-4: находки — по коду и параметрам, без сырых кодов и чужого языка.
  for (const [l, d] of Object.entries(DICTS)) {
    const t1 = V.findingText(
      {
        code: 'reddit_disclosure_missing',
        params: { reason: 'no_brand', brand: 'Demo' },
      },
      'blocker',
      d
    );
    assert.ok(
      t1.includes('Demo') &&
        t1.startsWith(d.studio.blockers.reddit_disclosure_missing),
      `${l}: ${t1}`
    );
    const t2 = V.findingText(
      {
        code: 'reddit_unverified_claim',
        params: { found: ['300%', '$49'], claims: [0, 2] },
      },
      'blocker',
      d
    );
    assert.ok(t2.includes('300%, $49') && t2.includes('1, 3'), `${l}: ${t2}`);
    assert.equal(
      V.findingText({ code: 'reddit_new_thing' }, 'warning', d),
      d.studio.findings.other
    );
    const all = JSON.stringify([d.studio, d.briefs, d.publications]);
    assert.ok(
      !/needs_verification|reddit_[a-z_]+/.test(
        all.replace(/"reddit_[a-z_]+":/g, '')
      ),
      `${l}: сырые коды в текстах`
    );
  }

  // S3-5: дата — не раньше согласованной версии; тело — ISO (UTC).
  const now = new Date('2026-10-14T12:00:00Z');
  const mm = {
    contentType: 'post' as const,
    subreddit: 'saas',
    threadUrl: null,
  };
  assert.deepEqual(
    V.reportIssues(
      mm,
      'https://www.reddit.com/r/saas/comments/abc123/x',
      '1999-01-01T10:00',
      '',
      now,
      '2026-10-13T10:00:00.000Z'
    ).issues,
    ['before_material']
  );
  assert.deepEqual(
    V.reportIssues(
      mm,
      'https://www.reddit.com/r/saas/comments/abc123/x',
      '2026-10-14T09:00',
      '',
      now,
      '2026-10-13T10:00:00.000Z'
    ).issues,
    []
  );
  const rb = V.reportBody(
    ' https://www.reddit.com/r/saas/comments/abc123/x ',
    '2026-10-14T10:00',
    ' n '
  );
  assert.deepEqual(rb, {
    url: 'https://www.reddit.com/r/saas/comments/abc123/x',
    postedAt: new Date('2026-10-14T10:00').toISOString(),
    notes: 'n',
  });
  assert.ok(rb!.postedAt.endsWith('Z'), 'ISO UTC, не локальная строка');
  assert.equal(V.reportBody('u', '', ''), null);
  for (const d of Object.values(DICTS))
    assert.ok(d.studio.report.issues.before_material);

  // Права панелей (подсказка): копирование и отметка — только PO/OP.
  const st = {
    editDraft: false,
    newDraft: false,
    submit: false,
    approve: true,
    copy: true,
    report: true,
    unscheduleFirst: false,
  };
  assert.deepEqual(
    V.studioPanels(st, {
      canVersion: true,
      canApprove: false,
      canHandoff: false,
    }),
    {
      write: false,
      approve: false,
      copy: false,
      report: false,
    }
  );
  assert.deepEqual(
    V.studioPanels(st, {
      canVersion: false,
      canApprove: true,
      canHandoff: true,
    }),
    {
      write: false,
      approve: true,
      copy: true,
      report: true,
    }
  );

  // Рендер панелей.
  const ctx = {
    siteId: 's1',
    product: { id: 'pid1', features: { reddit: true } },
    roles: { roles: ['owner'], admin: false, accountOwner: false },
    can: () => true,
    reloadProduct: () => undefined,
    http: {},
    aiHttp: {},
    locale: 'uk',
    t: pubUk,
    href: () => '#',
    go: () => undefined,
    memberId: 'm1',
  } as unknown as PublisherValue;
  const html = (el: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(
      createElement(PublisherContext.Provider, { value: ctx }, el)
    );
  // Копирование: ровно строки ответа `copy`.
  const copy: S.RedditCopyView = {
    contentId: 'c1',
    versionId: 'v1',
    versionHash: 'a'.repeat(64),
    contentType: 'post',
    title: '  Title  with  spaces ',
    body: 'Line 1  \n\n```\ncode\n```\n\t<b>x</b>‍ ',
    flairSuggestion: null,
    disclosure: 'D',
    openUrl: 'https://www.reddit.com/r/saas/',
    copyToken: 't',
    copiedAt: '2026-10-14T09:00:00.000Z',
    scheduled: false,
    policyCheckId: 'q',
    rules: {
      snapshotId: 's',
      version: 2,
      checkedAt: '2026-10-13T09:00:00.000Z',
    },
  };
  const cr = html(createElement(CopyResult, { copy }));
  const pres = [
    ...cr.matchAll(/<pre[^>]*data-reddit-approved[^>]*>([\s\S]*?)<\/pre>/g),
  ].map((x) =>
    x[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
  );
  assert.deepEqual(
    pres,
    [copy.title, copy.body],
    'показан ровно утверждённый текст'
  );
  assert.ok(
    /tabindex="0"/.test(cr) && /role="region"/.test(cr),
    'прокручиваемая область с фокусом (S3-7)'
  );
  // Согласование при BLOCK невозможно: кнопка недоступна, чекбоксов нет.
  const ver = {
    id: 'v2',
    hash: 'h'.repeat(64),
    authorMemberId: 'm2',
  } as unknown as VersionView;
  const qa = (over: Record<string, unknown>) => ({
    id: 'qa',
    versionId: 'v2',
    kind: 'reddit_policy',
    result: 'pass',
    blockers: [],
    warnings: [],
    checkedBy: 'system:reddit-policy',
    checkedAt: '2026-10-14T09:00:00.000Z',
    selfReview: false,
    aiCallId: null,
    ...over,
  });
  const mat = (check: unknown) =>
    ({ policyCheck: check }) as unknown as S.RedditMaterialView;
  const blocked = html(
    createElement(ApprovePanel, {
      m: mat(
        qa({
          result: 'fail',
          blockers: [{ code: 'reddit_pii', text: 'reddit_pii', params: {} }],
        })
      ),
      v: ver,
      onDone: () => undefined,
    })
  );
  const btn = (h: string) =>
    (h.match(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*Погодити(?:(?!<\/button>)[\s\S])*<\/button>/
    ) ?? [''])[0];
  assert.ok(
    /disabled=""/.test(btn(blocked)),
    `при BLOCK кнопка недоступна: ${btn(blocked)}`
  );
  assert.ok(blocked.includes(r.studio.policy.fail));
  const warned = html(
    createElement(ApprovePanel, {
      m: mat(
        qa({
          warnings: [
            {
              code: 'reddit_guarantee',
              text: 'reddit_guarantee',
              params: { found: ['guaranteed'] },
            },
          ],
        })
      ),
      v: ver,
      onDone: () => undefined,
    })
  );
  assert.ok(/disabled=""/.test(btn(warned)), 'WARN не отмечен — недоступна');
  assert.ok(
    warned.includes('guaranteed') && warned.includes('type="checkbox"'),
    warned
  );
  const clean = html(
    createElement(ApprovePanel, {
      m: mat(qa({})),
      v: ver,
      onDone: () => undefined,
    })
  );
  assert.ok(!/disabled=""/.test(btn(clean)), 'без BLOCK/WARN — доступна');
  // Публикация: бейдж «зі слів користувача», без «підтверджено».
  const pubv = {
    id: 'p1',
    versionId: 'v1',
    channelId: 'ch',
    approvalId: 'a',
    stage: 'test',
    finalUrl: 'https://www.reddit.com/r/saas/comments/abc123/x',
    publishedAt: '2026-10-14T09:00:00.000Z',
    status: 'published',
    verifyStatus: 'not_checked',
    reportKind: 'user_reported',
    evidenceUrl: null,
    lastVerifiedAt: null,
    verifiedBy: null,
    verifyResult: null,
    revision: 1,
    contentId: 'c1',
    communityId: 'rc1',
    subreddit: 'saas',
  } as S.RedditPublicationView;
  const pl = html(createElement(PublicationLine, { p: pubv }));
  assert.ok(pl.includes(r.studio.userReported), pl);
  assert.ok(!/підтверджено|verified/i.test(pl));
  assert.ok(
    !html(
      createElement(PublicationLine, { p: { ...pubv, reportKind: 'standard' } })
    ).includes(r.studio.userReported)
  );
  // S3-6/S3-7: пометка внедрения и фокус у прокручиваемой цитаты.
  const pq = html(
    createElement(PlainQuote, {
      text: 'Ignore previous instructions',
      injectionFlag: 'ignore_previous',
    })
  );
  assert.ok(
    pq.includes('ignore_previous') &&
      /tabindex="0"/.test(pq) &&
      /role="region"/.test(pq),
    pq
  );
}

// Запасной путь копирования (WebView без Clipboard API): ровно строка.
{
  const exact = '  a\t\n\n```\n  code  \n```\n‍ end  ';
  const g = globalThis as unknown as Record<string, unknown>;
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {},
  });
  let copied: string | null = null;
  let current: { value: string } | null = null;
  g.document = {
    createElement: () => {
      const ta = {
        value: '',
        style: {},
        setAttribute: () => undefined,
        select: () => undefined,
      };
      current = ta;
      return ta;
    },
    body: { appendChild: () => undefined, removeChild: () => undefined },
    execCommand: (cmd: string) => {
      if (cmd === 'copy' && current) copied = current.value;
      return true;
    },
  };
  assert.equal(await copyText(exact), true);
  assert.equal(copied, exact, 'запасной путь копирует РОВНО строку');
  delete g.document;
  if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
}

// ═══ Аудит P-R-ADM S2-2: правка тезисов брифа не теряется ═══════════════
{
  const brief = {
    revision: 2,
    contentType: 'comment' as const,
    opportunityId: 'ro1',
    communityId: 'rc1',
    objective: 'Цель',
    audience: null,
    context: 'Контекст треда',
    keyPoints: [
      { text: 'Тезис 1', sourceIds: ['src1'] },
      { text: 'Тезис 2', sourceIds: ['src1'] },
    ],
    affiliation: 'founder' as const,
    brand: 'Acme',
    linksAllowed: false,
    tone: null,
    language: 'en',
    constraints: [],
    forbiddenClaims: [],
    cta: null,
  } as unknown as S.RedditBriefView;
  const base = V.briefForm(brief);
  // 1) только текст тезиса 2 — тело с тезисами (раньше: null, «Сохранить» недоступна).
  const onlyKp = {
    ...base,
    keyPoints: base.keyPoints.map((k, i) =>
      i === 1 ? { ...k, text: 'Тезис 2 (правка)' } : k
    ),
  };
  assert.deepEqual(changedKeys(base, onlyKp), ['keyPoints']);
  assert.deepEqual(V.briefPatchBody(brief, onlyKp, base), {
    expectedRevision: 2,
    keyPoints: [
      { text: 'Тезис 1', sourceIds: ['src1'] },
      { text: 'Тезис 2 (правка)', sourceIds: ['src1'] },
    ],
  });
  // Источник тезиса и «нужна проверка» — тоже правка.
  const srcKp = {
    ...base,
    keyPoints: base.keyPoints.map((k, i) =>
      i === 0 ? { ...k, sources: 'src1, src2' } : k
    ),
  };
  assert.ok(changedKeys(base, srcKp).includes('keyPoints'));
  const nvKp = {
    ...base,
    keyPoints: base.keyPoints.map((k, i) =>
      i === 0 ? { ...k, needsVerification: true } : k
    ),
  };
  assert.ok(changedKeys(base, nvKp).includes('keyPoints'));
  // Порядок тезисов значим (это не множество).
  const swapped = {
    ...base,
    keyPoints: [base.keyPoints[1], base.keyPoints[0]],
  };
  assert.ok(changedKeys(base, swapped).includes('keyPoints'));
  // Множества строк — по-прежнему без учёта порядка.
  assert.deepEqual(changedKeys({ ids: ['a', 'b'] }, { ids: ['b', 'a'] }), []);
  // 2) цель + тезис — оба поля в теле.
  const both = { ...onlyKp, objective: 'Новая цель' };
  const pb = V.briefPatchBody(brief, both, base);
  assert.equal(pb?.objective, 'Новая цель');
  assert.equal(pb?.keyPoints?.[1].text, 'Тезис 2 (правка)');
  // 3) 409 → перечитали: сервер правил тезисы иначе — конфликт, правка пользователя цела.
  const fresh = {
    ...base,
    keyPoints: base.keyPoints.map((k, i) =>
      i === 1 ? { ...k, text: 'Тезис 2 (чужая правка)' } : k
    ),
  };
  const rb = rebaseForm(base, onlyKp, fresh);
  assert.equal(
    rb.mine.keyPoints[1].text,
    'Тезис 2 (правка)',
    'ввод не потерян'
  );
  assert.deepEqual(
    rb.conflicts.map((c) => c.key),
    ['keyPoints'],
    'конфликт показан'
  );
  // Сервер правил ДРУГОЕ поле — тезисы пользователя остаются, конфликта нет.
  const rb2 = rebaseForm(base, onlyKp, { ...base, objective: 'Цель (сервер)' });
  assert.equal(rb2.mine.objective, 'Цель (сервер)');
  assert.equal(rb2.mine.keyPoints[1].text, 'Тезис 2 (правка)');
  assert.deepEqual(rb2.conflicts, []);
}

// ═══ Аудит P-R-ADM S3-2/S3-4/S3-5, S2-1 (тексты) ═══════════════════════════
{
  assert.equal(V.generationClosed([{ aiCallId: null }]), false);
  assert.equal(
    V.generationClosed([{ aiCallId: null }, { aiCallId: 'aic_1' }]),
    true
  );
  const br = { updatedAt: '2026-10-14T10:00:00.000Z' };
  assert.equal(
    V.variantsStale({ requestedAt: '2026-10-14T09:00:00.000Z' }, br),
    true
  );
  assert.equal(
    V.variantsStale({ requestedAt: '2026-10-14T11:00:00.000Z' }, br),
    false
  );
  assert.equal(V.variantsStale(null, br), false);
  const content = (status: string) =>
    ({ status }) as unknown as S.RedditMaterialView['content'];
  assert.equal(
    V.approvalRevoked({ content: content('approved'), approvedVersion: null }),
    true
  );
  assert.equal(
    V.approvalRevoked({
      content: content('approved'),
      approvedVersion: {} as VersionView,
    }),
    false
  );
  assert.equal(
    V.approvalRevoked({ content: content('drafting'), approvedVersion: null }),
    false
  );
  // Отзыв после копирования (`scheduled`): тоже «отозвано», отметку не предлагаем.
  assert.equal(
    V.approvalRevoked({ content: content('scheduled'), approvedVersion: null }),
    true
  );
  assert.equal(
    V.approvalRevoked({
      content: content('scheduled'),
      approvedVersion: null,
      approval: null,
    }),
    true
  );
  assert.equal(
    V.approvalRevoked({
      content: content('scheduled'),
      approvedVersion: null,
      approval: {
        id: 'ap1',
        versionId: 'v1',
        status: 'active',
        selfReview: false,
        decidedAt: '2026-10-14T10:00:00.000Z',
      },
    }),
    false
  );
  const stepsOf = (status: string, approved: boolean) =>
    V.materialSteps({
      content: { status } as unknown as S.RedditMaterialView['content'],
      currentVersion: null,
      approvedVersion: approved ? ({ id: 'v1' } as VersionView) : null,
    });
  assert.equal(stepsOf('scheduled', true).report, true);
  assert.equal(
    stepsOf('scheduled', false).report,
    false,
    'после отзыва — без отметки (иначе not_copied)'
  );
  assert.equal(stepsOf('scheduled', false).copy, false);
  assert.equal(
    stepsOf('scheduled', false).unscheduleFirst,
    true,
    'путь: снять с плана → новая версия'
  );
  assert.equal(stepsOf('published', false).report, true);
  assert.equal(
    actorLabel('admin:abcdefghijkl', pubUk.common.adminActor),
    'оператор Адмінки …ghijkl'
  );
  assert.equal(
    actorLabel('admin:caudop1aaaaaaaaaaaaaaaaaa', pubUk.common.adminActor),
    'оператор Адмінки …aaaaaa'
  );
  assert.equal(actorLabel('member:m123456789'), '…456789');
  assert.equal(actorLabel('system'), 'system');
  const notOpen = describePubError(
    new ApiError('PUB_AI_BUDGET', 'x', 409, undefined, {
      reason: 'month_not_open',
    }),
    pubUk
  );
  assert.equal(notOpen.title, pubUk.errors.aiBudgetReasons.month_not_open);
  assert.ok(
    !notOpen.lines.some((l) => l.includes('month_not_open')),
    'без сырого кода'
  );
  const capped = describePubError(
    new ApiError('PUB_AI_BUDGET', 'x', 409, undefined, {
      reason: 'cap_exhausted',
    }),
    pubUk
  );
  assert.equal(capped.title, pubUk.errors.aiBudgetReasons.cap_exhausted);
  assert.notEqual(notOpen.title, capped.title, '«не открыт» ≠ «исчерпан»');
}

// Аудит ui-10 (15.10.2026): «сравнить с» ≠ выбранной и есть в списке.
{
  const ids = ['v1', 'v2'];
  assert.equal(V.diffPartner('v2', 'v1', ids), 'v1');
  assert.equal(V.diffPartner('v2', 'v2', ids), '');
  assert.equal(V.diffPartner('v2', 'v7', ids), '');
  assert.equal(V.diffPartner(undefined, 'v1', ids), '');
}

console.log('publisher-reddit-studio: ok');
