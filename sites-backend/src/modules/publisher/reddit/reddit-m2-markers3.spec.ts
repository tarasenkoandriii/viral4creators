/**
 * [AT-RD-07] [AT-RD-08] P-R M2, раунд 2 (повторный аудит S2-A…S2-D, S3;
 * Р-RD-74…82): `markers@3` и `checks.ts`. Принцип Р-RD-74 — BLOCK только
 * при высокой уверенности, неоднозначное — WARN. Корпус честных ответов
 * (en/uk/ru, код, версии, даты) — ни одного BLOCK; обходы аудиторов
 * (`pr2aud2/probes/pure2.probe.ts` B, D, E, F; `http2` T1b/T1c/T1d) — BLOCK
 * или WARN.
 */
import { overlapMatcher, scrubJson } from '../ai/ai-redaction';
import { checkRedditVersionMeta } from '../content/rules';
import { briefMissing } from './brief-rules';
import { redditChecks, type RedditCheckInput } from './checks';
import {
  REDDIT_MARKERS_VERSION,
  brandIn,
  containsPhrase,
  disclosureIssue,
  firstPersonMarkers,
  formsOf,
  guaranteesIn,
  linkFindings,
  normText,
  personalExperience,
  redditContact,
  resultNumbersIn,
  weakBrand,
} from './markers';

const NOW = new Date('2026-10-14T10:00:00Z');
const D = "Disclosure: I'm the founder of Demo, a content service.";
const TAIL = '\n\nStart from one verified article.';

type Over = Partial<Omit<RedditCheckInput, 'brief'>> & {
  brief?: Partial<RedditCheckInput['brief']>;
};
function input(over: Over = {}): RedditCheckInput {
  const { brief, ...rest } = over;
  return {
    contentType: 'post',
    title: 'How to reuse one article',
    body: `${D}${TAIL}`,
    disclosure: D,
    flairSuggestion: null,
    claimMap: [
      { text: 'One article can become several formats', sourceIds: ['s1'] },
    ],
    versionSnapshotId: 'snap1',
    brief: {
      affiliation: 'founder',
      linksAllowed: false,
      forbiddenClaims: [],
      brand: 'Demo',
      ...(brief ?? {}),
    },
    contextTexts: [
      'Help the author reuse one article across formats',
      'Small business owners',
    ],
    snapshot: {
      id: 'snap1',
      reviewState: 'reviewed',
      checkedAt: new Date('2026-10-10T10:00:00Z'),
      promotionPolicy: 'allowed_with_conditions',
      linksPolicy: 'prohibited',
      flairRequired: false,
    },
    now: NOW,
    staleDays: 30,
    thread: null,
    sources: new Map([['s1', { usage: 'allowed', origin: 'content' }]]),
    others: [],
    ...rest,
  };
}
const run = (i: RedditCheckInput) => {
  const r = redditChecks(i);
  return {
    b: r.blockers.map((x) => x.code),
    w: r.warnings.map((x) => x.code),
  };
};
const withDisclosure = (d: string, over: Over = {}) =>
  run(input({ body: d + TAIL, disclosure: d, ...over }));

describe('markers@3 — корпус честных ответов: ни одного BLOCK (S2-D, Р-RD-74)', () => {
  const DF = D;
  const UK = 'Розкриття: я працюю в Demo, тож я упереджений.';
  const RU = 'Раскрытие: я основатель Demo, учитывайте это.';
  const CU = "Disclosure: I'm a paying customer of Demo, no other ties.";
  const corpus: Array<
    [string, RedditCheckInput['brief']['affiliation'], string, string]
  > = [
    [
      'H1 node',
      'founder',
      DF,
      "For what it's worth, if you're on Node.js 18, move to Node 20 LTS first: the built-in fetch is stable there. Then check package.json for deprecated deps.",
    ],
    [
      'H2 cadence',
      'founder',
      DF,
      "What usually works: write one solid article, then cut it into three or four short posts over the next two weeks. Don't post all of them on the same day.",
    ],
    [
      'H3 Promise.all',
      'founder',
      DF,
      "You don't need a library for this. Wrap the requests in Promise.all and handle errors per item with Promise.allSettled.",
    ],
    [
      'H4 2-3 times',
      'founder',
      DF,
      'There is no magic number, but most small shops post 2-3 times a week. Consistency matters more than volume.',
    ],
    [
      'H5 customer',
      'customer',
      CU,
      "I've been using Demo for a few months to repurpose blog posts. It's decent for drafts, but I still edit everything by hand.",
    ],
    [
      'H6 none',
      'none',
      '',
      'Honest answer: talk to ten customers before you build anything. We skipped that step and wasted half a year.',
    ],
    [
      'H7 Stripe',
      'founder',
      DF,
      'Stripe handles VAT for EU customers if you enable Stripe Tax. For the US, sales tax rules differ per state, so talk to an accountant.',
    ],
    [
      'H8 pathlib',
      'founder',
      DF,
      "Use pathlib instead of os.path.join, it's cleaner. Python 3.12 also gives better error messages.",
    ],
    [
      'H9 uk employee',
      'employee',
      UK,
      'Найпростіше — взяти одну статтю і зробити з неї кілька коротких дописів. Не публікуйте все в один день.',
    ],
    [
      'H10 ru founder',
      'founder',
      RU,
      'Начните с одной хорошей статьи и разбейте её на несколько коротких постов. Публикуйте их в течение двух недель, а не за один день.',
    ],
    [
      'H11 As promised',
      'founder',
      DF,
      'As promised in my earlier comment, here are the steps: outline, draft, edit, then schedule.',
    ],
    [
      'H12 Rust guarantees',
      'founder',
      DF,
      "Rust guarantees memory safety at compile time, so most of these bugs just can't happen there.",
    ],
    [
      'H13 code block',
      'founder',
      DF,
      '```js\nconst pages = await Promise.all(urls.map((u) => fetch(u)));\nconsole.log(pages.length);\n```\nThat runs the requests in parallel; Object.keys(cache).length tells you how many are cached.',
    ],
    [
      'H14 dates',
      'founder',
      DF,
      'The 1.2.0 release moved the cutoff from 2026-10-14 to 10/20/2026, and the v2 API went live at 9:30 on Monday.',
    ],
    [
      'H15 uk versions',
      'founder',
      DF,
      'Оновіться з Node 18 до Node 20, а потім перевірте package.json. У Python 3.12 повідомлення про помилки зрозуміліші.',
    ],
    [
      'H16 ru 404',
      'founder',
      DF,
      'Обновите React до 18.3.1 и проверьте, что в package.json нет старых зависимостей. Ошибка 404 значит, что slug изменился.',
    ],
    [
      'H17 entity B2B',
      'founder',
      DF,
      '&#x200B;\n\nFor B2B SaaS, Q3 is usually slow; GPT-4 can draft the first version, but edit by hand. Support is not 24/7, so plan ahead.',
    ],
    [
      'H18 ASP.NET',
      'founder',
      DF,
      'In ASP.NET Core use IOptions; in Go keep it in main.go and read it with os.Getenv. It works.Then restart the service.',
    ],
    [
      'H19 JSON.parse',
      'founder',
      DF,
      'JSON.parse can throw, so wrap it; Math.max on an empty array returns -Infinity. See the README.md of the repo.',
    ],
    [
      'H20 uk dates',
      'founder',
      DF,
      'Звітність подають до 20 числа, а з 1 січня 2026 року правила змінились. Як і обіцяв, ось чекліст: план, чернетка, редагування.',
    ],
    [
      'H21 ru no guarantee',
      'founder',
      RU,
      'Мы не гарантируем рост трафика, всё зависит от контента. Как и обещал, вот шаги.',
    ],
    [
      'H22 no guarantee',
      'founder',
      DF,
      "There's no guarantee this works for every niche, so test it on 2-3 posts first.",
    ],
    [
      'H23 npm',
      'founder',
      DF,
      'Run npm i @types/node and pin react@18.3.1; then check that git@github.com:org/repo is reachable. @nestjs/core needs the same major.',
    ],
    [
      'H24 years growth',
      'founder',
      DF,
      'Remote work grew a lot after 2020, so async tools matter more now. Double-check the DNS settings first; it saves a lot of debugging.',
    ],
    [
      'H25 other tool',
      'founder',
      DF,
      "I've been using Postgres for years and it handles this fine with a partial index.",
    ],
    [
      'H26 numbered list',
      'founder',
      DF,
      'Steps: 1) write one article, 2) cut it into posts, 3) reuse the best one.\n1. Plan\n2. Draft',
    ],
    [
      'H27 side project',
      'founder',
      'Full transparency: Demo is my side project, so I am biased.',
      'Start with the article you already have, not with a new one.',
    ],
    [
      'H28 ru team',
      'employee',
      'Я из команды Demo, имейте в виду.',
      'Сначала соберите вопросы клиентов, потом пишите статью.',
    ],
  ];
  it.each(corpus)('%s → нет BLOCK', (_k, aff, d, t) => {
    const r = run(
      input({
        body: d ? `${d}\n\n${t}` : t,
        disclosure: d,
        brief: { affiliation: aff, brand: aff === 'none' ? null : 'Demo' },
      }),
    );
    expect(r.b).toEqual([]);
  });
  it('корпус ≥ 20 текстов; WARN — только ожидаемые', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(20);
    const warned = corpus
      .map(([k, aff, d, t]) => [
        k,
        run(
          input({
            body: d ? `${d}\n\n${t}` : t,
            disclosure: d,
            brief: { affiliation: aff, brand: aff === 'none' ? null : 'Demo' },
          }),
        ).w,
      ])
      .filter(([, w]) => (w as string[]).length);
    // личный опыт не о продукте брифа — WARN, его подтверждает проверяющий
    expect(warned).toEqual([
      ['H25 other tool', ['reddit_personal_experience']],
    ]);
  });
});

describe('S2-A — раскрытие: отрицание и чужая роль → BLOCK, бренд целым словом', () => {
  it.each([
    'Not affiliated with Demo in any way, just sharing what worked.',
    "Full disclosure: I'm just a happy customer of Demo.",
    "Disclosure: I'm a user of Demo, nothing more.",
    'No disclosure needed here, I just like Demo a lot.',
    'Disclosure: I have no ties to Demo whatsoever.',
    'Я не працюю в Demo, просто ділюсь досвідом.',
    'Я не основатель Demo и не работаю на них.',
    'Not sponsored by Demo, nobody paid me for this.',
    'Я клієнт Demo вже давно, і ось що скажу.',
    "Disclosure: I'm not the founder of Demo.",
    "Я не пов'язаний з Demo, просто користувач.",
  ])('founder: «%s» → reddit_disclosure_negated', (d) => {
    expect(withDisclosure(d).b).toEqual(['reddit_disclosure_negated']);
  });
  it('бренд-подстрока («demonstration») — не бренд; вопрос — WARN; роль + отрицание — WARN', () => {
    expect(
      withDisclosure('Disclosure: this is only a demonstration of the idea.').b,
    ).toEqual(['reddit_disclosure_missing']);
    expect(
      withDisclosure('Are you the founder of Demo? People ask me that a lot.'),
    ).toEqual({ b: [], w: ['reddit_disclosure_unclear'] });
    expect(
      withDisclosure(
        "Disclosure: I'm the founder of Demo, not paid by anyone.",
      ),
    ).toEqual({ b: [], w: ['reddit_disclosure_unclear'] });
    expect(
      withDisclosure('Demo is a nice tool for writers, honestly.'),
    ).toEqual({ b: [], w: ['reddit_disclosure_unclear'] });
  });
  it('у customer «not affiliated» и «just a customer» — честное раскрытие', () => {
    for (const d of [
      "Not affiliated with Demo, I'm just a paying customer.",
      'Я просто клієнт Demo, ніяк не повʼязаний з ними.',
    ])
      expect(withDisclosure(d, { brief: { affiliation: 'customer' } })).toEqual(
        { b: [], w: [] },
      );
  });
  it.each([
    'Full transparency: Demo is my side project, so I am biased.',
    "Heads up: I'm on the Demo team, so I'm biased.",
    "Disclaimer: I'm one of the people behind Demo.",
    "Bias alert: I'm the dev behind Demo.",
    'Я розробник Demo, тож враховуйте це.',
    'Я з команди Demo, тож майте це на увазі.',
    'Я разработчик Demo, учитывайте это.',
    'Я из команды Demo, имейте в виду.',
    'Я CEO Demo, так что я предвзят.',
    '(I run Demo, so take this with a grain of salt)',
    'I wrote Demo, so obviously I am biased here.',
    'Я засновник Demо, тож враховуйте це.',
    "I made Demo, so I'm obviously biased.",
    "I'm building Demo, take this with salt.",
    'Мы делаем Demo, так что я заинтересован.',
    'Я засновник Демо, тож враховуйте це.',
  ])('честная формулировка «%s» → pass', (d) => {
    expect(withDisclosure(d)).toEqual({ b: [], w: [] });
  });
  it('бренд: ≥ 3 знаков и не стоп-слово, целым словом, двойники и транслитерация', () => {
    expect(weakBrand('the')).toBe(true);
    expect(weakBrand('AI')).toBe(true);
    expect(weakBrand('Demo')).toBe(false);
    expect(brandIn('a demonstration', 'Demo')).toBe(false);
    expect(brandIn('#Demo founder here', 'Demo')).toBe(true);
    expect(brandIn('засновник Демо', 'Demo')).toBe(true);
    expect(brandIn('I run Site Assist', 'Site  Assist')).toBe(true);
    const base = {
      objective: 'Help',
      affiliation: 'founder' as const,
      contentType: 'post' as const,
      context: null,
      opportunityId: null,
      keyPoints: [
        { text: 'a', sourceIds: ['s1'] },
        { text: 'b', sourceIds: ['s1'] },
      ],
      offerActive: true,
      allowedSourceIds: new Set(['s1']),
    };
    expect(briefMissing({ ...base, brand: 'the' })).toEqual(['brand']);
    expect(briefMissing({ ...base, brand: 'Demo' })).toEqual([]);
  });
});

describe('S2-B — надстрочный, спойлер, зачёркнутое: видимы для нарушений, не засчитываются как раскрытие', () => {
  it('личный опыт, числа и ссылки в ^(…) и >!…!< проверяются', () => {
    for (const t of [
      "^(I'm using Demo daily and it is the best tool ever)",
      ">!I've been using Demo for ages!<",
      "~~I've been using Demo for ages~~",
      '<!-- I have been using Demo daily -->',
    ])
      expect(run(input({ body: `${D}\n\n${t}` })).b).toEqual([
        'reddit_fake_testimonial',
      ]);
    for (const t of [
      'Demo gives >!300% ROI!< in a week.',
      'Demo gives ROI of ^(300 percent) in a week.',
    ])
      expect(run(input({ body: `${D}\n\n${t}` })).b).toEqual([
        'reddit_unverified_claim',
      ]);
    // T1c (http2): надстрочный опыт + ссылка с путём в prohibited
    expect(
      run(
        input({
          body: `${D}\n\n^(I'm using Demo daily and it saved my team, see demo.fr/pricing)`,
        }),
      ).b,
    ).toEqual([
      'reddit_links_prohibited',
      'reddit_links_not_allowed',
      'reddit_fake_testimonial',
    ]);
    expect(linkFindings('>!demo.com!< and ^(demo.com)').suspect).toEqual([
      'demo.com',
    ]);
    // markers@4 (аудит m2-3): домен с меткой-брендом — ссылка (BLOCK),
    // чужой голый домен — по-прежнему WARN.
    expect(run(input({ body: `${D}\n\n>!demo.com!<` })).b).toEqual([
      'reddit_links_prohibited',
      'reddit_links_not_allowed',
    ]);
    expect(run(input({ body: `${D}\n\n>!othertool.com!<` })).w).toEqual([
      'reddit_link_suspect',
    ]);
  });
  it('разметка раскрытия: надстрочный, зачёркнутое, цитата, код, спойлер → BLOCK not_visible; заголовок поста — засчитывается', () => {
    for (const d of [
      "^^^Disclosure: ^^^I'm ^^^the ^^^founder ^^^of ^^^Demo",
      "~~Disclosure: I'm the founder of Demo~~",
      "> Disclosure: I'm the founder of Demo",
      "`Disclosure: I'm the founder of Demo`",
      "Disclosure: I'm the founder of >!Demo!<",
    ])
      expect(
        disclosureIssue(
          `${d}\n\nis what the last spammer wrote.${TAIL}`,
          d,
          'Demo',
        ),
      ).toBe('not_visible');
    // в теле есть, но внутри цитаты / зачёркнутого — не засчитывается
    expect(disclosureIssue(`> ${D}${TAIL}`, D, 'Demo')).toBe('not_visible');
    expect(disclosureIssue(`~~${D}~~${TAIL}`, D, 'Demo')).toBe('not_visible');
    // окно 300: надстрочный занимает место, спойлер и невидимые — нет
    const pad = `${'x'.repeat(10)} `.repeat(40);
    expect(disclosureIssue(`^(${pad})${D}${TAIL}`, D, 'Demo')).toBe(
      'not_visible',
    );
    expect(disclosureIssue(`>!${pad}!<${D}${TAIL}`, D, 'Demo')).toBeNull();
    expect(
      disclosureIssue(`${'​'.repeat(400)}${D}${TAIL}`, D, 'Demo'),
    ).toBeNull();
    expect(
      disclosureIssue(`${'&#x200B;'.repeat(40)}${D}${TAIL}`, D, 'Demo'),
    ).toBeNull();
    // заголовок поста — начало видимого текста
    expect(
      run(input({ title: D, body: 'Start from one verified article.' })).b,
    ).toEqual([]);
    expect(
      run(
        input({
          contentType: 'comment',
          title: null,
          body: 'Start from one verified article.',
          thread: {
            url: 'https://www.reddit.com/r/x/comments/abc',
            hasExcerpt: true,
          },
        }),
      ).b,
    ).toEqual(['reddit_disclosure_missing']);
  });
});

describe('S2-C — смешанное письмо: обе свёртки', () => {
  it('кириллица с латинской буквой и наоборот — в словарях uk/ru и en', () => {
    for (const t of [
      'я испoльзую Demo каждый день',
      'я викoристовую Demo щодня',
      "І'м using Demo daily",
      "Ι'м using Demo",
      "I've been սsing Demo",
      'я працюю y Demo', // латинская y как предлог — маркер роли, не опыт
    ].slice(0, 5))
      expect({ t, hit: firstPersonMarkers(t).length > 0 }).toEqual({
        t,
        hit: true,
      });
    expect(guaranteesIn('Демо гaрантує результат.')).toEqual(['гарантує']);
    expect(
      containsPhrase('Демо — це гарантoваний дохід.', 'гарантований дохід'),
    ).toBe(true);
    const f = formsOf('гарантoваний дохід');
    expect(f.cyr).toBe('гарантований дохід');
    expect(f.lat).toHaveLength(f.cyr.length);
    expect(normText('guаranteed')).toBe('guaranteed');
    expect(withDisclosure('Я працюю y Demo, тож враховуйте це.')).toEqual({
      b: [],
      w: [],
    });
    expect(
      run(
        input({
          body: `${D}\n\nДемо — це гарантoваний дохід.`,
          brief: { forbiddenClaims: ['гарантований дохід'] },
        }),
      ).b,
    ).toEqual(['reddit_forbidden_claim']);
  });
});

describe('S2-D — числа, ссылки, гарантии, контакты: BLOCK только при высокой уверенности', () => {
  it('числа результата: %, деньги, множители (и словами), число у слова результата', () => {
    const v = (t: string) =>
      resultNumbersIn(t).map((n) => `${n.value}${n.unit}`);
    expect(v('Demo gives 300% ROI')).toEqual(['300%']);
    expect(v('It costs $49 per month')).toEqual(['49money']);
    expect(v('Plans from 1 500 грн')).toEqual(['1500money']);
    expect(v('3x more leads')).toEqual(['3x']);
    expect(v('продажі зросли в 3 рази')).toEqual(['3x']);
    expect(v('Demo will triple your revenue')).toEqual(['3x']);
    expect(v('Demo потроїть ваш дохід')).toEqual(['3x']);
    expect(v('cut my workload in half')).toEqual(['0.5x']);
    expect(v('saves 20 hours a month')).toEqual(['20']);
    expect(v('I 100% agree with that')).toEqual([]);
    for (const t of [
      'Upgrade from Node 18 to Node 20 first.',
      'Pin react@18.3.1 and run the tests.',
      'The v2.0 API removed that endpoint.',
      'This changed back in 2023.',
      'For B2B SaaS the playbook is different.',
      'Skip the Web3 hype for now.',
      'GPT-4 handles this fine.',
      'Wait until Q3 for the new pricing.',
      'Steps: 1) write one article, 2) cut it into posts, 3) reuse the best one.',
      'Post around 9am on weekdays.',
      'You will get a 404 if the slug changes.',
      'Use ISO 8601 dates in the export.',
      'Support is not 24/7, so plan ahead.',
      'post 2-3 times a week',
      'double-check the config',
      'revenue grew a lot since 2020',
    ])
      expect({ t, n: v(t) }).toEqual({ t, n: [] });
  });
  it('обходы чисел → BLOCK; число из пункта claimMap — только о том же утверждении; из контекста — WARN', () => {
    for (const t of [
      'Demo will triple your revenue in a single week.',
      'Demo потроїть ваш дохід за тиждень.',
      'Demo gives 10x ROI to 1 in 10 users.',
      'Our clients double their sales with Demo.',
    ])
      expect(
        run(
          input({
            body: `${D}\n\n${t}`,
            contextTexts: ['Audience: teams of 1-10 people'],
          }),
        ).b,
      ).toEqual(['reddit_unverified_claim']);
    const claim = {
      text: 'Teams save 20 hours a month with Demo',
      sourceIds: ['s1'],
    };
    expect(
      run(
        input({
          body: `${D}\n\nMost teams save 20 hours a month after setup.`,
          claimMap: [claim],
        }),
      ).b,
    ).toEqual([]);
    expect(
      run(
        input({
          body: `${D}\n\nDemo gives 20% ROI to every customer.`,
          claimMap: [claim],
        }),
      ).b,
    ).toEqual(['reddit_unverified_claim']);
    expect(
      run(
        input({
          body: `${D}\n\nDemo boosts revenue by 20 points.`,
          claimMap: [claim],
        }),
      ).b,
    ).toEqual(['reddit_unverified_claim']);
    expect(
      run(
        input({
          body: `${D}\n\nThe offer gives 20% off the first month.`,
          claimMap: [],
          contextTexts: ['Offer: 20% off the first month'],
        }),
      ),
    ).toEqual({ b: [], w: ['reddit_claim_from_brief'] });
  });
  it('гарантии: узкий словарь, отрицание только непосредственно перед словом; с числом — BLOCK', () => {
    for (const t of [
      'No joke, results are guaranteed.',
      "Can't lie, it's guaranteed to work.",
      'Not gonna lie, Demo is guaranteed to fix this.',
      'Results are assured with Demo.',
      'Demo pays for itself, money back if not.',
      'Demo точно спрацює у вашому випадку.',
      'Демо гaрантує результат.',
      'We promise you results.',
      'Обещаем результат с первого дня.',
    ])
      expect({ t, r: run(input({ body: `${D}\n\n${t}` })) }).toEqual({
        t,
        r: { b: [], w: ['reddit_guarantee'] },
      });
    expect(
      run(input({ body: `${D}\n\nDemo is guaranteed to give 300% ROI.` })).b,
    ).toEqual(['reddit_unverified_claim']);
    // число подтверждено пунктом claimMap, а гарантия — нет: вместе — BLOCK
    const roi = run(
      input({
        body: `${D}\n\nDemo is guaranteed to give 300% ROI.`,
        claimMap: [{ text: 'Demo gives 300% ROI', sourceIds: ['s1'] }],
      }),
    );
    expect(roi.b).toEqual(['reddit_unverified_claim']);
    expect(
      run(
        input({
          body: `${D}\n\nDemo gives 300% ROI.`,
          claimMap: [{ text: 'Demo gives 300% ROI', sourceIds: ['s1'] }],
        }),
      ).b,
    ).toEqual([]);
    for (const t of [
      'Wrap the calls in Promise.all and await them.',
      'Rust guarantees memory safety without a GC.',
      'As promised, here is the checklist.',
      "There's no guarantee it works for you.",
      'Як і обіцяв, ось кроки.',
      'Мы не гарантируем результат.',
    ])
      expect({ t, g: guaranteesIn(t) }).toEqual({ t, g: [] });
  });
  it('ссылки: код и опечатки — не ссылки; голый домен — WARN; путь и обходы — BLOCK', () => {
    for (const t of [
      'Node.js',
      'Vue.js and Next.js',
      'v2.0',
      'ASP.NET Core',
      'Object.keys(obj)',
      'array.map',
      'Math.max',
      'JSON.parse',
      'window.location',
      'os.path.join',
      'np.array',
      'It works.Then restart',
      'Thanks.Next step',
      'main.go',
      'index.php',
      'archive.tar.gz',
      'main.rs',
      'St.Louis',
      'e.g. this',
      'U.S. market',
      'Python 3.12',
      'react@18.3.1',
      'user@example',
      '@nestjs/core',
      'git@github.com:org/repo',
      'Promise.all',
      'console.log',
      'fs.readFile',
      'pd.DataFrame',
      'Dr.Smith',
      'app.module',
      'README.md',
      'foo.io()',
      'on reddit.com we discussed',
    ])
      expect({ t, f: linkFindings(t) }).toEqual({
        t,
        f: { links: [], suspect: [] },
      });
    for (const t of ['docker.io', 'demo.com', 'Demo.com', 'DEMO.COM'])
      expect(linkFindings(t)).toEqual({ links: [], suspect: [t] });
    for (const t of [
      'demo . com',
      'demo。com',
      'demo｡com',
      'demo d0t com',
      'demo,com',
      'demo(dot)com',
      'demo{.}com',
      'demo [dot] com',
      'h t t p s : / / demo.com',
      'demo․com',
      'demo·com',
      'demo\\.com',
      'see demo.com/pricing',
      '[docs](https://demo.com)',
      'https://demo.com',
      'www.demo.com',
    ])
      expect({ t, hard: linkFindings(t).links.length > 0 }).toEqual({
        t,
        hard: true,
      });
    // honest «dot com era» — не обход
    expect(linkFindings('back in the dot com era').links).toEqual([]);
    // голый домен: WARN только там, где ссылки нельзя
    expect(run(input({ body: `${D}\n\nWe host on docker.io` })).w).toEqual([
      'reddit_link_suspect',
    ]);
    expect(
      run(
        input({
          body: `${D}\n\nWe host on docker.io`,
          brief: { linksAllowed: true },
          snapshot: { ...input().snapshot!, linksPolicy: 'allowed' },
        }),
      ).w,
    ).toEqual([]);
  });
  it('контакт в Reddit-тексте: e-mail с зоной, телефон, мессенджер, @handle; пакеты и scp — нет', () => {
    for (const t of [
      'mail john.doe@gmail.com',
      'write to john [at] gmail.com',
      'call +380 67 123 45 67',
      'tg: t.me/johndoe',
      'ping @johndoe_ua on telegram',
    ])
      expect({ t, c: redditContact(t) }).toEqual({ t, c: true });
    for (const t of [
      'react@18.3.1',
      'user@example',
      '@nestjs/core',
      'git@github.com:org/repo',
      'npm i @types/node',
      'Node 20.11.1',
      '@Override public void run()',
      '@Injectable() export class X',
      'This changed in 2024',
    ])
      expect({ t, c: redditContact(t) }).toEqual({ t, c: false });
    expect(
      run(input({ body: `${D}\n\nInstall @nestjs/core and react@18.3.1.` })).b,
    ).toEqual([]);
    const m = checkRedditVersionMeta({
      disclosure: D,
      claimMap: [{ text: 'Works with @nestjs/core 11', sourceIds: ['s1'] }],
      uncertainties: ['mail john@gmail.com'],
    } as never);
    expect(m.issues).toEqual([{ field: 'meta.uncertainties[0]', code: 'pii' }]);
  });
});

describe('S3 — словарь личного опыта, связь с продуктом, N6', () => {
  it('новые формы личного опыта en/uk/ru', () => {
    for (const t of [
      "I've had Demo for a year now",
      'I started using Demo last spring',
      'I switched over to Demo',
      'Demo has been a lifesaver for me',
      'Personally, Demo cut my workload in half',
      "I can't recommend Demo enough",
      'My team runs everything on Demo',
      'Since we moved to Demo, onboarding is painless',
      'I signed up for Demo and never looked back',
      'я купувала Demo',
      'мы внедрили Demo',
      'у меня Demo уже год',
      'мені сподобався Demo',
      'I installed Demo on all our laptops',
      'We rolled out Demo company-wide',
    ])
      expect({ t, hit: firstPersonMarkers(t).length > 0 }).toEqual({
        t,
        hit: true,
      });
  });
  it('личный опыт: с брендом (или «…it» после бренда) — BLOCK, без связи — WARN', () => {
    expect(personalExperience("I've been using Demo for a year.", 'Demo')).toBe(
      'tied',
    );
    expect(
      personalExperience("Demo is neat. I've been using it daily.", 'Demo'),
    ).toBe('tied');
    expect(
      personalExperience('Demo is neat. It worked great for me.', 'Demo'),
    ).toBe('tied');
    expect(
      personalExperience(
        'Demo exports to Postgres. I have been using Postgres for years.',
        'Demo',
      ),
    ).toBe('loose');
    expect(personalExperience('No experience claims here.', 'Demo')).toBeNull();
    expect(run(input({ body: `${D}\n\nWe use Postgres for this.` }))).toEqual({
      b: [],
      w: ['reddit_personal_experience'],
    });
  });
  it('N6: журнал AI маскируется по фрагменту из 6 слов подряд (не 5), выдержке целиком и короткой выдержке', () => {
    const excerpt =
      'We tried three different schedulers and the cron one kept failing at night';
    const hit = overlapMatcher([excerpt, 'short quote here']);
    expect(hit('Model says: the cron one kept failing at night, so…')).toBe(
      true,
    );
    expect(hit('Model: and the cron one kept — different')).toBe(false);
    expect(hit('one kept failing at night')).toBe(false);
    expect(hit(`prefix ${excerpt} suffix`)).toBe(true);
    expect(hit('A Short Quote Here!')).toBe(true);
    const r = scrubJson(
      { variants: [{ body: 'x the cron one kept failing at night y', n: 1 }] },
      hit,
      '[redacted]',
    );
    expect(r).toEqual({
      value: { variants: [{ body: '[redacted]', n: 1 }] },
      changed: true,
    });
  });
  it('версия словарей — markers@4 (аудит m2 15.10.2026)', () => {
    expect(REDDIT_MARKERS_VERSION).toBe('markers@4');
  });
});

describe('раунд 3 (точечная перепроверка S3-R2-1…4; Р-RD-85)', () => {
  it('S3-R2-1: явное «not affiliated / zero affiliation / не повʼязаний / не связан / не аффилирован» у founder → BLOCK negated, даже рядом со словом роли', () => {
    for (const d of [
      'Not affiliated with Demo in any way, just sharing what worked for us.',
      'Zero affiliation with Demo, just a fan of the tool.',
      'No affiliation with Demo, we build our own stuff.',
      "Я не пов'язаний з Demo, хоча ми з команди сусідів.",
      'Я не связан с Demo, хотя работаю в их команде.',
      'Не аффилирован с Demo, мы делаем свой продукт.',
    ])
      expect({ d, r: withDisclosure(d) }).toEqual({
        d,
        r: { b: ['reddit_disclosure_negated'], w: [] },
      });
    // у customer «not affiliated» — честное раскрытие, как прежде
    expect(
      withDisclosure("Not affiliated with Demo, I'm just a paying customer.", {
        brief: { affiliation: 'customer' },
      }),
    ).toEqual({ b: [], w: [] });
  });
  it('S3-R2-2: числа результата словами и дроби', () => {
    const v = (t: string) =>
      resultNumbersIn(t).map((n) => `${n.value}${n.unit}`);
    expect(v('Demo gives an ROI of three hundred percent')).toEqual(['300%']);
    expect(v('Demo makes onboarding ten times faster')).toEqual(['10x']);
    expect(v('Demo gives tenfold growth')).toEqual(['10x']);
    expect(v('Demo робить це у десять разів швидше')).toEqual(['10x']);
    expect(v('Demo зекономив нам сотні годин')).toEqual(['сотні']);
    expect(v('Demo saved us hundreds of hours')).toEqual(['hundreds']);
    expect(v('Demo cut costs to 1/3')).toEqual(['1/3']);
    expect(v('Продажі зросли у два рази')).toEqual(['2x']);
    for (const t of [
      'Demo will grow revenue by three hundred percent.',
      'It makes reports ten times faster.',
      'Demo cut costs to 1/3 in a month.',
      'Demo зекономив нам сотні годин.',
    ])
      expect({ t, b: run(input({ body: `${D}\n\n${t}` })).b }).toEqual({
        t,
        b: ['reddit_unverified_claim'],
      });
    // не утверждения: числительные без единицы, неправильные дроби, без слова результата
    for (const t of [
      'cut it into three or four short posts',
      'Support is not 24/7, so plan ahead.',
      'Mix 1/2 cup of sugar.',
      'There are hundreds of threads about it.',
      'one article, two posts, ten minutes',
    ])
      expect({ t, n: v(t) }).toEqual({ t, n: [] });
  });
  it('S3-R2-3: личный опыт uk/ru латиницей; бренд с цифрами и дефисом — по «скелету»', () => {
    for (const t of [
      'ya ispolzuyu Demo kazhdyi den',
      'ya vykorystovuyu Demo shchodnia',
      'my polzuemsya Demo',
      'ya kupyv Demo',
      'mne ochen pomog Demo',
    ])
      expect({ t, hit: firstPersonMarkers(t).length > 0 }).toEqual({
        t,
        hit: true,
      });
    for (const t of ['My policy is simple', 'my isp is slow', 'Ya know what'])
      expect({ t, hit: firstPersonMarkers(t).length > 0 }).toEqual({
        t,
        hit: false,
      });
    for (const t of ['Dem0', 'D-emo', 'D.emo', 'DEM0', 'Dеm0'])
      expect({ t, hit: brandIn(`founder of ${t} here`, 'Demo') }).toEqual({
        t,
        hit: true,
      });
    expect(brandIn('a demonstration', 'Demo')).toBe(false);
    expect(brandIn('I run Clip', 'C1ip')).toBe(true);
    for (const t of [
      "I've been using Dem0 daily.",
      "I've been using D-emo daily.",
      'ya ispolzuyu Demo kazhdyi den.',
    ])
      expect({ t, b: run(input({ body: `${D}\n\n${t}` })).b }).toEqual({
        t,
        b: ['reddit_fake_testimonial'],
      });
    expect(
      withDisclosure("Disclosure: I'm the founder of Dem0, so I'm biased."),
    ).toEqual({ b: [], w: [] });
  });
  it('S3-R2-4: BLOCK no_brand подсказывает бренд из брифа (params.brand)', () => {
    const r = redditChecks(
      input({
        body: `Я засновник СайтАсіст, тож враховуйте це.${TAIL}`,
        disclosure: 'Я засновник СайтАсіст, тож враховуйте це.',
        brief: { brand: 'SiteAssist' },
      }),
    );
    // раунд 4 (аудит экранов S3-4): подсказка — машиночитаемо, текст делает клиент
    expect(r.blockers).toEqual([
      {
        code: 'reddit_disclosure_missing',
        text: 'reddit_disclosure_missing',
        params: { reason: 'no_brand', brand: 'SiteAssist' },
      },
    ]);
  });
});
