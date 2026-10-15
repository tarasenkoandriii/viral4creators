/**
 * [P-R-ADM] Импорт исследования из Админки (Р-RD-ADM-4, Р-RD-87): CSV
 * (`communities`/`opportunities`/`keywords`, формат `research-import.ts`) →
 * `import/plan` (dry-run: ничего не пишет) → `import/apply` (проект,
 * сообщества, снимки правил `unreviewed`, запросы, валидные возможности; актор
 * admin) → повтор — всё «уже есть», строк не прибавилось; проверенный
 * снимок не перезаписывается (`kept_reviewed`); тело > 1 МБ — 413; ошибки
 * тела — 400 по полям; контакт в CSV не сохраняется; ноль запросов к
 * Reddit (in-process, без HTTP-петли).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  ok,
  redditStack,
  redditWorld,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(240_000);

const COMMUNITIES = `name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at
r/smallbusiness,https://www.reddit.com/r/smallbusiness/,Owners Q&A,null,unknown,unknown,null,"Unverified hint (secondary, 2023): promotion only in weekly threads","https://www.reddit.com/r/smallbusiness/about/rules (not readable); hint: https://www.indiehackers.com/post/list-of-subreddits-72c1129428",2026-10-13
r/SaaS,https://www.reddit.com/r/SaaS/,SaaS founders,null,allowed_with_conditions,restricted,false,Promo only in weekly thread,https://www.reddit.com/r/SaaS/wiki/rules,2026-10-13
`;
const OPPORTUNITIES = `url,title,subreddit,context,intent,date,topic_fit,intent_fit,audience_fit,answerability,promotionality,evidence_gap,context_uncertainty,policy_risk,relevance,risk,priority,gate,gate_reason,why,found_via,checked_at
https://www.reddit.com/r/smallbusiness/comments/1qa2b3c/ai_chat_for_my_shop/,AI chat for my shop?,r/smallbusiness,Owner asks which website chat to try.,recommendation,2026-09,80,75,85,70,60,60,40,100,78,72,22,BLOCK,promotion unknown,"tf: site chat; itf: recommendation; af: owner",search,2026-10-13
https://www.reddit.com/r/SaaS/,New post: pilot call,r/SaaS,ctx,other,n/a,70,70,60,70,30,60,60,20,70,36,45,PASS,OK,,search,2026-10-13
`;
const KEYWORDS = `phrase,intent,priority
AI chatbot for small business website,recommendation,5
website chat for shop,how_to,4
`;
const CONTACT = 'owner.leak@example.org';

const BODY = {
  communitiesCsv: COMMUNITIES,
  opportunitiesCsv: OPPORTUNITIES,
  keywordsCsv: KEYWORDS,
  projectTitle: 'Платформа: дослідження Reddit',
  locale: 'en',
  market: 'US/EU SMB',
};

interface Report {
  apply: boolean;
  productId: string;
  items: Array<{
    kind: string;
    ref: string;
    outcome: string;
    code?: string;
    id?: string;
  }>;
  summary: Record<string, Record<string, number>>;
}

ciDescribe('[P-R-ADM] Админка: импорт исследования CSV (in-process)', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let A: AdminApi;
  let restore: () => void;
  let net: EgressWatch;

  async function counts() {
    const where = { productId: w.product.id };
    return {
      projects: await s.prisma.pubRedditProject.count({ where }),
      communities: await s.prisma.pubRedditCommunity.count({ where }),
      snapshots: await s.prisma.pubRedditRuleSnapshot.count({ where }),
      keywords: await s.prisma.pubRedditKeyword.count({ where }),
      opportunities: await s.prisma.pubRedditOpportunity.count({ where }),
      keys: await s.prisma.pubIdempotencyKey.count({ where }),
    };
  }

  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s, 'working');
    restore = useAdminEnv(w.acc.siteId);
    A = adminApi(s);
    net = watchEgress();
  });
  afterAll(async () => {
    net?.restore();
    restore?.();
    await s?.close();
  });

  it('plan ничего не пишет → apply создаёт (актор admin) → повтор — всё «уже есть»; проверенный снимок — kept_reviewed', async () => {
    const zero = await counts();
    const plan = ok<Report>(await A.postRaw('import/plan', BODY), 200);
    expect(plan.apply).toBe(false);
    expect(plan.productId).toBe(w.product.id);
    expect(plan.summary.project).toEqual({ would_create: 1 });
    expect(plan.summary.community).toEqual({ would_create: 2 });
    expect(plan.summary.keyword).toEqual({ would_create: 2 });
    expect(
      plan.items.filter((i) => i.outcome === 'rejected').map((i) => i.code),
    ).toEqual(['not_thread']);
    expect(await counts()).toEqual(zero);

    const applied = ok<Report>(await A.postRaw('import/apply', BODY), 200);
    expect(applied.apply).toBe(true);
    expect(applied.summary.project).toEqual({ created: 1 });
    expect(applied.summary.community).toEqual({ created: 2 });
    expect(applied.summary.rules).toEqual({ created: 2 });
    expect(applied.summary.keyword).toEqual({ created: 2 });
    expect(applied.summary.opportunity).toEqual({ created: 1, rejected: 1 });
    const after = await counts();
    expect(after).toMatchObject({
      projects: 1,
      communities: 2,
      snapshots: 2,
      keywords: 2,
      opportunities: 1,
    });
    const snaps = await s.prisma.pubRedditRuleSnapshot.findMany({
      where: { productId: w.product.id },
    });
    expect(snaps.map((x) => [x.reviewState, x.createdBy])).toEqual([
      ['unreviewed', `admin:${ADMIN_USER}`],
      ['unreviewed', `admin:${ADMIN_USER}`],
    ]);
    const actors = await s.prisma.pubAuditEvent.findMany({
      where: { productId: w.product.id },
      select: { actor: true },
    });
    expect(new Set(actors.map((a) => a.actor))).toEqual(
      new Set([`admin:${ADMIN_USER}`]),
    );

    const again = ok<Report>(await A.postRaw('import/apply', BODY), 200);
    expect(
      again.items
        .filter((i) => i.outcome !== 'rejected')
        .every((i) => i.outcome === 'exists'),
    ).toBe(true);
    expect(await counts()).toEqual(after);

    // Оператор проверил снимок r/SaaS — повтор импорта его не трогает.
    const saas = applied.items.find(
      (i) => i.kind === 'rules' && /saas/i.test(i.ref),
    )!;
    ok(await A.post(`rx/rules/${saas.id}/review`), 200);
    const changed = {
      ...BODY,
      communitiesCsv: COMMUNITIES.replace(
        'Promo only in weekly thread',
        'Promo only on Saturdays',
      ),
    };
    const third = ok<Report>(await A.postRaw('import/apply', changed), 200);
    expect(
      third.items.find((i) => i.kind === 'rules' && /saas/i.test(i.ref))
        ?.outcome,
    ).toBe('kept_reviewed');
    expect(
      await s.prisma.pubRedditRuleSnapshot.count({
        where: { productId: w.product.id },
      }),
    ).toBe(2);
    expect(net.outbound).toEqual([]);
    expect(net.foreign()).toEqual([]);
  });

  it('тело: > 1 МБ — 413 PUB_PAYLOAD_TOO_LARGE; поля — 400 по полям; без записей', async () => {
    const before = await counts();
    const big = await A.postRaw('import/plan', {
      ...BODY,
      keywordsCsv: `phrase,intent,priority\n${'x'.repeat(1024 * 1024 + 10)},other,1\n`,
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PUB_PAYLOAD_TOO_LARGE');
    const bad = await A.postRaw('import/apply', {
      opportunitiesCsv: 1,
      projectTitle: '',
      locale: 'en_US!',
      market: 'US',
      extra: true,
    });
    expect(bad.status).toBe(400);
    expect(
      (bad.body.error.details.fields as Array<{ field: string; code: string }>)
        .map((f) => `${f.field}:${f.code}`)
        .sort(),
    ).toEqual(
      [
        'communitiesCsv:required',
        'extra:unknown_field',
        'locale:format',
        'opportunitiesCsv:type',
        'projectTitle:required',
      ].sort(),
    );
    expect((await A.postRaw('import/plan', [])).status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it('контакт в CSV не сохраняется ни в одной таблице pub_* и не возвращается', async () => {
    const r = await A.postRaw('import/apply', {
      ...BODY,
      projectTitle: 'Платформа: контакт у CSV',
      communitiesCsv: `name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at
r/leakcheck,https://www.reddit.com/r/leakcheck/,Write ${CONTACT},null,unknown,unknown,null,"Ask mods at ${CONTACT}",https://www.reddit.com/r/leakcheck/about/rules,2026-10-13
`,
      opportunitiesCsv: '',
      keywordsCsv: `phrase,intent,priority
contact ${CONTACT},other,1
`,
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(CONTACT);
    const rejected = (r.body.data as Report).items.filter(
      (i) => i.outcome === 'rejected',
    );
    expect(rejected.map((i) => i.code).sort()).toEqual(['pii', 'pii']);
    expect(rejected.map((i) => i.ref)).toContain(
      '(приховано: схоже на контакт)',
    );
    const tables = await s.prisma.$queryRaw<Array<{ t: string }>>`
      SELECT tablename AS "t" FROM pg_tables
       WHERE schemaname = 'sites' AND tablename LIKE 'pub\\_%' ORDER BY 1`;
    const hits: string[] = [];
    for (const { t } of tables) {
      const rows = await s.prisma.$queryRawUnsafe<Array<{ j: string }>>(
        `SELECT j FROM (SELECT to_jsonb(x)::text AS j FROM "sites"."${t}" x) y WHERE j LIKE '%' || $1 || '%'`,
        CONTACT,
      );
      for (const x of rows) hits.push(`${t}: ${x.j.slice(0, 200)}`);
    }
    expect(hits).toEqual([]);
  });
});
