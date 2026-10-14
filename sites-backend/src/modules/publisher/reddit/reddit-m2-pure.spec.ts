/**
 * [AT-RD-07] [AT-RD-08] P-R M2 — чистые модули (reddit-manual-mvp-
 * adapted.md §M2.4, §M2.8 «Unit»): `checks.ts` построчно по таблице §M2.4,
 * маркеры текста, схема и проверки ответа `pub.reddit.draft`, hash версии с
 * `ruleSnapshotId`, канон URL отчёта о публикации, хосты Reddit, правила
 * брифа, срок ретенции.
 */
import {
  REDDIT_DRAFT,
  linksForbidden,
  redditFindings,
  renderThread,
  type RedditDraftInput,
} from '../ai/generators/reddit-draft.generator';
import { REDDIT_DRAFT_SCHEMA } from '../contracts/ai-schemas';
import { contentVersionHash } from '../core/content-hash';
import { checkRedditVersionMeta } from '../content/rules';
import { briefMissing, commentServiceTitle } from './brief-rules';
import {
  REDDIT_CHECK_BLOCKERS,
  REDDIT_CHECK_WARNINGS,
  redditChecks,
  type RedditCheckInput,
} from './checks';
import { paragraphsOf } from './generate.service';
import {
  disclosureIssue,
  disclosureVisible,
  firstPersonMarkers,
  guaranteesIn,
  hasCustomerQuote,
  hasLink,
  hasNumber,
  jaccard,
  linkFindings,
  normText,
  numbersIn,
  offensiveWords,
  wordSet,
} from './markers';
import { StandFakeModel } from '../ai/stand-fake-model';
import { isRedditHost, normalizeReportedUrl } from './normalize';
import { retentionDaysOf } from './retention.job';

const NOW = new Date('2026-10-14T10:00:00Z');
const D = "Disclosure: I'm the founder of Demo.";

function input(over: Partial<RedditCheckInput> = {}): RedditCheckInput {
  return {
    contentType: 'post',
    title: 'How to reuse one article',
    body: `${D}\n\nStart from one verified article.`,
    disclosure: D,
    flairSuggestion: null,
    claimMap: [{ text: 'One article → several formats', sourceIds: ['s1'] }],
    versionSnapshotId: 'snap1',
    brief: {
      brand: 'Demo',
      affiliation: 'founder',
      linksAllowed: false,
      forbiddenClaims: [],
    },
    snapshot: {
      id: 'snap1',
      reviewState: 'reviewed',
      checkedAt: new Date('2026-10-10T10:00:00Z'),
      promotionPolicy: 'allowed_with_conditions',
      linksPolicy: 'restricted',
      flairRequired: false,
    },
    now: NOW,
    staleDays: 30,
    thread: null,
    sources: new Map([['s1', { usage: 'allowed', origin: 'content' }]]),
    others: [],
    contextTexts: [],
    ...over,
  };
}
const codes = (i: RedditCheckInput) => {
  const r = redditChecks(i);
  return {
    result: r.result,
    b: r.blockers.map((x) => x.code),
    w: r.warnings.map((x) => x.code),
  };
};

describe('checks.ts — таблица §M2.4 построчно', () => {
  it('эталон: всё в порядке → pass без WARN', () => {
    expect(codes(input())).toEqual({ result: 'pass', b: [], w: [] });
  });

  it('правила: нет снимка / не проверен / устарел / первоисточник отозван / снимок версии ≠ текущему → BLOCK', () => {
    expect(codes(input({ snapshot: null })).b).toEqual([
      'reddit_rules_missing',
    ]);
    const snap = input().snapshot!;
    expect(
      codes(input({ snapshot: { ...snap, reviewState: 'unreviewed' } })).b,
    ).toEqual(['reddit_rules_unreviewed']);
    expect(
      codes(
        input({
          snapshot: { ...snap, checkedAt: new Date('2026-08-01T10:00:00Z') },
        }),
      ).b,
    ).toEqual(['reddit_rules_stale']);
    expect(
      codes(input({ snapshot: { ...snap, sourceRevoked: true } })).b,
    ).toEqual(['reddit_rules_source_revoked']);
    expect(codes(input({ versionSnapshotId: 'old' })).b).toEqual([
      'reddit_rules_changed',
    ]);
  });

  it('продвижение prohibited/unknown → BLOCK', () => {
    const snap = input().snapshot!;
    expect(
      codes(input({ snapshot: { ...snap, promotionPolicy: 'prohibited' } })).b,
    ).toEqual(['reddit_promotion_prohibited']);
    expect(
      codes(input({ snapshot: { ...snap, promotionPolicy: 'unknown' } })).b,
    ).toEqual(['reddit_promotion_unknown']);
  });

  it('ссылки: unknown → BLOCK всегда; prohibited + ссылка → BLOCK; restricted + ссылка → WARN; бриф linksAllowed=false + ссылка → BLOCK', () => {
    const snap = input().snapshot!;
    const link = `${D}\n\nSee demo-tools.com/guide`;
    expect(
      codes(input({ snapshot: { ...snap, linksPolicy: 'unknown' } })).b,
    ).toEqual(['reddit_links_unknown']);
    expect(
      codes(
        input({
          body: link,
          snapshot: { ...snap, linksPolicy: 'prohibited' },
          brief: {
            brand: 'Demo',
            affiliation: 'founder',
            linksAllowed: true,
            forbiddenClaims: [],
          },
        }),
      ).b,
    ).toEqual(['reddit_links_prohibited']);
    expect(
      codes(
        input({
          body: link,
          brief: {
            brand: 'Demo',
            affiliation: 'founder',
            linksAllowed: true,
            forbiddenClaims: [],
          },
        }),
      ),
    ).toEqual({ result: 'pass', b: [], w: ['reddit_links_restricted'] });
    expect(codes(input({ body: link })).b).toEqual([
      'reddit_links_not_allowed',
    ]);
    // ссылка в заголовке поста — тоже ссылка
    expect(codes(input({ title: 'www.demo-tools.com' })).b).toEqual([
      'reddit_links_not_allowed',
    ]);
  });

  it('[AT-RD-08] раскрытие: нет в первых 300 знаках / пустое / affiliation не задана → BLOCK; affiliation=none — не требуется', () => {
    const late = `${'x '.repeat(160)}${D}`;
    expect(codes(input({ body: late })).b).toEqual([
      'reddit_disclosure_missing',
    ]);
    expect(codes(input({ disclosure: '' })).b).toEqual([
      'reddit_disclosure_missing',
    ]);
    const nul = redditChecks(
      input({
        brief: {
          brand: 'Demo',
          affiliation: null,
          linksAllowed: false,
          forbiddenClaims: [],
        },
      }),
    );
    // раунд 4 (S3-4): машиночитаемые параметры, текст = код
    expect(nul.blockers[0]).toEqual({
      code: 'reddit_disclosure_missing',
      text: 'reddit_disclosure_missing',
      params: { reason: 'affiliation_missing' },
    });
    expect(
      codes(
        input({
          body: 'No affiliation here.',
          disclosure: '',
          brief: {
            brand: 'Demo',
            affiliation: 'none',
            linksAllowed: false,
            forbiddenClaims: [],
          },
        }),
      ).b,
    ).toEqual([]);
    expect(disclosureVisible(`  ${D.toUpperCase()} rest`, D)).toBe(true);
  });

  it('claimMap: needs_verification с числом/обещанием → BLOCK, без них → WARN; источник не allowed / не content / нет в продукте → BLOCK; запрещённое брифом утверждение → BLOCK', () => {
    expect(
      codes(
        input({
          claimMap: [
            { text: 'Saves 5 hours', sourceIds: 'needs_verification' },
          ],
        }),
      ).b,
    ).toEqual(['reddit_unverified_claim']);
    expect(
      codes(
        input({
          claimMap: [
            { text: 'Guaranteed growth', sourceIds: 'needs_verification' },
          ],
        }),
      ).b,
    ).toEqual(['reddit_unverified_claim']);
    expect(
      codes(
        input({
          claimMap: [
            { text: 'Ask the author', sourceIds: 'needs_verification' },
          ],
        }),
      ),
    ).toEqual({
      result: 'pass',
      b: [],
      w: ['reddit_claim_needs_verification'],
    });
    for (const st of [
      { usage: 'restricted', origin: 'content' },
      { usage: 'revoked', origin: 'content' },
      { usage: 'allowed', origin: 'reddit' },
    ])
      expect(codes(input({ sources: new Map([['s1', st]]) })).b).toEqual([
        'reddit_source_not_allowed',
      ]);
    expect(codes(input({ sources: new Map() })).b).toEqual([
      'reddit_source_not_allowed',
    ]);
    // Раунд 2 (Р-RD-80): гарантия без числа — WARN, запрет брифа — BLOCK.
    expect(
      codes(
        input({
          body: `${D}\n\nGuaranteed traffic for everyone.`,
          brief: {
            brand: 'Demo',
            affiliation: 'founder',
            linksAllowed: false,
            forbiddenClaims: ['guaranteed traffic'],
          },
        }),
      ),
    ).toEqual({
      result: 'fail',
      b: ['reddit_forbidden_claim'],
      w: ['reddit_guarantee'],
    });
  });

  it('[AT-RD-07] вымышленный отзыв: личный опыт (en/uk/ru) при affiliation≠customer → BLOCK; у customer — нет; цитата клиента без источника → BLOCK', () => {
    for (const t of [
      "I've been using Demo for a year.",
      'I bought it twice.',
      'It worked great for me.',
      'Я купив Демо і мені допомогло.',
      'Мой личный опыт с Демо отличный.',
    ])
      expect(codes(input({ body: `${D}\n\n${t}` })).b).toEqual([
        'reddit_fake_testimonial',
      ]);
    expect(
      codes(
        input({
          body: `${D}\n\nI've been using Demo for a year.`,
          brief: {
            brand: 'Demo',
            affiliation: 'customer',
            linksAllowed: false,
            forbiddenClaims: [],
          },
        }),
      ).b,
    ).toEqual([]);
    const quote = `${D}\n\nA customer told us: "it saved hours".`;
    expect(codes(input({ body: quote, claimMap: [] })).b).toEqual([
      'reddit_fake_testimonial',
    ]);
    expect(codes(input({ body: quote })).b).toEqual([]);
    expect(firstPersonMarkers('They tried several tools.')).toEqual([]);
    expect(hasCustomerQuote('клієнт сказав: «дякую»')).toBe(true);
  });

  it('ПД: телефон, email, ник u/…, профиль в title/body/disclosure → BLOCK reddit_pii', () => {
    expect(
      codes(input({ body: `${D}\n\nCall +380 67 123 45 67` })).b,
    ).toContain('reddit_pii');
    expect(codes(input({ title: 'Ask u/some_user' })).b).toEqual([
      'reddit_pii',
    ]);
    expect(
      codes(
        input({
          disclosure: 'mail me at a@b.co',
          body: 'mail me at a@b.co text',
        }),
      ).b,
    ).toContain('reddit_pii');
  });

  it('дубль (Жаккар ≥ 0,6 за 90 дней) и оскорбления → WARN; comment без треда/выдержки → BLOCK; флейр обязателен без предложения → WARN', () => {
    const i = input();
    expect(
      codes(
        input({ others: [{ versionId: 'v0', text: `${i.title}\n${i.body}` }] }),
      ).w,
    ).toEqual(['reddit_duplicate']);
    expect(codes(input({ body: `${D}\n\nDon't be an idiot.` })).w).toEqual([
      'reddit_offensive',
    ]);
    expect(
      codes(input({ contentType: 'comment', title: null, thread: null })).b,
    ).toEqual(['reddit_thread_missing']);
    expect(
      codes(
        input({
          contentType: 'comment',
          title: null,
          thread: {
            url: 'https://www.reddit.com/r/x/comments/abc',
            hasExcerpt: false,
          },
        }),
      ).b,
    ).toEqual(['reddit_thread_missing']);
    expect(
      codes(
        input({
          contentType: 'comment',
          title: null,
          thread: {
            url: 'https://www.reddit.com/r/x/comments/abc',
            hasExcerpt: true,
          },
        }),
      ).b,
    ).toEqual([]);
    const snap = input().snapshot!;
    expect(
      codes(input({ snapshot: { ...snap, flairRequired: true } })).w,
    ).toEqual(['reddit_flair_missing']);
    expect(
      codes(
        input({
          snapshot: { ...snap, flairRequired: true },
          flairSuggestion: 'Discussion',
        }),
      ).w,
    ).toEqual([]);
  });

  it('порядок кодов — порядок каталога; тексты без «соответствует правилам Reddit»', () => {
    const r = redditChecks(
      input({
        snapshot: null,
        disclosure: '',
        body: "I've been using it. Call +380 67 123 45 67",
      }),
    );
    const order = r.blockers.map((b) =>
      REDDIT_CHECK_BLOCKERS.indexOf(b.code as never),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(REDDIT_CHECK_WARNINGS).toHaveLength(10);
    expect(JSON.stringify(r)).not.toMatch(
      /відповідає правилам Reddit|соответствует правилам/,
    );
  });
});

describe('маркеры', () => {
  it('ссылки: URL, www, markdown, голый домен; email и версии — не ссылки', () => {
    for (const t of [
      'https://x.io/a',
      'www.example.org',
      '[docs](/guide)',
      'demo-tools.com/guide',
    ])
      expect(hasLink(t)).toBe(true);
    // голый «слово.зона» — «похоже на ссылку» (WARN), не ссылка (Р-RD-79)
    expect(linkFindings('see shop.ua')).toEqual({
      links: [],
      suspect: ['shop.ua'],
    });
    for (const t of ['a@b.com', 'version 1.2.3', 'e.g. this', 'Node.js'])
      expect(hasLink(t)).toBe(false);
  });

  it('Жаккар и словарь оскорблений', () => {
    expect(jaccard(wordSet('one two three'), wordSet('one two three'))).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(offensiveWords('ти ідіот')).toEqual(['ідіот']);
    expect(offensiveWords('a studious person')).toEqual([]);
  });
});

describe('pub.reddit.draft: схема, проверки против входа, находки, промпт', () => {
  const base: RedditDraftInput = {
    template: 'helpful_answer',
    contentType: 'comment',
    variants: 2,
    brief: {
      objective: 'Help',
      audience: null,
      keyPoints: [{ text: 'k', sourceIds: ['s1'] }],
      affiliation: 'founder',
      tone: null,
      language: 'en',
      constraints: [],
      forbiddenClaims: [],
      cta: null,
      linksAllowed: false,
    },
    community: {
      name: 'smallbusiness',
      rules: {
        promotionPolicy: 'allowed_with_conditions',
        linksPolicy: 'restricted',
        flairRequired: false,
        conditions: [],
      },
    },
    thread: {
      title: 'T',
      excerpt: 'E <b>',
      injectionFlag: 'ignore-instructions',
    },
    request: null,
    rewrite: null,
  };
  const variant = (over: Record<string, unknown> = {}) => ({
    title: null,
    body: `${D}\n\nText.`,
    disclosure: D,
    flair_suggestion: null,
    claim_map: [{ text: 'k', source_ids: ['s1'] }],
    uncertainties: [],
    ...over,
  });

  it('схема: 2–3 варианта, title ≤ 300 или null, source_ids — массив или needs_verification; лишние поля — ошибка', () => {
    expect(
      REDDIT_DRAFT_SCHEMA.validate({ variants: [variant(), variant()] }),
    ).toEqual([]);
    expect(
      REDDIT_DRAFT_SCHEMA.validate({
        variants: [
          variant({
            claim_map: [{ text: 'k', source_ids: 'needs_verification' }],
          }),
          variant(),
        ],
      }),
    ).toEqual([]);
    expect(
      REDDIT_DRAFT_SCHEMA.validate({ variants: [variant()] }).length,
    ).toBeGreaterThan(0);
    expect(
      REDDIT_DRAFT_SCHEMA.validate({
        variants: [variant(), variant(), variant(), variant()],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      REDDIT_DRAFT_SCHEMA.validate({
        variants: [variant({ extra: 1 }), variant()],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      REDDIT_DRAFT_SCHEMA.validate({
        variants: [
          variant({ claim_map: [{ text: 'k', source_ids: 'maybe' }] }),
          variant(),
        ],
      }).length,
    ).toBeGreaterThan(0);
  });

  it('inputIssues: число вариантов, заголовок у комментария, пост без заголовка', () => {
    const out = (v: unknown[]) => ({ variants: v }) as never;
    expect(REDDIT_DRAFT.inputIssues!(out([variant()]), base)).toEqual([
      { field: 'variants', code: 'count' },
    ]);
    expect(
      REDDIT_DRAFT.inputIssues!(
        out([variant({ title: 'X' }), variant()]),
        base,
      ),
    ).toEqual([{ field: 'variants[0].title', code: 'comment_title' }]);
    expect(
      REDDIT_DRAFT.inputIssues!(out([variant(), variant()]), {
        ...base,
        contentType: 'post',
      }),
    ).toEqual([
      { field: 'variants[0].title', code: 'required' },
      { field: 'variants[1].title', code: 'required' },
    ]);
    expect(REDDIT_DRAFT.enabledInP0).toBe(false);
  });

  it('находки: link_present по политике ссылок, first_person_experience (кроме customer), disclosure_missing — critical', () => {
    const out = {
      variants: [
        variant({ body: `${D}\n\nSee demo-tools.com. I've been using it.` }),
        variant({ body: 'No disclosure here at all.' }),
      ],
    } as never;
    expect(redditFindings(out, base).map((f) => [f.code, f.severity])).toEqual([
      ['link_present', 'critical'],
      ['first_person_experience', 'critical'],
      ['disclosure_missing', 'critical'],
    ]);
    expect(
      redditFindings(out, {
        ...base,
        brief: { ...base.brief, affiliation: 'customer', linksAllowed: true },
      }).map((f) => f.code),
    ).toEqual(['disclosure_missing']);
    expect(
      linksForbidden({ ...base, community: { name: 'x', rules: null } }),
    ).toBe(true);
    expect(
      linksForbidden({ ...base, brief: { ...base.brief, linksAllowed: true } }),
    ).toBe(false);
  });

  it('тред — недоверенные данные: экранирование и пометка команды', () => {
    expect(renderThread(base)).toBe(
      '<thread trust="untrusted" flag="possible_instruction">\nT\n\nE &lt;b&gt;\n</thread>',
    );
    expect(renderThread({ ...base, thread: null })).toBeNull();
  });
});

describe('hash версии и meta Reddit', () => {
  const h = (meta: Record<string, unknown>) =>
    contentVersionHash({
      title: 't',
      body: 'b',
      meta,
      format: 'reddit_comment',
      offerVersionId: 'o1',
      offerHash: 'h',
      parentVersionId: null,
      sources: [],
      claims: [],
      facts: [],
      claimSources: [],
    } as never);

  it('ruleSnapshotId, disclosure и threadUrl входят в hash', () => {
    const m = {
      disclosure: D,
      ruleSnapshotId: 's1',
      threadUrl: 'u',
      affiliation: 'founder',
    };
    expect(h(m)).toBe(h({ ...m }));
    expect(h({ ...m, ruleSnapshotId: 's2' })).not.toBe(h(m));
    expect(h({ ...m, disclosure: 'x' })).not.toBe(h(m));
    expect(h({ ...m, threadUrl: 'v' })).not.toBe(h(m));
  });

  it('клиент не задаёт серверные ключи meta; неизвестный ключ — отказ', () => {
    expect(
      checkRedditVersionMeta({ disclosure: D, ruleSnapshotId: 'x', foo: 1 })
        .issues,
    ).toEqual([
      { field: 'meta.ruleSnapshotId', code: 'derived' },
      { field: 'meta.foo', code: 'unknown_key' },
    ]);
  });
});

describe('URL отчёта о публикации, хосты Reddit, правила брифа', () => {
  it('канон: пост — канон треда M1 (без query/fragment); комментарий — /comment/<cid>; профиль и не-Reddit — отказ', () => {
    expect(
      normalizeReportedUrl(
        'https://old.reddit.com/r/SmallBusiness/comments/abc123/slug/?utm=1#x',
      ),
    ).toEqual({
      ok: {
        url: 'https://www.reddit.com/r/smallbusiness/comments/abc123/slug',
        subreddit: 'smallbusiness',
        threadKey: 'abc123',
        commentId: null,
      },
    });
    expect(
      normalizeReportedUrl(
        'https://www.reddit.com/r/x_y/comments/abc123/slug/k3x9z/?context=3',
      ),
    ).toMatchObject({
      ok: {
        url: 'https://www.reddit.com/r/x_y/comments/abc123/comment/k3x9z',
        commentId: 'k3x9z',
      },
    });
    expect(
      normalizeReportedUrl(
        'https://www.reddit.com/r/u_someone/comments/abc123',
      ),
    ).toEqual({
      issue: 'profile_ref',
    });
    for (const bad of [
      'http://www.reddit.com/r/x/comments/abc123',
      'https://example.com/r/x/comments/abc123',
      'https://www.reddit.com/r/x',
      'https://www.reddit.com/r/x/comments/abc123/slug/$$$',
      42,
    ])
      expect(normalizeReportedUrl(bad)).toEqual({ issue: 'format' });
  });

  it('хосты Reddit (S3-7): поддомены и дополнительные домены', () => {
    for (const h of [
      'reddit.com',
      'old.reddit.com',
      'i.redd.it',
      'preview.redditmedia.com',
      'i.reddituploads.com',
      'redditmail.com',
      'www.redditinc.com',
      'reddit.app.link',
      'rdt.li',
      'WWW.REDDIT.COM.',
    ])
      expect(isRedditHost(h)).toBe(true);
    for (const h of ['notreddit.com', 'reddit.com.evil.io', 'example.com'])
      expect(isRedditHost(h)).toBe(false);
  });

  it('missing брифа: comment без треда/контекста, тезисы 2..5 и источники, оффер', () => {
    const ok = {
      objective: 'Help',
      affiliation: 'founder',
      contentType: 'comment' as const,
      context: 'ctx',
      opportunityId: 'o1',
      keyPoints: [
        { text: 'a', sourceIds: ['s1'] },
        { text: 'b', sourceIds: 'needs_verification' as const },
      ],
      offerActive: true,
      allowedSourceIds: new Set(['s1']),
      brand: 'Demo',
    };
    expect(briefMissing(ok)).toEqual([]);
    expect(
      briefMissing({
        ...ok,
        opportunityId: null,
        context: ' ',
        affiliation: null,
      }),
    ).toEqual(['affiliation', 'thread', 'context']);
    expect(
      briefMissing({
        ...ok,
        keyPoints: [ok.keyPoints[0]],
        allowedSourceIds: new Set(),
      }),
    ).toEqual(['key_points', 'key_points[0]']);
    expect(
      briefMissing({
        ...ok,
        contentType: 'post',
        context: null,
        opportunityId: null,
        offerActive: false,
      }),
    ).toEqual(['offer_active']);
    expect(commentServiceTitle('x', 'T')).toBe('r/x · T');
    expect([...commentServiceTitle('x', 'y'.repeat(400))]).toHaveLength(300);
  });

  it('абзацы для «перегенерировать абзац»; срок ретенции (умолчание 180)', () => {
    expect(paragraphsOf('a\n\n b \n\n\n\nc')).toEqual(['a', 'b', 'c']);
    expect(retentionDaysOf({ days: 30 })).toBe(30);
    for (const v of [null, {}, { days: 0 }, { days: 4000 }, { days: 1.5 }])
      expect(retentionDaysOf(v)).toBe(180);
  });
});

describe('Раунд исправлений M2 (аудит S1-1, S2-1…S2-3, S3-1/2/7; Р-RD-65…68, 72, 73)', () => {
  const snapProhibited = {
    ...input().snapshot!,
    linksPolicy: 'prohibited' as const,
  };

  it('[AT-RD-08] T1 (аудит): пост основателя «Hi» + личный опыт + гарантия + ссылка в prohibited → все BLOCK', () => {
    const r = codes(
      input({
        body: "Hi all! I'm using Demo daily, it gave me a guaranteed 300% ROI in a week. Pricing: demo.fr/pricing",
        disclosure: 'Hi',
        claimMap: [],
        snapshot: snapProhibited,
      }),
    );
    expect(r.result).toBe('fail');
    expect(r.b).toEqual(
      expect.arrayContaining([
        'reddit_links_prohibited',
        'reddit_links_not_allowed',
        'reddit_disclosure_missing',
        'reddit_unverified_claim',
        'reddit_fake_testimonial',
      ]),
    );
  });

  it('[AT-RD-08] S1-1: раскрытие — ≥ 20 знаков, маркер аффилированности, бренд брифа, в видимых первых 300 знаках', () => {
    const issue = (body: string, d: string, brand: string | null = 'Demo') =>
      disclosureIssue(body, d, brand);
    expect(issue('Hi all, start here', 'Hi')).toBe('too_short');
    expect(
      issue('Great question! Here is how', 'Great question! Here is how'),
    ).toBe('no_brand');
    // бренд не задан и роли нет — неясно (WARN, раунд 2)
    expect(
      issue('Great question! Here is how', 'Great question! Here is how', null),
    ).toBe('unclear');
    expect(
      issue(
        "Disclosure: I'm the founder of Acme. Text",
        "Disclosure: I'm the founder of Acme.",
      ),
    ).toBe('no_brand');
    // спойлер, HTML-комментарий, надстрочный текст — не видны
    for (const hidden of [
      `>!${D}!< Start from one article.`,
      `<!-- ${D} --> Start from one article.`,
      `^(${D}) Start from one article.`,
    ])
      expect(issue(hidden, D)).toBe('not_visible');
    expect(issue(`${'x '.repeat(160)}${D}`, D)).toBe('not_visible');
    expect(issue(`${D}\n\nText`, D)).toBeNull();
    // невидимые символы внутри раскрытия не мешают
    expect(
      issue(`Disclo​sure: I'm the founder of Demo.\n\nText`, D),
    ).toBeNull();
    for (const d of [
      'Розкриття: я засновник Demo, нашого сервісу.',
      'Раскрытие: я основатель Demo, это наш сервис.',
      'Full disclosure: I work at Demo on the content team.',
      'I built Demo myself, so I am affiliated with it.',
    ])
      expect(issue(`${d}\n\nText`, d)).toBeNull();
    // affiliation=none — раскрытие не требуется; null — BLOCK
    expect(
      codes(
        input({
          body: 'Plain helpful text.',
          disclosure: '',
          brief: {
            brand: null,
            affiliation: 'none',
            linksAllowed: false,
            forbiddenClaims: [],
          },
        }),
      ).b,
    ).toEqual([]);
  });

  it('[AT-RD-07] S2-2: формы личного опыта en/uk/ru, двойники букв и апострофы → BLOCK', () => {
    for (const t of [
      "I'm using Demo daily",
      'I am using Demo',
      'Been using Demo for months',
      'We have been using Demo',
      'We use Demo for every launch',
      'I use it every day',
      'It saved me 10 hours',
      'My experience with Demo is great',
      'я використовую Demo щодня',
      'Я юзаю Demo',
      'ми користуємось Demo',
      'я использую Demo',
      'мы пользуемся Demo',
      'мой опыт с Demo отличный',
      'мій досвід з Demo',
      "І've been using Demo",
      'I‘ve been using Demo',
      'І use Demo',
    ])
      expect({ t, hit: firstPersonMarkers(t).length > 0 }).toEqual({
        t,
        hit: true,
      });
    expect(normText('guаranteed')).toBe('guaranteed');
    expect(normText('я використовую')).toBe('я використовую');
  });

  it('S2-3: числа, проценты, деньги, гарантия в теле без пункта claimMap → BLOCK; из контекста/claimMap — нет; отрицание и список — нет', () => {
    const body = (t: string) => `${D}\n\n${t}`;
    expect(
      codes(
        input({
          body: body('Demo is guaranteed to give 300% ROI in 7 days.'),
          claimMap: [],
        }),
      ).b,
    ).toEqual(['reddit_unverified_claim']);
    expect(
      codes(input({ body: body('It costs $49 per month.'), claimMap: [] })).b,
    ).toEqual(['reddit_unverified_claim']);
    expect(
      codes(input({ body: body('Saves ２０ hours.'), claimMap: [] })).b,
    ).toEqual(['reddit_unverified_claim']);
    // число из пункта claimMap с разрешённым источником
    expect(
      codes(
        input({
          body: body('The Demo service costs 2 000 UAH.'),
          claimMap: [{ text: 'Demo costs 2000 UAH', sourceIds: ['s1'] }],
        }),
      ).b,
    ).toEqual([]);
    // число только из контекста брифа/оффера — WARN (раунд 2, Р-RD-78)
    expect(
      codes(
        input({
          body: body('Placements cost 1,500 UAH extra.'),
          claimMap: [],
          contextTexts: ['Розміщення — 1 500 грн'],
        }),
      ),
    ).toEqual({ result: 'pass', b: [], w: ['reddit_claim_from_brief'] });
    // гарантия без пункта — WARN (с числом — BLOCK); отрицание — нет;
    // гарантия с пунктом — нет
    expect(
      codes(input({ body: body('Results are guaranteed.'), claimMap: [] })),
    ).toEqual({ result: 'pass', b: [], w: ['reddit_guarantee'] });
    expect(
      codes(
        input({
          body: body('There is no guarantee of traffic or leads.'),
          claimMap: [],
        }),
      ).b,
    ).toEqual([]);
    expect(
      codes(
        input({
          body: body('Every plan has a money-back guarantee within the trial.'),
          claimMap: [
            {
              text: 'Every plan has a money-back guarantee within the trial',
              sourceIds: ['s1'],
            },
          ],
        }),
      ).b,
    ).toEqual([]);
    // маркеры нумерованного списка и r/… — не числа
    expect(
      codes(
        input({
          body: body(
            'Steps:\n1. Pick one article\n2) Plan formats\nSee r/smallbusiness2 too',
          ),
          claimMap: [],
        }),
      ).b,
    ).toEqual([]);
    // числа результата: проценты и деньги; «1,5 часа» без слова результата — нет
    expect(numbersIn('2 000 грн, 1,5 часа, 300%')).toEqual(['300', '2000']);
    expect(hasNumber('２０')).toBe(true);
    expect(guaranteesIn("we don't guarantee results")).toEqual([]);
  });

  it('S3-1: ссылки — любые зоны, IDN, punycode, [.], «dot com», markdown; reddit.com без пути, r/…, Node.js — не ссылки', () => {
    // голый домен — «похоже на ссылку» (WARN, раунд 2, Р-RD-79)
    for (const t of [
      'mysite.fr',
      'demo.in',
      'demo.to',
      'demo.cc',
      'магазин.рф',
      'xn--80ak6aa92e.com',
    ])
      expect({ t, f: linkFindings(t) }).toEqual({
        t,
        f: { links: [], suspect: [t] },
      });
    for (const t of [
      'demo.ca/pricing',
      'магазин.рф/каталог',
      'xn--80ak6aa92e.com/x',
      'demo[.]com',
      'demo (.) io',
      'demo dot com',
      '[site](/x)',
      'https://reddit.com/r/x',
      'reddit.com/r/smallbusiness',
    ])
      expect({ t, link: hasLink(t) }).toEqual({ t, link: true });
    for (const t of [
      'on reddit.com we discussed this',
      'www.reddit.com is where we met',
      'see r/smallbusiness',
      'built with Node.js and Next.js',
      'the readme.md file',
      'connect the dots to see',
      'e.g. this or i.e. that',
    ])
      expect({ t, link: hasLink(t) }).toEqual({ t, link: false });
  });

  it('S3-2: запрещённые брифом утверждения — после нормализации (невидимые символы, двойники)', () => {
    for (const t of ['Demo is guar​anteed best.', 'Demo is guаranteed best.'])
      expect(
        codes(
          input({
            body: `${D}\n\n${t}`,
            brief: {
              brand: 'Demo',
              affiliation: 'founder',
              linksAllowed: false,
              forbiddenClaims: ['guaranteed'],
            },
          }),
        ).b,
      ).toContain('reddit_forbidden_claim');
  });

  it('S3-7: контакты и ники в claimMap и uncertainties → 400 pii/profile_ref; в проверке — BLOCK reddit_pii', () => {
    const m = checkRedditVersionMeta({
      disclosure: D,
      claimMap: [
        { text: 'mail john.doe@gmail.com', sourceIds: 'needs_verification' },
      ],
      uncertainties: ['ask u/john_doe'],
    });
    expect(m.issues).toEqual([
      { field: 'meta.claimMap[0].text', code: 'pii' },
      { field: 'meta.uncertainties[0]', code: 'profile_ref' },
    ]);
    expect(
      codes(
        input({
          claimMap: [
            {
              text: 'mail john.doe@gmail.com',
              sourceIds: 'needs_verification',
            },
          ],
        }),
      ).b,
    ).toContain('reddit_pii');
  });

  it('экраны (Р-RD-72): ссылка нового вида `/<slug>/comment/<cid>` — id комментария сохраняется', () => {
    expect(
      normalizeReportedUrl(
        'https://www.reddit.com/r/saas/comments/abc123/x/comment/def456/',
      ),
    ).toMatchObject({
      ok: {
        url: 'https://www.reddit.com/r/saas/comments/abc123/comment/def456',
        commentId: 'def456',
      },
    });
    expect(
      normalizeReportedUrl(
        'https://www.reddit.com/r/saas/comments/abc123/x/comment/',
      ),
    ).toEqual({ issue: 'format' });
  });

  it('стенд (Р-RD-73): fake-провайдер отвечает по промпту pub.reddit.draft — схема, вход и находки чистые', async () => {
    const draftIn: RedditDraftInput = {
      template: 'helpful_answer',
      contentType: 'post',
      variants: 3,
      brief: {
        objective: 'Help shops reuse one article',
        audience: null,
        keyPoints: [
          {
            text: 'One verified article can become several formats',
            sourceIds: ['s1'],
          },
          {
            text: 'Ask what the author tried',
            sourceIds: 'needs_verification',
          },
        ],
        affiliation: 'employee',
        brand: 'Demo',
        tone: null,
        language: 'en',
        constraints: [],
        forbiddenClaims: [],
        cta: null,
        linksAllowed: false,
      },
      community: { name: 'smallbusiness', rules: null },
      thread: null,
      request: null,
      rewrite: null,
    };
    const ctx = {
      rulesVersion: 'ctx@1',
      audience: 'internal',
      sources: [],
      facts: [],
      offer: null,
    } as never;
    const prompt = REDDIT_DRAFT.buildPrompt(draftIn, ctx);
    const res = await new StandFakeModel('m').generate({
      ...prompt,
      maxOutputTokens: 6000,
    });
    const out = JSON.parse(res.text);
    expect(REDDIT_DRAFT_SCHEMA.validate(out)).toEqual([]);
    expect(REDDIT_DRAFT.inputIssues!(out, draftIn)).toEqual([]);
    expect(redditFindings(out, draftIn)).toEqual([]);
    expect(out.variants[0].claim_map[0].source_ids).toEqual(['s1']);
    await expect(
      new StandFakeModel('m').generate({
        system: 's',
        user: 'helper',
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow();
  });
});
