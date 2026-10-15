/**
 * P-R — импорт чернового исследования Reddit через HTTP API кабинета
 * (Р-RD-87, CLI `publisher/cli/reddit-import.ts`) против поднятого на своём
 * порту приложения (своя база тестов): dry-run ничего не пишет; `--apply`
 * создаёт проект, сообщества, снимки правил `unreviewed` с пометкой
 * «secondary», ключевые запросы и валидные возможности с факторами;
 * повторный запуск — всё «уже есть», строк не прибавилось; страница правил
 * «not readable» — снимок без первоисточника (`sourceUrl` null, подтвердить
 * нельзя — 400 `source_required`, Р-RD-AUD-3); текущий снимок импорт не
 * вытесняет (`kept_current`, Р-RD-AUD-2); заголовки сессии —
 * только из окружения, их значения не печатаются; ноль запросов к Reddit
 * (сеть — только localhost API, `watchEgress`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { AUTH_ENV, main } from '../../modules/publisher/cli/reddit-import';
import {
  api,
  redditStack,
  redditWorld,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(240_000);

const CSV = {
  'smb-communities.csv': `name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at
r/smallbusiness,https://www.reddit.com/r/smallbusiness/,Owners Q&A,null,unknown,unknown,null,"Unverified hint (secondary, 2023): promotion only in weekly threads","https://www.reddit.com/r/smallbusiness/about/rules (not readable); hint: https://www.indiehackers.com/post/list-of-subreddits-72c1129428",2026-10-13
r/SaaS,https://www.reddit.com/r/SaaS/,SaaS founders,null,allowed_with_conditions,restricted,false,Promo only in weekly thread,https://www.reddit.com/r/SaaS/wiki/rules,2026-10-13
`,
  'smb-opportunities.csv': `url,title,subreddit,context,intent,date,topic_fit,intent_fit,audience_fit,answerability,promotionality,evidence_gap,context_uncertainty,policy_risk,relevance,risk,priority,gate,gate_reason,why,found_via,checked_at
https://www.reddit.com/r/smallbusiness/comments/1qa2b3c/ai_chat_for_my_shop/,AI chat for my shop?,r/smallbusiness,Owner asks which website chat to try.,recommendation,2026-09,80,75,85,70,60,60,40,100,78,72,22,BLOCK,promotion unknown,"tf: site chat; itf: recommendation; af: owner",search,2026-10-13
https://www.reddit.com/r/SaaS/,New post: pilot call,r/SaaS,ctx,other,n/a,70,70,60,70,30,60,60,20,70,36,45,PASS,OK,,search,2026-10-13
`,
  'smb-keywords.csv': `phrase,intent,priority
AI chatbot for small business website,recommendation,5
website chat for shop,how_to,4
`,
  'saas-communities.csv': `name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at,rules_source
r/SaaS,https://www.reddit.com/r/SaaS/,SaaS founders,null,allowed_with_conditions,restricted,false,Promo only in weekly thread,https://www.reddit.com/r/SaaS/wiki/rules,2026-10-13,secondary blog
`,
  'saas-opportunities.csv': `id,url,title,subreddit,context,intent,date,topic_fit,intent_fit,audience_fit,answerability,promotionality,evidence_gap,context_uncertainty,policy_risk,relevance,risk,priority,gate,gate_reason,why,found_via,checked_at,kind
O2,https://www.reddit.com/r/SaaS/comments/1k302zp/chatbase_vs_sitegpt/,Chatbase vs SiteGPT,r/SaaS,Buyer comparing bots.,comparison,unknown,90,85,80,80,55,70,75,50,85,59,35,PASS,OK,"tf: direct; prom: medium",search,2026-10-13,thread
`,
  'saas-keywords.csv': `phrase,intent,priority
website chat for shop,comparison,3
Chatbase alternative,alternative,5
`,
};

ciDescribe('P-R: импорт исследования через API кабинета (Р-RD-87)', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let base: string;
  let dir: string;
  let egress: EgressWatch | null = null;
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  /** fetch CLI: только API стенда; запоминает адреса. */
  const fetchApi: typeof fetch = (input, init) => {
    const url = String(input);
    seen.push(url);
    if (!url.startsWith(base)) throw new Error(`чужой адрес: ${url}`);
    return realFetch(input, init);
  };

  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
    const srv = s.srv() as import('http').Server;
    if (!srv.listening)
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), 'reddit-import-'));
    for (const [f, t] of Object.entries(CSV)) writeFileSync(join(dir, f), t);
  });
  afterAll(async () => {
    egress?.restore();
    rmSync(dir, { recursive: true, force: true });
    await s?.close();
  });

  async function run(extra: string[]) {
    const owner = api(s, w.acc.accountId, w.acc.owner);
    const env = { [AUTH_ENV]: JSON.stringify(owner.headers) };
    const logs: string[] = [];
    const spy = jest
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const err = jest
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    try {
      const r = await main(
        [
          `--base-url=${base}`,
          `--site=${w.acc.siteId}`,
          '--project-title=Pilot research',
          '--locale=en',
          '--market=US/EU SMB',
          `--dir=${dir}`,
          ...extra,
        ],
        env,
        fetchApi,
      );
      return { ...r, logs: logs.join('\n'), headers: owner.headers };
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  }

  const counts = async () => ({
    projects: await s.prisma.pubRedditProject.count({
      where: { productId: w.product.id },
    }),
    communities: await s.prisma.pubRedditCommunity.count({
      where: { productId: w.product.id },
    }),
    snapshots: await s.prisma.pubRedditRuleSnapshot.count({
      where: { productId: w.product.id },
    }),
    keywords: await s.prisma.pubRedditKeyword.count({
      where: { productId: w.product.id },
    }),
    opportunities: await s.prisma.pubRedditOpportunity.count({
      where: { productId: w.product.id },
    }),
  });

  it('dry-run → план и BLOCK, ничего не записано; --apply → создано; повтор → всё «уже есть»; к Reddit — ноль запросов', async () => {
    egress = watchEgress();
    const zero = await counts();
    const dry = await run([]);
    expect(dry.code).toBe(0);
    expect(await counts()).toEqual(zero);
    expect(dry.report!.summary).toEqual({
      opportunity: { rejected: 1, would_create: 2 },
      project: { would_create: 1 },
      community: { would_create: 2 },
      rules: { would_create: 2 },
      keyword: { would_create: 3 },
    });
    expect(dry.logs).toMatch(/dry-run/);
    expect(dry.logs).toMatch(
      /r\/smallbusiness: зараз rules_unreviewed\+promotion_unknown\+links_unknown/,
    );
    // значения заголовков сессии не печатаются — только имена
    for (const v of Object.values(dry.headers))
      expect(dry.logs.includes(v)).toBe(false);
    expect(dry.logs).toMatch(
      /Заголовки сесії: X-Telegram-App, X-Telegram-Init-Data, X-Site-Account/,
    );

    const first = await run(['--apply']);
    expect(first.code).toBe(0);
    expect(first.report!.summary).toEqual({
      opportunity: { rejected: 1, created: 2 },
      project: { created: 1 },
      community: { created: 2 },
      rules: { created: 2 },
      keyword: { created: 3 },
    });
    expect(await counts()).toEqual({
      projects: 1,
      communities: 2,
      snapshots: 2,
      keywords: 3,
      opportunities: 2,
    });
    // правила — непроверенные, с пометкой «secondary»; страница правил
    // «not readable» — первоисточника нет (Р-RD-AUD-3), прочитанная — URL.
    const snaps = await s.prisma.pubRedditRuleSnapshot.findMany({
      where: { productId: w.product.id },
      include: { source: true, community: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const sn of snaps) expect(sn.reviewState).toBe('unreviewed');
    const small = snaps.find((x) => x.community.name === 'smallbusiness')!;
    expect(small.source).toMatchObject({ url: null, kind: 'manual_text' });
    expect(small.conditions).toEqual([
      'Unverified hint (secondary, 2023): promotion only in weekly threads',
      'secondary: rules page not readable; https://www.indiehackers.com/post/list-of-subreddits-72c…',
    ]);
    const saasSnap = snaps.find((x) => x.community.name === 'saas')!;
    expect(saasSnap.source).toMatchObject({
      url: 'https://www.reddit.com/r/SaaS/wiki/rules',
      kind: 'url',
    });
    // сегменты одного CLI-плана сливаются в topics; дубль — предупреждение
    expect(saasSnap.community.topics).toEqual(['saas', 'smb']);
    expect(first.report!.warnings).toEqual(
      expect.arrayContaining([
        {
          kind: 'rules',
          ref: 'smb: r/saas',
          code: 'merged',
          detail: 'rules from segment saas',
        },
      ]),
    );
    expect(first.logs).toMatch(/Попередження \(записано не дослівно\)/);
    expect(first.report!.complete).toBe(true);
    // возможности: факторы и обоснования из CSV, без выдержки
    const opp = await s.prisma.pubRedditOpportunity.findFirstOrThrow({
      where: { productId: w.product.id, threadKey: '1qa2b3c' },
    });
    expect(opp.excerptSourceId).toBeNull();
    expect(opp.angle).toBe(
      'Owner asks which website chat to try. · Found via: search',
    );
    expect(
      (opp.factors as Record<string, { value: number; why: string }>).topic_fit,
    ).toEqual({ value: 80, why: 'site chat' });

    const again = await run(['--apply']);
    expect(again.code).toBe(0);
    expect(again.report!.summary).toEqual({
      opportunity: { rejected: 1, exists: 2 },
      project: { exists: 1 },
      community: { exists: 2 },
      rules: { exists: 2 },
      keyword: { exists: 3 },
    });
    expect(await counts()).toEqual({
      projects: 1,
      communities: 2,
      snapshots: 2,
      keywords: 3,
      opportunities: 2,
    });
    // сеть: только API стенда, к Reddit — ничего
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith(`${base}/publisher/`))).toBe(true);
    expect(egress.outbound).toEqual([]);
    expect(egress.foreign()).toEqual([]);
  });

  it('снимок без первоисточника не подтверждается (400 source_required) — только новый с URL; текущий снимок импорт не вытесняет (kept_current); без заголовков сессии — отказ', async () => {
    const po = api(s, w.acc.accountId, w.team.product_owner);
    const snapOf = (name: string) =>
      s.prisma.pubRedditRuleSnapshot.findFirstOrThrow({
        where: {
          productId: w.product.id,
          status: 'current',
          community: { name },
        },
      });
    const saas = await snapOf('saas');
    expect((await po.post(`${w.P}/rules/${saas.id}/review`, {})).status).toBe(
      200,
    );
    const small = await snapOf('smallbusiness');
    const denied = await po.post(`${w.P}/rules/${small.id}/review`, {});
    expect(denied.status).toBe(400);
    expect(denied.body.error.details.fields).toEqual([
      { field: 'sourceUrl', code: 'source_required' },
    ]);
    // Первоисточник — новым снимком; его подтвердить можно.
    const v2 = await po.post(`${w.P}/communities/${small.communityId}/rules`, {
      sourceUrl: 'https://www.reddit.com/r/smallbusiness/about/rules',
      sourceExcerpt: 'Rule 3: self-promotion only in the weekly thread.',
      promotionPolicy: 'allowed_with_conditions',
      linksPolicy: 'restricted',
      checkedAt: '2026-10-14T09:00:00.000Z',
    });
    expect(v2.status).toBe(201);
    expect(
      (await po.post(`${w.P}/rules/${v2.body.data.id}/review`, {})).status,
    ).toBe(200);
    const before = await s.prisma.pubRedditRuleSnapshot.count({
      where: { productId: w.product.id },
    });
    const again = await run(['--apply']);
    expect(again.report!.summary.rules).toEqual({ exists: 2 });
    expect(
      again.report!.items.filter((i) => i.kind === 'rules').map((i) => i.code),
    ).toEqual(['kept_current', 'kept_current']);
    expect(
      await s.prisma.pubRedditRuleSnapshot.count({
        where: { productId: w.product.id },
      }),
    ).toBe(before);
    const none = await main(
      [
        `--base-url=${base}`,
        `--product=${w.product.id}`,
        '--project-title=x',
        `--dir=${dir}`,
      ],
      {},
      fetchApi,
    );
    expect(none.code).toBe(1);
  });

  it('Р-RD-AUD-9: два одновременных импорта разных сегментов (общее r/SaaS) — снимок правил один; второй — kept_current (сервер: ifNoCurrent → 200 kept)', async () => {
    const w2 = await redditWorld(s);
    const owner = api(s, w2.acc.accountId, w2.acc.owner);
    // Проект заведён заранее — оба импорта находят его по названию.
    expect(
      (
        await owner.post(`${w2.P}/projects`, {
          title: 'Race research',
          locale: 'en',
          market: 'US/EU SMB',
        })
      ).status,
    ).toBe(201);
    // Барьер: список сообществ отдаётся обоим импортам только после того, как
    // оба его запросили, — оба видят «текущего снимка нет» и идут создавать.
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const listRe = /\/reddit\/communities(\?|$)/;
    const racing: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith(base)) throw new Error(`чужой адрес: ${url}`);
      if ((init?.method ?? 'GET') === 'GET' && listRe.test(url)) {
        const res = await realFetch(input, init);
        if (++waiting === 2) release();
        await barrier;
        return res;
      }
      return realFetch(input, init);
    };
    const env = { [AUTH_ENV]: JSON.stringify(owner.headers) };
    const one = (segment: string) =>
      main(
        [
          `--base-url=${base}`,
          `--site=${w2.acc.siteId}`,
          '--project-title=Race research',
          '--locale=en',
          '--market=US/EU SMB',
          `--dir=${dir}`,
          `--segments=${segment}`,
          '--apply',
        ],
        env,
        racing,
      );
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let reports: Awaited<ReturnType<typeof main>>[];
    try {
      reports = await Promise.all([one('smb'), one('saas')]);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const saas = await s.prisma.pubRedditCommunity.findFirstOrThrow({
      where: { productId: w2.product.id, name: 'saas' },
    });
    expect(
      await s.prisma.pubRedditRuleSnapshot.count({
        where: { productId: w2.product.id, communityId: saas.id },
      }),
    ).toBe(1);
    const rulesOf = (i: number) =>
      reports[i]
        .report!.items.filter((x) => x.kind === 'rules' && x.ref === 'r/saas')
        .map((x) => [x.outcome, x.code ?? null]);
    expect([...rulesOf(0), ...rulesOf(1)].sort()).toEqual([
      ['created', null],
      ['exists', 'kept_current'],
    ]);
    // Прямой вызов: ifNoCurrent при текущем снимке — 200, тот же снимок, kept.
    const snap = await s.prisma.pubRedditRuleSnapshot.findFirstOrThrow({
      where: { productId: w2.product.id, communityId: saas.id },
    });
    const kept = await owner.post(`${w2.P}/communities/${saas.id}/rules`, {
      sourceUrl: 'https://www.reddit.com/r/SaaS/wiki/rules',
      sourceExcerpt: 'Promo only in the weekly thread.',
      promotionPolicy: 'prohibited',
      linksPolicy: 'prohibited',
      checkedAt: '2026-10-14T09:00:00.000Z',
      ifNoCurrent: true,
    });
    expect(kept.status).toBe(200);
    expect(kept.body.data).toMatchObject({
      id: snap.id,
      kept: true,
      status: 'current',
    });
    expect(
      await s.prisma.pubRedditRuleSnapshot.count({
        where: { productId: w2.product.id, communityId: saas.id },
      }),
    ).toBe(1);
    const bad = await owner.post(`${w2.P}/communities/${saas.id}/rules`, {
      sourceUrl: 'https://www.reddit.com/r/SaaS/wiki/rules',
      sourceExcerpt: 'x',
      promotionPolicy: 'prohibited',
      linksPolicy: 'prohibited',
      checkedAt: '2026-10-14T09:00:00.000Z',
      ifNoCurrent: 'yes',
    });
    expect(bad.status).toBe(400);
  });
});
