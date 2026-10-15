/**
 * [AT-RD-07] [AT-RD-08] Аудит Reddit-подсистемы 15.10.2026, зона m2
 * (`markers@4`; doc/ai-publisher/reddit-manual-mvp-adapted.md §13 «Аудит
 * 15.10.2026»). Регресс-корпус из проверочных скриптов аудитора
 * (`rdaud/m2w/p1…p12`), англоязычные тексты:
 *  - m2-2 «не раскрытия» (бренд + слово роли без субъекта автора);
 *  - m2-3 бренд-домен без пути там, где ссылки запрещены;
 *  - m2-4 выдуманные отзывы и социальное доказательство;
 *  - m2-5 технические цитаты client/user и обход claimMap;
 *  - m2-6 число из тезиса `needs_verification` или выдержки треда;
 *  - m2-7 число пункта claimMap, которого нет в источнике;
 *  - m2-8 ложные BLOCK на честных фразах основателя;
 *  - m2-12 канон URL поста без slug, ссылки «Поделиться».
 */
import { redditChecks, type RedditCheckInput } from './checks';
import {
  REDDIT_MARKERS_VERSION,
  customerQuotes,
  disclosureIssue,
  numberValuesIn,
  personalExperience,
  resultNumbersIn,
  socialProofIn,
} from './markers';
import { normalizeReportedUrl, reportedPostUrlForms } from './normalize';

const NOW = new Date('2026-10-15T10:00:00Z');
const D = "Disclosure: I'm the founder of Acme.";

type Over = Partial<Omit<RedditCheckInput, 'brief' | 'snapshot'>> & {
  brief?: Partial<RedditCheckInput['brief']>;
  linksPolicy?: 'allowed' | 'restricted' | 'prohibited';
};
function input(body: string, over: Over = {}): RedditCheckInput {
  const { brief, linksPolicy, ...rest } = over;
  return {
    contentType: 'comment',
    title: null,
    body,
    disclosure: D,
    flairSuggestion: null,
    claimMap: [],
    versionSnapshotId: 's1',
    brief: {
      affiliation: 'founder',
      linksAllowed: false,
      forbiddenClaims: [],
      brand: 'Acme',
      ...(brief ?? {}),
    },
    contextTexts: [],
    snapshot: {
      id: 's1',
      reviewState: 'reviewed',
      checkedAt: new Date('2026-10-10T00:00:00Z'),
      promotionPolicy: 'allowed_with_conditions',
      linksPolicy: linksPolicy ?? 'restricted',
      flairRequired: false,
    },
    now: NOW,
    staleDays: 90,
    thread: {
      url: 'https://www.reddit.com/r/x/comments/abc/t',
      hasExcerpt: true,
    },
    sources: new Map(),
    others: [],
    ...rest,
  };
}
const run = (body: string, over: Over = {}) => {
  const r = redditChecks(input(`${D}\n\n${body}`, over));
  return {
    b: r.blockers.map((x) => x.code),
    w: r.warnings.map((x) => x.code),
  };
};
const SRC = (fragment: string) =>
  new Map([['src1', { usage: 'allowed', origin: 'content', fragment }]]);

describe('markers@4 — версия словарей', () => {
  it('REDDIT_MARKERS_VERSION = markers@4', () => {
    expect(REDDIT_MARKERS_VERSION).toBe('markers@4');
  });
});

describe('m2-2: раскрытие — роль засчитывается только «о себе»', () => {
  it.each([
    ['Acme works with Postgres and MySQL out of the box.', 'unclear'],
    ['Acme is great for small shop owners like me.', 'unclear'],
    ['Acme is behind a lot of the stuff I do daily.', 'unclear'],
    ['Acme is an agency-friendly tool for SEO.', 'unclear'],
    ['Acme is a tool built for founders and developers.', 'unclear'],
    ['I use Acme for my side project every day.', 'unclear'],
    // «my clients» — чужая роль (клиенты), а не связь с продуктом
    ['I recommend Acme to all my clients, honestly.', 'negated'],
  ])('«%s» → %s (не раскрытие)', (d, issue) => {
    expect(disclosureIssue(`${d}\n\nrest`, d, 'Acme', 'founder')).toBe(issue);
  });
  it('в проверке: неясная роль — WARN, чужая роль — BLOCK', () => {
    const d = 'Acme works with Postgres and MySQL out of the box.';
    expect(
      redditChecks(input(`${d}\n\nrest`, { disclosure: d })).warnings.map(
        (w) => w.code,
      ),
    ).toEqual(['reddit_disclosure_unclear']);
    const n = 'I recommend Acme to all my clients, honestly.';
    expect(
      redditChecks(input(`${n}\n\nrest`, { disclosure: n })).blockers.map(
        (b) => b.code,
      ),
    ).toEqual(['reddit_disclosure_negated']);
  });
  it.each([
    'Disclosure: I am the founder of Acme.',
    'Full disclosure: I work at Acme.',
    'Disclaimer: I built Acme as a side project.',
    'Acme founder here, happy to answer questions.',
    'Disclosure: CTO at Acme, so take this with salt.',
    'Disclosure: Acme is my side project.',
    'Disclosure: my agency works with Acme as a partner.',
    'We partnered with Acme last year, so we are biased.',
    "Disclosure: I'm one of the people behind Acme.",
    'Disclosure: we run an agency that resells Acme.',
    'As the founder of Acme I am obviously biased.',
  ])('честное раскрытие «%s» → принято', (d) => {
    expect(disclosureIssue(`${d}\n\nrest`, d, 'Acme', 'founder')).toBeNull();
  });
});

describe('m2-3: голый домен бренда там, где ссылки запрещены, — ссылка (BLOCK)', () => {
  it.each([
    'You can try it free at acme.io, no signup needed.',
    'You can try it free at Acme.io',
    'Google acme app or go to acme.app',
    'Check out the docs at docs.acme.io for setup.',
  ])('«%s» → BLOCK links', (t) => {
    expect(run(t, { linksPolicy: 'prohibited' }).b).toEqual([
      'reddit_links_prohibited',
      'reddit_links_not_allowed',
    ]);
  });
  it('чужой голый домен — по-прежнему WARN; бренд, совпадающий с доменом целиком, — WARN', () => {
    expect(run('I moved from Heroku to Fly.io last year.')).toEqual({
      b: [],
      w: ['reddit_link_suspect'],
    });
    const d = "Disclosure: I'm the founder of Acme.io.";
    const r = redditChecks(
      input(`${d}\n\nAcme.io handles this.`, {
        disclosure: d,
        brief: { brand: 'Acme.io' },
      }),
    );
    expect(r.blockers).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['reddit_link_suspect']);
  });
});

describe('m2-4: выдуманные отзывы и социальное доказательство → не «чистый pass»', () => {
  it.each([
    'Acme has over 50,000 happy users and a 4.9 rating.',
    "We're trusted by 300+ companies including Stripe.",
    "We have 12k users and it's free.",
    'Acme has 4.8 stars on G2 and was #1 Product of the Day.',
    'Thousands of marketers already rely on Acme.',
    'A friend of mine tried Acme and said it is the best tool she has ever used.',
    'People on Twitter keep telling us Acme saved their launch.',
    "My cofounder's mom uses Acme every day and loves it.",
    'One agency told me they closed new deals thanks to Acme.',
  ])('«%s» → WARN reddit_social_proof', (t) => {
    expect(run(t).w).toContain('reddit_social_proof');
  });
  it('цитата «рецензента» в обратном порядке и «told me:» без кавычек → BLOCK', () => {
    expect(run('"Best purchase this year," says one reviewer.').b).toEqual([
      'reddit_fake_testimonial',
    ]);
    expect(run('One of our users told me: Acme saved my business.').b).toEqual([
      'reddit_fake_testimonial',
    ]);
  });
  it('личный опыт: «switched … never looked back» — WARN; цепочка местоимений от бренда — BLOCK', () => {
    expect(
      run(
        'Honestly I switched last year and never looked back. Acme just works.',
      ),
    ).toEqual({ b: [], w: ['reddit_personal_experience'] });
    expect(
      run(
        "Acme is a scheduler for Reddit. It has a calendar view. I've been using it daily and it's amazing.",
      ).b,
    ).toEqual(['reddit_fake_testimonial']);
  });
  it('честные тексты: лимиты тарифа, маленькие числа, «ten customers» — без соцдоказательства', () => {
    for (const t of [
      'The free plan is limited to 1000 requests per day.',
      'Free for up to 50 users, then $5 per seat.',
      "Acme is used by 2 people on my team. It's tiny.",
      'Honest answer: talk to ten customers before you build anything.',
      'Stripe handles VAT for EU customers if you enable Stripe Tax.',
      'Postgres handles thousands of rows per second here.',
      'Most people who tried Acme said the onboarding was confusing, so we rewrote it.',
      'The number one mistake is posting everything on the same day.',
    ])
      expect({ t, sp: socialProofIn(t, 'Acme') }).toEqual({ t, sp: [] });
  });
});

describe('m2-5: цитата клиента — слова целиком, без апострофа, снимает только пункт о ней', () => {
  it('технические цитаты: без BLOCK (код ошибки — WARN reddit_testimonial_unclear)', () => {
    expect(
      run(
        'If your client says "connection refused", check that the port is open.',
      ),
    ).toEqual({ b: [], w: ['reddit_testimonial_unclear'] });
    expect(
      run('One customer told us "the export is broken", so we fixed it in v2.'),
    ).toEqual({ b: [], w: ['reddit_testimonial_unclear'] });
    for (const t of [
      "A user said it's slow on Windows, and we are looking into it.",
      "When the user wrote 'hello' into the form, the API returned 500.",
      'The superuser account said "permission denied" in my logs.',
      "The API client wrote 'null' instead of an empty string.",
      "My client says they're fine with the delay.",
    ])
      expect({ t, r: run(t) }).toEqual({ t, r: { b: [], w: [] } });
  });
  it('любой пункт claimMap с источником больше не снимает цитату; пункт О ЦИТАТЕ — снимает', () => {
    const body =
      'Our customer Sarah wrote: “Acme is the best tool ever, we love it”';
    const sources = SRC('Acme supports CSV export.');
    expect(
      run(body, {
        claimMap: [{ text: 'Acme supports CSV export', sourceIds: ['src1'] }],
        sources,
      }).b,
    ).toEqual(['reddit_fake_testimonial']);
    expect(
      run(body, {
        claimMap: [
          {
            text: 'Acme is the best tool ever, we love it',
            sourceIds: ['src1'],
          },
        ],
        sources: SRC('Sarah: Acme is the best tool ever, we love it.'),
      }).b,
    ).toEqual([]);
    expect(customerQuotes('A client said "great"', 'Acme')).toEqual([
      { quote: 'great', praise: true },
    ]);
  });
});

describe('m2-6: число из тезиса needs_verification или выдержки треда — BLOCK, а не WARN', () => {
  const body = 'Teams using Acme boost sales by 300% in the first month.';
  it('без контекста и с пунктом needs_verification — BLOCK', () => {
    expect(run(body).b).toEqual(['reddit_unverified_claim']);
    expect(
      run(body, {
        claimMap: [
          {
            text: 'Acme boosts sales by 300%',
            sourceIds: 'needs_verification',
          },
        ],
      }).b,
    ).toEqual(['reddit_unverified_claim']);
  });
  it('число, которое есть в выдержке треда, из брифа не засчитывается', () => {
    const excerpt = 'OP: I read somewhere Acme can boost sales by 300%, true?';
    expect(
      run(body, { contextTexts: ['Help OP', excerpt], threadTexts: [excerpt] })
        .b,
    ).toEqual(['reddit_unverified_claim']);
    // Число из цели брифа (не из треда) — по-прежнему WARN.
    expect(
      run(body, { contextTexts: ['Show that Acme can boost sales by 300%'] }),
    ).toEqual({ b: [], w: ['reddit_claim_from_brief'] });
  });
});

describe('m2-7: число пункта claimMap сверяется с текстом источника', () => {
  const body = 'Acme boosts sales by 300% for most shops.';
  const claimMap = [{ text: 'Acme boosts sales by 300%', sourceIds: ['src1'] }];
  it('в источнике числа нет → WARN reddit_claim_source_mismatch', () => {
    expect(
      run(body, {
        claimMap,
        sources: SRC('Pricing: Pro plan, 29 USD a month.'),
      }),
    ).toEqual({ b: [], w: ['reddit_claim_source_mismatch'] });
  });
  it('число в источнике (цифрами или словами) → без замечаний', () => {
    expect(
      run(body, {
        claimMap,
        sources: SRC('Case study: sales grew by 300 % in three months.'),
      }),
    ).toEqual({ b: [], w: [] });
    expect(numberValuesIn('Sales tripled; 1,400 signups; 4,5 stars')).toEqual(
      expect.arrayContaining(['3', '1400', '4.5']),
    );
  });
});

describe('m2-8: честные фразы основателя — без неснимаемого BLOCK', () => {
  it.each([
    'I tried every scheduler out there before building Acme, and none handled timezones.',
    'We switched to Rust for the backend of Acme last year.',
    'We use Acme ourselves to schedule our own posts, so we feel the pain points too.',
    'I use Python for scripting and Acme only for scheduling.',
  ])('«%s» → WARN reddit_personal_experience', (t) => {
    expect(run(t)).toEqual({ b: [], w: ['reddit_personal_experience'] });
  });
  it('числа «2x longer» и «every 30 seconds» — не результат', () => {
    expect(run('Took 2x longer than expected to ship this feature.')).toEqual({
      b: [],
      w: [],
    });
    expect(run('Acme saves drafts every 30 seconds.')).toEqual({
      b: [],
      w: [],
    });
    expect(resultNumbersIn('Acme makes publishing 3x faster.')).toEqual([
      { value: '3', unit: 'x', raw: '3x' },
    ]);
  });
  it('опыт с брендом-объектом или подлежащим — по-прежнему BLOCK; «we use Acme ourselves» без связи с продуктом (none) — BLOCK', () => {
    for (const t of [
      "I've been using Acme daily for a year.",
      'We switched from Buffer to Acme last year.',
      'Honestly, Acme has been a game changer for us.',
      "Can't recommend Acme enough.",
    ])
      expect({ t, b: run(t).b }).toEqual({
        t,
        b: ['reddit_fake_testimonial'],
      });
    expect(
      personalExperience('We use Acme ourselves internally.', 'Acme'),
    ).toBe('own_use');
    expect(
      redditChecks(
        input('We use Acme ourselves internally.', {
          disclosure: '',
          brief: { affiliation: 'none' },
        }),
      ).blockers.map((b) => b.code),
    ).toEqual(['reddit_fake_testimonial']);
  });
});

describe('m2-12: канон URL поста — без slug; «Поделиться» — share_link', () => {
  it('со slug и без — один канон; прежние строки со slug сопоставляются по ключу', () => {
    const a = normalizeReportedUrl(
      'https://www.reddit.com/r/SideProject/comments/1abc2d/',
    );
    const b = normalizeReportedUrl(
      'https://old.reddit.com/r/sideproject/comments/1abc2d/I_Built_Acme/?utm_source=share',
    );
    expect(a).toEqual(b);
    expect(a).toEqual({
      ok: {
        url: 'https://www.reddit.com/r/sideproject/comments/1abc2d',
        subreddit: 'sideproject',
        threadKey: '1abc2d',
        commentId: null,
      },
    });
    expect(
      reportedPostUrlForms('https://www.reddit.com/r/x/comments/1abc2d'),
    ).toEqual({
      exact: 'https://www.reddit.com/r/x/comments/1abc2d',
      slugPrefix: 'https://www.reddit.com/r/x/comments/1abc2d/',
      commentPrefix: 'https://www.reddit.com/r/x/comments/1abc2d/comment/',
    });
  });
  it('ссылка «Поделиться» и короткая redd.it → share_link', () => {
    for (const u of [
      'https://www.reddit.com/r/sideproject/s/AbCdEf123',
      'reddit.com/r/sideproject/s/AbCdEf123',
      'https://redd.it/1abc2d',
    ])
      expect(normalizeReportedUrl(u)).toEqual({ issue: 'share_link' });
  });
});
