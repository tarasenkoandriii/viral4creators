/**
 * Сид раздела Reddit (пакет P-R, M1; doc/ai-publisher/reddit-manual-mvp-
 * adapted.md §M1.1 «Seed»): два кабинета; в каждом — продукт `kind=test` и
 * участники TD-02 (PO, ED, OP, AN, SA, VW, admin, владелец); в кабинете A —
 * проект, 10 сообществ (с каналами `community`), снимки правил по четырём
 * сценариям §M1.3 (unknown → block, prohibited → block, stale →
 * recheck_required, новая версия → recheck_required) плюс проверенные,
 * selfReview и «правил нет», 20 возможностей со score v1, 6 ключевых
 * запросов; в кабинете B — проект, сообщество и 2 возможности (изоляция).
 * P-R M2 (Studio, §M2.1): в кабинете A — активная версия оффера, разрешённый
 * источник продукта, comment-бриф `ready` по возможности r/smallbusiness
 * (возможность `in_brief`, контекст — выдержка) с материалом
 * `reddit_comment` и черновиком версии (раскрытие в начале, claimMap), и
 * post-бриф `draft` r/saas без affiliation (`missing`).
 *
 * Данные синтетические (§12 п.3: список сообществ для приёмки — решение
 * владельца): имена сабреддитов публичные, треды — `seedNN`, выдержки —
 * пересказ без ников и контактов. Score и гейт считаются теми же чистыми
 * функциями, что в API (`reddit/{policy,score}`), строки проходят гварды
 * миграции `…_publisher_reddit`. Reddit не запрашивается.
 *
 * Берёт СОБРАННЫЙ код (`npm run build` → dist; другой каталог — `PUB_DIST`):
 *   SITES_DATABASE_URL=… node test/publisher-reddit/seed.cjs /tmp/reddit-seed.json
 */
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const dist = process.env.PUB_DIST ?? path.resolve(__dirname, '../../dist');
const { PrismaService } = require(`${dist}/prisma/prisma.service.js`);
const fx = require(`${dist}/modules/publisher/testing/fixtures.testing.js`);
const policy = require(`${dist}/modules/publisher/reddit/policy.js`);
const score = require(`${dist}/modules/publisher/reddit/score.js`);
const norm = require(`${dist}/modules/publisher/reddit/normalize.js`);
const hash = require(`${dist}/modules/publisher/core/content-hash.js`);
const briefRules = require(`${dist}/modules/publisher/reddit/brief-rules.js`);

const DAY = 86_400_000; // сид: возраст проверки правил (стенд, не прод-арифметика)

/** Сценарии снимков (имя → политика, проверка, возраст проверки). */
const COMMUNITIES = [
  ['saas', 'allowed', { review: 'po' }],
  ['smallbusiness', 'allowed', { review: 'po' }],
  ['shopify', 'allowed', { review: 'po' }],
  ['wordpress', 'allowed', { review: 'po' }],
  ['entrepreneur', 'unknown', { review: 'po' }], // M1.3: unknown → block
  ['marketing', 'promotion_prohibited', { review: 'po' }], // prohibited → block
  ['webdev', 'allowed', { review: 'po', ageDays: 45 }], // stale → recheck_required
  ['ecommerce', 'allowed', { review: 'po', newVersion: 'restricted' }], // новая версия
  ['microsaas', 'restricted', { review: 'ed' }], // selfReview
  ['sideproject', null, {}], // правил нет → block rules_missing
];
const POLICY = {
  allowed: ['allowed_with_conditions', 'allowed'],
  restricted: ['allowed_with_conditions', 'restricted'],
  prohibited_links: ['allowed_with_conditions', 'prohibited'],
  promotion_prohibited: ['prohibited', 'prohibited'],
  unknown: ['unknown', 'unknown'],
};
const INTENTS = [
  'how_to',
  'comparison',
  'alternative',
  'troubleshooting',
  'recommendation',
];

function factorsFor(i) {
  const v = (x) => ({ value: x, why: `оцінка оператора ${x}` });
  return {
    topic_fit: v(60 + (i % 5) * 8),
    intent_fit: v(55 + (i % 4) * 10),
    audience_fit: v(50 + (i % 3) * 15),
    answerability: i % 7 === 6 ? { value: null, why: null } : v(65),
    promotionality: v(20 + (i % 4) * 10),
    evidence_gap: v(30),
    context_uncertainty: v(15 + (i % 3) * 10),
  };
}

async function source(db, p, actor, data) {
  return db.pubSource.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      visibility: 'private',
      usage: 'restricted',
      importedVia: 'manual',
      origin: 'reddit',
      contentHash: hash.sourceContentHash(data.url ?? null, data.fragment),
      createdBy: actor,
      ...data,
    },
  });
}

async function snapshot(
  db,
  p,
  community,
  version,
  scenario,
  author,
  opts = {},
) {
  const [promotionPolicy, linksPolicy] = POLICY[scenario];
  const src = await source(db, p, author, {
    kind: 'url',
    url: `https://www.reddit.com/r/${community.name}/about/rules`,
    title: `Правила спільноти Reddit · v${version}`,
    fragment: `Synthetic rules v${version}: disclose affiliation; ${scenario}.`,
  });
  const s = await db.pubRedditRuleSnapshot.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      communityId: community.id,
      version,
      sourceId: src.id,
      promotionPolicy,
      linksPolicy,
      flairRequired: false,
      conditions: ['Disclose affiliation', 'No referral links'],
      checkedAt: new Date(Date.now() - (opts.ageDays ?? 1) * DAY),
      createdBy: author,
    },
  });
  if (opts.reviewer) {
    return db.pubRedditRuleSnapshot.update({
      where: { id: s.id },
      data: {
        reviewState: 'reviewed',
        reviewedBy: opts.reviewer,
        reviewedAt: new Date(),
        selfReview: opts.reviewer === author,
      },
    });
  }
  return s;
}

async function opportunity(db, p, project, community, snap, i, author, now) {
  const key = `seed${String(i).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;
  const thread = norm.normalizeThreadUrl(
    `https://www.reddit.com/r/${community.name}/comments/${key}/synthetic_thread_${i}`,
  );
  const ex = await source(db, p, author, {
    kind: 'discussion',
    url: thread.url,
    title: `Синтетичний тред ${community.name} · ${i}`,
    fragment:
      'The thread asks how to answer site visitors from existing docs and admit when the answer is unknown.',
  });
  const ps = snap
    ? {
        reviewState: snap.reviewState,
        checkedAt: snap.checkedAt,
        promotionPolicy: snap.promotionPolicy,
        linksPolicy: snap.linksPolicy,
      }
    : null;
  const gate = policy.policyGate(ps, now, 30, 'opportunity', false);
  const factors = score.mergeFactors(
    score.emptyFactors(),
    factorsFor(i),
    policy.policyRisk(ps),
    policy.policyRiskReasons(ps),
  );
  const sc = score.computeScore(factors);
  const status =
    gate.verdict === 'block'
      ? 'blocked'
      : gate.verdict === 'recheck_required'
        ? 'recheck_required'
        : 'new';
  return db.pubRedditOpportunity.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      projectId: project.id,
      communityId: community.id,
      threadUrl: thread.url,
      threadKey: thread.threadKey,
      titleManual: `Synthetic question ${i} in r/${community.name}`,
      excerptSourceId: ex.id,
      intent: INTENTS[i % INTENTS.length],
      factors,
      relevance: sc.relevance,
      risk: sc.risk,
      priority: sc.priority,
      ruleSnapshotId: snap ? snap.id : null,
      policy: gate.verdict,
      policyReasons: gate.reasons,
      status,
      createdBy: author,
    },
  });
}

async function community(db, p, project, name, author) {
  const ch = await db.pubChannel.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      code: `reddit-${name}`,
      name: `r/${name}`,
      kind: 'community',
      utmSource: 'reddit',
      utmMedium: 'community',
      createdBy: author,
    },
  });
  return db.pubRedditCommunity.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      projectId: project.id,
      channelId: ch.id,
      name,
      canonicalUrl: norm.canonicalCommunityUrl(name),
      createdBy: author,
    },
  });
}

async function cabinet(db, label) {
  const acc = await fx.seedAccount(db);
  const product = await fx.seedProduct(db, {
    accountId: acc.accountId,
    siteId: acc.siteId,
    kind: 'test',
    name: `Reddit ${label}`,
  });
  const team = await fx.seedMembers(db, product, acc.owner);
  const ed = `member:${team.editor.memberId}`;
  const po = `member:${team.product_owner.memberId}`;
  const project = await db.pubRedditProject.create({
    data: {
      accountId: acc.accountId,
      productId: product.id,
      name: `Пілот помічника сайту ${label}`,
      locale: 'en',
      market: 'US/EU',
      createdBy: ed,
    },
  });
  const who = (m) => ({
    memberId: m.memberId,
    telegramId: String(m.telegramId),
  });
  return { acc, product, team, project, ed, po, who };
}

const BRAND = 'SiteAssist';
const DISCLOSURE = `Disclosure: I'm the founder of ${BRAND}, the assistant discussed here.`;

/**
 * M2: оффер, источник, comment-бриф ready с материалом и черновиком версии,
 * post-бриф draft без affiliation. Строки проходят гварды миграции M2.
 */
async function seedStudio(db, A, communities, now) {
  const p = A.product;
  const offer = await db.pubOfferVersion.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      version: 1,
      title: 'Синтетичний офер помічника сайту',
      text: 'Помічник відповідає лише з матеріалів сайту; без гарантій заявок.',
      status: 'active',
      approvedBy: A.po,
      approvedAt: now,
      hash: hash.sha256Hex(`seed-offer:${p.id}`),
      createdBy: A.po,
    },
  });
  const fragment =
    'Помічник відповідає лише з опублікованих матеріалів сайту і чесно каже «не знаю».';
  const src = await db.pubSource.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      kind: 'document',
      title: 'Опис помічника (синтетика)',
      fragment,
      usage: 'allowed',
      visibility: 'private',
      contentHash: hash.sourceContentHash(null, fragment),
      createdBy: A.ed,
    },
  });
  const sb = communities.find((c) => c.subreddit === 'smallbusiness');
  const opp = await db.pubRedditOpportunity.findFirst({
    where: { productId: p.id, communityId: sb.id, policy: 'ok' },
    orderBy: { createdAt: 'asc' },
  });
  // new → qualified → in_brief (как сервис: гейт ok, бриф создан).
  for (const status of ['qualified', 'in_brief'])
    await db.pubRedditOpportunity.update({
      where: { id: opp.id },
      data: { status, revision: { increment: 1 } },
    });
  const excerpt = await db.pubSource.findUnique({
    where: { id: opp.excerptSourceId },
  });
  const keyPoints = [
    {
      text: 'The assistant answers only from published site content',
      sourceIds: [src.id],
    },
    {
      text: 'Ask which docs the author already has',
      sourceIds: 'needs_verification',
    },
  ];
  const comment = await db.pubRedditBrief.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      projectId: A.project.id,
      communityId: sb.id,
      opportunityId: opp.id,
      offerVersionId: offer.id,
      contentType: 'comment',
      objective: 'Help the author answer visitors from existing docs',
      audience: 'Small business owners with a docs page',
      context: excerpt.fragment,
      keyPoints,
      affiliation: 'founder',
      brand: BRAND,
      linksAllowed: false,
      tone: 'helpful, plain',
      language: 'en',
      constraints: ['No links'],
      forbiddenClaims: ['guaranteed leads'],
      status: 'ready',
      createdBy: A.ed,
    },
  });
  const content = await db.pubContent.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      kind: 'reddit_comment',
      redditBriefId: comment.id,
      status: 'brief',
      createdBy: A.ed,
    },
  });
  const version = await db.pubContentVersion.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      contentId: content.id,
      number: 1,
      title: briefRules.commentServiceTitle(sb.subreddit, opp.titleManual),
      body: `${DISCLOSURE}\n\nStart from the docs you already have: the assistant answers only from them and says it does not know otherwise.`,
      meta: {
        disclosure: DISCLOSURE,
        claimMap: [
          {
            text: 'The assistant answers only from published site content',
            sourceIds: [src.id],
          },
        ],
        uncertainties: ['Which docs the author already has'],
        flairSuggestion: null,
        ruleSnapshotId: sb.snapshotId,
        affiliation: 'founder',
        threadUrl: opp.threadUrl,
      },
      format: 'reddit_comment',
      offerVersionId: offer.id,
      authorMemberId: A.team.editor.memberId,
      status: 'draft',
      createdBy: A.ed,
    },
  });
  await db.pubContent.update({
    where: { id: content.id },
    data: {
      currentVersionId: version.id,
      status: 'drafting',
      revision: { increment: 1 },
    },
  });
  const saas = communities.find((c) => c.subreddit === 'saas');
  const post = await db.pubRedditBrief.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      projectId: A.project.id,
      communityId: saas.id,
      offerVersionId: offer.id,
      contentType: 'post',
      objective: 'Explain how to keep a site assistant honest',
      keyPoints,
      affiliation: null,
      language: 'en',
      status: 'draft',
      createdBy: A.ed,
    },
  });
  return {
    offerVersionId: offer.id,
    sourceId: src.id,
    commentBriefId: comment.id,
    opportunityId: opp.id,
    contentId: content.id,
    versionId: version.id,
    postBriefId: post.id,
  };
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('укажите файл результата');
  const db = new PrismaService();
  const now = new Date();
  const A = await cabinet(db, 'A');
  const communities = [];
  let i = 0;
  const opps = [];
  for (const [name, scenario, o] of COMMUNITIES) {
    const c = await community(db, A.product, A.project, name, A.ed);
    let snap = null;
    if (scenario) {
      const reviewer = o.review === 'ed' ? A.ed : A.po;
      snap = await snapshot(db, A.product, c, 1, scenario, A.ed, {
        reviewer,
        ageDays: o.ageDays,
      });
    }
    const rows = [];
    for (let k = 0; k < 2; k++) {
      i++;
      rows.push(
        await opportunity(db, A.product, A.project, c, snap, i, A.ed, now),
      );
    }
    if (o.newVersion) {
      // Новая версия: v1 → superseded, возможности → recheck_required (rules_changed).
      await db.pubRedditRuleSnapshot.update({
        where: { id: snap.id },
        data: { status: 'superseded' },
      });
      snap = await snapshot(db, A.product, c, 2, o.newVersion, A.ed, {});
      for (const r of rows)
        await db.pubRedditOpportunity.update({
          where: { id: r.id },
          data: {
            policy: 'recheck_required',
            policyReasons: ['rules_changed'],
            status: 'recheck_required',
            revision: { increment: 1 },
          },
        });
    }
    opps.push(...rows.map((r) => r.id));
    communities.push({
      id: c.id,
      subreddit: name,
      scenario,
      snapshotId: snap?.id ?? null,
    });
  }
  const keywords = [];
  for (const [phrase, intent, priority] of [
    ['AI chat widget for website', 'recommendation', 5],
    ['Intercom Fin alternative', 'alternative', 5],
    ['chatbot answers only from docs', 'how_to', 4],
    ['website assistant says I do not know', 'troubleshooting', 3],
    ['Shopify AI support widget', 'comparison', 4],
    ['GTM chat widget install', 'how_to', 2],
  ]) {
    const k = await db.pubRedditKeyword.create({
      data: {
        accountId: A.acc.accountId,
        productId: A.product.id,
        projectId: A.project.id,
        phrase,
        phraseNorm: norm.phraseNorm(phrase),
        intent,
        priority,
        createdBy: A.ed,
      },
    });
    keywords.push(k.id);
  }

  const studio = await seedStudio(db, A, communities, now);

  const B = await cabinet(db, 'B');
  const cb = await community(db, B.product, B.project, 'saas', B.ed);
  const sb = await snapshot(db, B.product, cb, 1, 'allowed', B.ed, {
    reviewer: B.po,
  });
  const oppsB = [];
  for (let k = 0; k < 2; k++)
    oppsB.push(
      (await opportunity(db, B.product, B.project, cb, sb, 100 + k, B.ed, now))
        .id,
    );

  const team = (c) => ({
    accountId: c.acc.accountId,
    siteId: c.acc.siteId,
    productId: c.product.id,
    projectId: c.project.id,
    owner: c.who(c.acc.owner),
    members: Object.fromEntries(
      [
        'product_owner',
        'editor',
        'operator',
        'analyst',
        'sales',
        'viewer',
        'admin',
      ].map((k) => [k, c.who(c.team[k])]),
    ),
  });
  writeFileSync(
    out,
    JSON.stringify(
      {
        a: { ...team(A), communities, opportunities: opps, keywords, studio },
        b: {
          ...team(B),
          communityId: cb.id,
          snapshotId: sb.id,
          opportunities: oppsB,
        },
      },
      null,
      2,
    ),
  );
  await db.$disconnect();
  console.log(
    `reddit seed: A — 10 сообществ, ${opps.length} возможностей, ${keywords.length} запросов, 2 брифа, 1 материал; B — 1 сообщество, ${oppsB.length} возможности → ${out}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
