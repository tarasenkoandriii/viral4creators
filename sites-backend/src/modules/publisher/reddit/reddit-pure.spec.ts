/**
 * P-R M1 — чистые функции (reddit-manual-mvp-adapted.md §M1.6 «Unit»):
 * нормализация `r/name` и URL треда, `snapshotState`, `policyGate` (таблица
 * §M1.3 построчно), `policyRisk`, score v1 (векторы формул), отказ импорта
 * для хостов Reddit до сети.
 */
import { preNetworkReason } from '../content/source-import';
import {
  canonicalCommunityUrl,
  hasProfileRef,
  isRedditHost,
  normalizeSubreddit,
  normalizeThreadUrl,
  subredditIssue,
  threadUrlIssue,
  phraseNorm,
} from './normalize';
import {
  policyGate,
  policyRisk,
  policyRiskReasons,
  snapshotState,
  staleDaysOf,
  type PolicySnapshot,
} from './policy';
import {
  computeScore,
  emptyFactors,
  factorsFromJson,
  mergeFactors,
} from './score';

const NOW = new Date('2026-10-13T12:00:00.000Z');
/** Тестовые сутки (NOW и NOW − 30 дн. — оба летнее время Kyiv). */
const DAY_MS = 86_400_000;
const snap = (o: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  reviewState: 'reviewed',
  checkedAt: new Date(NOW.getTime() - DAY_MS),
  promotionPolicy: 'allowed_with_conditions',
  linksPolicy: 'allowed',
  ...o,
});

describe('normalize: r/name', () => {
  it.each([
    ['r/SaaS', 'saas'],
    ['/r/smallbusiness/', 'smallbusiness'],
    ['Entrepreneur', 'entrepreneur'],
    ['  r/web_design ', 'web_design'],
    ['https://www.reddit.com/r/SaaS/', 'saas'],
    ['https://old.reddit.com/r/shopify/top/?t=week', 'shopify'],
    ['m.reddit.com/r/WordPress', 'wordpress'],
    ['reddit.com/r/ab', 'ab'],
  ])('%s → %s', (input, out) => {
    expect(normalizeSubreddit(input)).toBe(out);
  });

  it.each([
    'r/a',
    'r/has-dash',
    'r/' + 'x'.repeat(22),
    'https://redd.it/abc',
    'http://www.reddit.com/r/saas',
    'https://www.reddit.com/user/someone',
    'https://evil.example/r/saas',
    'r/saas/extra',
    '',
    null,
    42,
  ])('%p → null', (input) => {
    expect(normalizeSubreddit(input)).toBeNull();
  });

  it('канонический URL сообщества — без завершающего /', () => {
    expect(canonicalCommunityUrl('saas')).toBe('https://www.reddit.com/r/saas');
  });
});

describe('normalize: URL треда', () => {
  it.each([
    [
      'https://www.reddit.com/r/SaaS/comments/1G2H3J/best_chat_widget/',
      'https://www.reddit.com/r/saas/comments/1g2h3j/best_chat_widget',
    ],
    [
      'https://old.reddit.com/r/saas/comments/abc12/x/?utm_source=share&utm_medium=web#c1',
      'https://www.reddit.com/r/saas/comments/abc12/x',
    ],
    [
      'www.reddit.com/r/saas/comments/abc12',
      'https://www.reddit.com/r/saas/comments/abc12',
    ],
    [
      'https://www.reddit.com/r/saas/comments/abc12/x/kq1z2y3/',
      'https://www.reddit.com/r/saas/comments/abc12/x',
    ],
    [
      'https://np.reddit.com/r/saas/comments/abc12/x',
      'https://www.reddit.com/r/saas/comments/abc12/x',
    ],
  ])('%s → канон', (input, url) => {
    const t = normalizeThreadUrl(input);
    expect(t?.url).toBe(url);
    expect(t?.subreddit).toBe('saas');
  });

  it.each([
    'https://redd.it/abc12',
    'http://www.reddit.com/r/saas/comments/abc12/x',
    'https://www.reddit.com/r/saas/s/AbCdEf12',
    'https://www.reddit.com/r/saas/',
    'https://www.reddit.com/user/x/comments/abc12/x',
    'https://www.reddit.com/r/saas/comments/ab-c/x',
    'https://www.reddit.com:8443/r/saas/comments/abc12/x',
    'https://user:pass@www.reddit.com/r/saas/comments/abc12/x',
    'https://reddit.example.com/r/saas/comments/abc12/x',
    'javascript:alert(1)',
  ])('%s → null', (input) => {
    expect(normalizeThreadUrl(input)).toBeNull();
  });

  it('threadKey — id36 в нижнем регистре', () => {
    expect(
      normalizeThreadUrl('https://www.reddit.com/r/saas/comments/ABC123/x')
        ?.threadKey,
    ).toBe('abc123');
  });

  it('хосты Reddit (импорт по URL отклоняется до сети: reddit_manual_only)', () => {
    for (const h of [
      'reddit.com',
      'www.reddit.com',
      'old.reddit.com',
      'redd.it',
      'v.redd.it',
      'i.redditmedia.com',
      'www.redditstatic.com',
      'REDDIT.COM.',
    ])
      expect(isRedditHost(h)).toBe(true);
    for (const h of ['notreddit.com', 'reddit.com.evil.example', 'example.com'])
      expect(isRedditHost(h)).toBe(false);
    expect(preNetworkReason('https://www.reddit.com/r/saas')).toBe(
      'reddit_manual_only',
    );
    expect(preNetworkReason('http://redd.it/abc')).toBe('reddit_manual_only');
    expect(preNetworkReason('https://i.redditmedia.com/x.png')).toBe(
      'reddit_manual_only',
    );
    expect(preNetworkReason('https://example.com/')).toBeNull();
  });

  it('нормальная форма ключевого запроса', () => {
    expect(phraseNorm('  AI   Chat\tWidget ')).toBe('ai chat widget');
  });
});

describe('policy: snapshotState и staleDays', () => {
  it('unreviewed / reviewed / stale по checkedAt + staleDays', () => {
    expect(snapshotState(snap({ reviewState: 'unreviewed' }), NOW, 30)).toBe(
      'unreviewed',
    );
    expect(snapshotState(snap(), NOW, 30)).toBe('reviewed');
    const edge = snap({ checkedAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    expect(snapshotState(edge, NOW, 30)).toBe('reviewed');
    const over = snap({ checkedAt: new Date(NOW.getTime() - 30 * DAY_MS - 1) });
    expect(snapshotState(over, NOW, 30)).toBe('stale');
    expect(snapshotState(over, NOW, 31)).toBe('reviewed');
    // Через переход на зимнее время (25.10.2026, Kyiv): 30 календарных дней —
    // тот же час по Kyiv, а не 30 × 24 ч.
    const t0 = new Date('2026-10-20T09:00:00.000Z'); // 12:00 Kyiv (UTC+3)
    const due = new Date('2026-11-19T10:00:00.000Z'); // 12:00 Kyiv (UTC+2)
    expect(snapshotState(snap({ checkedAt: t0 }), due, 30)).toBe('reviewed');
    expect(
      snapshotState(snap({ checkedAt: t0 }), new Date(due.getTime() + 1), 30),
    ).toBe('stale');
  });

  it('значение параметра: 1..365 целое, иначе умолчание 30', () => {
    expect(staleDaysOf({ days: 7 })).toBe(7);
    for (const v of [
      null,
      {},
      { days: 0 },
      { days: 366 },
      { days: 1.5 },
      { days: '7' },
    ])
      expect(staleDaysOf(v)).toBe(30);
  });
});

describe('policy: policyGate — таблица §M1.3 построчно', () => {
  const g = (s: PolicySnapshot | null, hasLinks = false) =>
    policyGate(s, NOW, 30, 'comment', hasLinks);

  it('снимка нет → block rules_missing', () => {
    expect(g(null)).toEqual({
      verdict: 'block',
      reasons: ['rules_missing'],
      warnings: [],
    });
  });
  it('unreviewed → block rules_unreviewed', () => {
    expect(g(snap({ reviewState: 'unreviewed' }))).toMatchObject({
      verdict: 'block',
      reasons: ['rules_unreviewed'],
    });
  });
  it('stale → recheck_required rules_stale', () => {
    expect(
      g(snap({ checkedAt: new Date(NOW.getTime() - 31 * DAY_MS) })),
    ).toEqual({
      verdict: 'recheck_required',
      reasons: ['rules_stale'],
      warnings: [],
    });
  });
  it('promotion prohibited → block; unknown → block; links unknown → block', () => {
    expect(g(snap({ promotionPolicy: 'prohibited' }))).toMatchObject({
      verdict: 'block',
      reasons: ['promotion_prohibited'],
    });
    expect(g(snap({ promotionPolicy: 'unknown' }))).toMatchObject({
      verdict: 'block',
      reasons: ['promotion_unknown'],
    });
    expect(g(snap({ linksPolicy: 'unknown' }))).toMatchObject({
      verdict: 'block',
      reasons: ['links_unknown'],
    });
  });
  it('links prohibited: со ссылкой → block, без ссылки → ok', () => {
    expect(g(snap({ linksPolicy: 'prohibited' }), true)).toMatchObject({
      verdict: 'block',
      reasons: ['links_prohibited'],
    });
    expect(g(snap({ linksPolicy: 'prohibited' }), false)).toEqual({
      verdict: 'ok',
      reasons: [],
      warnings: [],
    });
  });
  it('links restricted со ссылкой → ok + WARN links_restricted', () => {
    expect(g(snap({ linksPolicy: 'restricted' }), true)).toEqual({
      verdict: 'ok',
      reasons: [],
      warnings: ['links_restricted'],
    });
  });
  it('stale + prohibited → block (блокирующая причина сильнее), причины — все', () => {
    expect(
      g(
        snap({
          promotionPolicy: 'prohibited',
          checkedAt: new Date(NOW.getTime() - 99 * DAY_MS),
        }),
      ),
    ).toMatchObject({
      verdict: 'block',
      reasons: ['rules_stale', 'promotion_prohibited'],
    });
  });

  it('policyRisk: allowed 20, restricted 50, prohibited 60; unknown/prohibited promotion/нет снимка — 100', () => {
    expect(policyRisk(snap())).toBe(20);
    expect(policyRisk(snap({ linksPolicy: 'restricted' }))).toBe(50);
    expect(policyRisk(snap({ linksPolicy: 'prohibited' }))).toBe(60);
    expect(policyRisk(snap({ linksPolicy: 'unknown' }))).toBe(100);
    expect(policyRisk(snap({ promotionPolicy: 'unknown' }))).toBe(100);
    expect(policyRisk(snap({ promotionPolicy: 'prohibited' }))).toBe(100);
    expect(policyRisk(null)).toBe(100);
  });
});

describe('score v1: формулы и «не рассчитано»', () => {
  const full = (v: Record<string, number | null>) => {
    const f = emptyFactors();
    for (const [k, x] of Object.entries(v))
      f[k as keyof typeof f] = { value: x, why: x === null ? null : 'w' };
    return f;
  };

  it('вектор: relevance = round(.35·80 + .25·60 + .2·50 + .2·40) = 61; risk = round(.4·20 + .25·30 + .2·10 + .15·50) = 25; priority = round(61·.75) = 46', () => {
    expect(
      computeScore(
        full({
          topic_fit: 80,
          intent_fit: 60,
          audience_fit: 50,
          answerability: 40,
          policy_risk: 20,
          promotionality: 30,
          evidence_gap: 10,
          context_uncertainty: 50,
        }),
      ),
    ).toEqual({
      scoreVersion: 'v1',
      relevance: 61,
      risk: 25,
      priority: 46,
      missing: [],
    });
  });

  it('округление «половина вверх» без float: .35·1 + .25·1 = .6 → 1; 0.5 → 1', () => {
    expect(
      computeScore(
        full({
          topic_fit: 1,
          intent_fit: 1,
          audience_fit: 0,
          answerability: 0,
          policy_risk: 0,
          promotionality: 2,
          evidence_gap: 0,
          context_uncertainty: 0,
        }),
      ),
    ).toMatchObject({ relevance: 1, risk: 1 });
  });

  it('null в группе → группа null, фактор в missing (порядок списка факторов), priority null', () => {
    const r = computeScore(
      full({
        topic_fit: 90,
        intent_fit: null,
        audience_fit: 90,
        answerability: 90,
        policy_risk: 20,
        promotionality: 0,
        evidence_gap: null,
        context_uncertainty: 0,
      }),
    );
    expect(r).toEqual({
      scoreVersion: 'v1',
      relevance: null,
      risk: null,
      priority: null,
      missing: ['intent_fit', 'evidence_gap'],
    });
  });

  it('mergeFactors: policy_risk всегда из снимка; ввод сливается по ключам; jsonb без мусора', () => {
    const m = mergeFactors(
      factorsFromJson({ topic_fit: { value: 10, why: 'a' }, junk: 1 }),
      { intent_fit: { value: 20, why: 'b' } },
      60,
      ['promotion_allowed_with_conditions', 'links_prohibited'],
    );
    expect(m.topic_fit).toEqual({ value: 10, why: 'a' });
    expect(m.intent_fit).toEqual({ value: 20, why: 'b' });
    expect(m.policy_risk).toEqual({
      value: 60,
      why: null,
      reasons: ['promotion_allowed_with_conditions', 'links_prohibited'],
    });
    expect(Object.keys(m)).toHaveLength(8);
  });
});

describe('аудит P-R: ники, r/u_*, отзыв первоисточника, коды policy_risk', () => {
  it.each([
    'see /user/john_doe here',
    'by u/john_doe',
    'by u／john_doe',
    '(/u/john_doe)',
    'https://www.reddit.com/user/john_doe',
    'old.reddit.com/u/x',
    'check r/u_john_doe',
    'Ask u/AutoModerator',
    // Реаудит N-4: граница слова и знаки, похожие на «/».
    'see/user/john_doe',
    'x_u/john_doe',
    'example.com/user/abc',
    'смотри u/john_doe',
    'by u\u2215john_doe',
    'by u\u2044john_doe',
    'by u\u29F8john_doe',
    'by u\uFF0Fjohn_doe',
    'by u\u2571john_doe',
    'by user\u2215john_doe',
    'r\u2215u_john',
    'by u\u200B/john_doe',
    'by u/\u00ADjohn_doe',
  ])('%s → ник/профиль', (t) => {
    expect(hasProfileRef(t)).toBe(true);
  });

  it.each([
    'use the menu/user settings',
    'Q&A about SaaS',
    'r/saas thread',
    'you/me and lieu/abcd',
    'bar/u_john',
    'u\u2215ab',
    null,
  ])('%p → не ник', (t) => {
    expect(hasProfileRef(t)).toBe(false);
  });

  it('r/u_* — не сообщество и не тред', () => {
    expect(normalizeSubreddit('r/u_john_doe')).toBeNull();
    expect(normalizeSubreddit('https://www.reddit.com/r/u_john/')).toBeNull();
    expect(
      normalizeThreadUrl('https://www.reddit.com/r/u_john/comments/abc123/x'),
    ).toBeNull();
    expect(normalizeSubreddit('r/user_research')).toBe('user_research');
    // UI-аудит S3-2: код поля — `profile_ref`, прочее — `format`.
    for (const x of ['r/u_john', 'u_john', 'https://old.reddit.com/r/U_John'])
      expect(subredditIssue(x)).toBe('profile_ref');
    for (const x of ['r/a', 'r/has-dash', 'https://redd.it/x', 42])
      expect(subredditIssue(x)).toBe('format');
    expect(subredditIssue('r/user_research')).toBeNull();
    expect(
      threadUrlIssue('https://www.reddit.com/r/u_john/comments/abc123/x'),
    ).toBe('profile_ref');
    expect(threadUrlIssue('https://redd.it/abc123')).toBe('format');
    expect(
      threadUrlIssue('https://www.reddit.com/r/saas/comments/abc123/x'),
    ).toBeNull();
  });

  it('отозванный первоисточник → block rules_source_revoked (и при stale)', () => {
    expect(
      policyGate(snap({ sourceRevoked: true }), NOW, 30, 'comment', false),
    ).toEqual({
      verdict: 'block',
      reasons: ['rules_source_revoked'],
      warnings: [],
    });
  });

  it('policyRiskReasons — коды без текста', () => {
    expect(policyRiskReasons(null)).toEqual(['rules_missing']);
    expect(policyRiskReasons(snap({ linksPolicy: 'restricted' }))).toEqual([
      'promotion_allowed_with_conditions',
      'links_restricted',
    ]);
  });
});
