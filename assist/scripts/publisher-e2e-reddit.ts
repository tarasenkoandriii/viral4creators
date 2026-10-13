/**
 * AI Publisher, P-R — сквозной маршрут E2E-RD-01 (reddit-manual-mvp-
 * adapted.md §M1.2, §M1.6) против НАСТОЯЩЕГО sites-backend с
 * `PUBLISHER_REDDIT_ENABLED=true` через HTTP-клиент кабинета
 * (`src/lib/publisher/reddit-api.ts` — те же функции и декодеры, что у
 * экранов): проект → 10 сообществ → снимки правил и их проверка →
 * 6 запросов → 20 возможностей → score → блокировки (A03), новая версия
 * правил (A04), дубли (A05), чужое сообщество в ссылке (A15), роли (A02),
 * чужой кабинет (A01), списки/CSV, импорт Reddit-URL (`reddit_manual_only`).
 *
 * Не `*.test.ts`: нужен стенд (`scripts/publisher-e2e.sh --reddit` в корне).
 *   PUB_E2E_API=http://localhost:4441 PUB_E2E_SEED=/tmp/seed.json \
 *   PUB_E2E_OUT=/tmp/e2e-reddit.json npx tsx scripts/publisher-e2e-reddit.ts
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ApiError, createApiClient } from '../src/kit';
import {
  createPublisherHttp,
  createRawGet,
} from '../src/lib/publisher/common-api';
import * as content from '../src/lib/publisher/content-api';
import * as core from '../src/lib/publisher/core-api';
import * as R from '../src/lib/publisher/reddit-api';
import * as V from '../src/lib/publisher/reddit-view';

const API = (process.env.PUB_E2E_API ?? 'http://localhost:4441').replace(
  /\/$/,
  ''
);
const CRON_SECRET = process.env.PUB_E2E_CRON_SECRET ?? 'e2e-cron-secret';
/** Сдвиг часов стенда относительно часов драйвера (initData — по стенду). */
let clockOffsetMs = 0;
/** Перевести часы стенда вперёд (`/__stand/publisher/clock`, только стенд). */
async function advanceStandClock(ms: number): Promise<string> {
  const r = await fetch(`${API}/__stand/publisher/clock`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ advanceMs: ms }),
  });
  const j = (await r.json()) as { data?: { now?: string } };
  const now = j.data?.now;
  if (r.status !== 200 || !now) throw new Error(`часы стенда: ${r.status}`);
  clockOffsetMs = Date.parse(now) - Date.now();
  return now;
}
const BOT_TOKEN =
  process.env.PUB_E2E_BOT_TOKEN ?? '111111:AA-тестовый-токен-помощника';

interface SeedMember {
  memberId: string;
  telegramId: string;
}
interface Seed {
  accountId: string;
  siteId: string;
  owner: SeedMember;
  members: Record<
    'product_owner' | 'editor' | 'operator' | 'analyst' | 'sales' | 'viewer',
    SeedMember
  >;
  other: { accountId: string; siteId: string; owner: SeedMember };
}
const seed = JSON.parse(
  readFileSync(process.env.PUB_E2E_SEED ?? '/tmp/pub-e2e-seed.json', 'utf8')
) as Seed;

function initData(userId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor((Date.now() + clockOffsetMs) / 1000)),
    query_id: 'AAE-e2e-rd',
    user: JSON.stringify({
      id: Number(userId),
      first_name: 'E2E',
      username: `e2e${userId}`,
      language_code: 'uk',
    }),
  };
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function clientOf(m: SeedMember, accountId = seed.accountId) {
  const opts = {
    baseUrl: API,
    auth: () => ({
      headers: {
        'X-Telegram-App': 'assist',
        'X-Telegram-Init-Data': initData(m.telegramId),
      },
      credentials: 'omit' as RequestCredentials,
    }),
    accountId: () => accountId,
    locale: () => 'uk',
  };
  const http = createPublisherHttp(createApiClient(opts), createRawGet(opts));
  return {
    http,
    core: core.createCoreApi(http),
    content: (pid: string) => content.createContentApi(http, pid),
    rd: (pid: string) => R.createRedditApi(http, pid),
  };
}

// ── Протокол шагов ───────────────────────────────────────────────────────

interface StepResult {
  e2e: string;
  step: string;
  status: 'passed' | 'failed';
  evidence?: unknown;
  error?: string;
}
const results: StepResult[] = [];
class Check extends Error {}
function expect(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new Check(msg);
}
function errText(e: unknown): string {
  if (e instanceof ApiError)
    return `${e.code} ${e.status}: ${JSON.stringify(e.details ?? null)}`;
  if (e instanceof Check) return `Check: ${e.message}`;
  return e instanceof Error
    ? `${e.name}: ${e.message}${(e.stack ?? '').split('\n').slice(1, 4).join(' ')}`
    : String(e);
}
const E = 'E2E-RD-01';
async function step<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    const evidence = await fn();
    results.push({ e2e: E, step: name, status: 'passed', evidence });
    console.log(`ok   ${name}`);
    return evidence;
  } catch (e) {
    results.push({ e2e: E, step: name, status: 'failed', error: errText(e) });
    console.log(`FAIL ${name}: ${errText(e)}`);
    return undefined;
  }
}
async function errOf(p: Promise<unknown>) {
  try {
    await p;
    return { code: 'OK', status: 200, details: {} as Record<string, unknown> };
  } catch (e) {
    if (e instanceof ApiError)
      return {
        code: e.code,
        status: e.status,
        details: (e.details ?? {}) as Record<string, unknown>,
      };
    throw e;
  }
}
const key = () => randomUUID();
const letters = () =>
  randomUUID()
    .replace(/-/g, '')
    .slice(0, 6)
    .replace(/[0-9]/g, (d: string) => 'ghijklmnop'[Number(d)]);
const DAY = 86_400_000; // стенд: дата проверки правил в прошлом
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// Целочисленная формула score v1 (§M1.4) — независимая сверка ответа.
const rdiv = (num: number, den: number) =>
  Math.floor((2 * num + den) / (2 * den));
function expectedScore(f: Record<string, number>, policyRisk: number) {
  const relevance = rdiv(
    35 * f.topic_fit +
      25 * f.intent_fit +
      20 * f.audience_fit +
      20 * f.answerability,
    100
  );
  const risk = rdiv(
    40 * policyRisk +
      25 * f.promotionality +
      20 * f.evidence_gap +
      15 * f.context_uncertainty,
    100
  );
  return { relevance, risk, priority: rdiv(relevance * (100 - risk), 100) };
}

// ── Стенд ────────────────────────────────────────────────────────────────

const owner = clientOf(seed.owner);
const as = Object.fromEntries(
  Object.entries(seed.members).map(([k, m]) => [k, clientOf(m)])
) as Record<keyof Seed['members'], ReturnType<typeof clientOf>>;
const ctx: {
  pid: string;
  projectId: string;
  communities: Record<string, R.RedditCommunityView>;
  snapshots: Record<string, R.RedditRuleSnapshotView>;
  keywords: R.RedditKeywordView[];
  opportunities: R.RedditOpportunityView[];
} = {
  pid: '',
  projectId: '',
  communities: {},
  snapshots: {},
  keywords: [],
  opportunities: [],
};

/** Сценарии §M1.3 (как сид P-R): имя, ввод, правила, кто проверяет. */
const COMMUNITIES: Array<{
  name: string;
  input: (n: string) => string;
  rules: null | {
    promotion: R.RedditPromotionPolicy;
    links: R.RedditLinksPolicy;
    review: 'po' | 'ed' | null;
    ageDays?: number;
  };
  verdict: R.RedditPolicyVerdict;
  reason?: R.RedditPolicyReason;
}> = [
  {
    name: 'saas',
    input: (n) => `r/${n.toUpperCase()}`,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'allowed',
      review: 'po',
    },
    verdict: 'ok',
  },
  {
    name: 'smallbusiness',
    input: (n) => `https://old.reddit.com/r/${n}/top/?t=week`,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'allowed',
      review: 'po',
    },
    verdict: 'ok',
  },
  {
    name: 'shopify',
    input: (n) => n,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'allowed',
      review: 'po',
    },
    verdict: 'ok',
  },
  {
    name: 'wordpress',
    input: (n) => `/r/${n}/`,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'prohibited',
      review: 'po',
    },
    verdict: 'ok',
  },
  {
    name: 'entrepreneur',
    input: (n) => `www.reddit.com/r/${n}`,
    rules: { promotion: 'unknown', links: 'unknown', review: 'po' },
    verdict: 'block',
    reason: 'promotion_unknown',
  },
  {
    name: 'marketing',
    input: (n) => `https://m.reddit.com/r/${n}`,
    rules: { promotion: 'prohibited', links: 'prohibited', review: 'po' },
    verdict: 'block',
    reason: 'promotion_prohibited',
  },
  {
    name: 'webdev',
    input: (n) => `r/${n}`,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'allowed',
      review: 'po',
      ageDays: 45,
    },
    verdict: 'recheck_required',
    reason: 'rules_stale',
  },
  {
    name: 'ecommerce',
    input: (n) => `r/${n}`,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'allowed',
      review: 'po',
    },
    verdict: 'ok',
  },
  {
    name: 'microsaas',
    input: (n) => `r/${n}`,
    rules: {
      promotion: 'allowed_with_conditions',
      links: 'restricted',
      review: 'ed',
    },
    verdict: 'ok',
  },
  {
    name: 'sideproject',
    input: (n) => `r/${n}`,
    rules: null,
    verdict: 'block',
    reason: 'rules_missing',
  },
];
const RISK: Record<R.RedditLinksPolicy, number> = {
  allowed: 20,
  restricted: 50,
  prohibited: 60,
  unknown: 100,
};
const FACTORS = {
  topic_fit: 80,
  intent_fit: 70,
  audience_fit: 60,
  answerability: 70,
  promotionality: 30,
  evidence_gap: 40,
  context_uncertainty: 20,
};
const factorsIn = (over: Partial<typeof FACTORS> = {}, nullKey?: string) =>
  Object.fromEntries(
    Object.entries({ ...FACTORS, ...over }).map(([k, v]) => [
      k,
      k === nullKey
        ? { value: null, why: null }
        : { value: v, why: `обґрунтування ${k}` },
    ])
  ) as R.RedditFactorsInput;

async function main(): Promise<void> {
  await step('SETUP: продукт и роли (6 участников)', async () => {
    const p = await owner.core.createProduct(seed.siteId, {
      name: `E2E RD ${letters()}`,
      kind: 'working',
    });
    ctx.pid = p.id;
    for (const [role, m] of Object.entries(seed.members))
      await owner.core.grant(p.id, {
        memberId: m.memberId,
        role: role as core.RoleGrantView['role'],
      });
    const again = await as.viewer.core.product(p.id);
    expect(
      again.features.reddit === true,
      'features.reddit ≠ true при включённом флаге'
    );
    return { pid: p.id, features: again.features };
  });
  const pid = ctx.pid;
  const ed = as.editor.rd(pid);
  const po = as.product_owner.rd(pid);
  const vw = as.viewer.rd(pid);

  await step('A01/A02: роли и изоляция кабинета', async () => {
    const sales = await errOf(as.sales.rd(pid).projects());
    expect(
      sales.code === 'PUB_ROLE_REQUIRED' && sales.status === 403,
      `sales: ${sales.code}`
    );
    const viewerList = await vw.projects();
    const viewerCreate = await errOf(
      vw.createProject(key(), { title: 'x', locale: 'uk', market: 'UA' })
    );
    expect(
      viewerCreate.code === 'PUB_ROLE_REQUIRED',
      `viewer create: ${viewerCreate.code}`
    );
    const opCreate = await errOf(
      as.operator
        .rd(pid)
        .createProject(key(), { title: 'x', locale: 'uk', market: 'UA' })
    );
    expect(
      opCreate.code === 'PUB_ROLE_REQUIRED',
      `operator create: ${opCreate.code}`
    );
    const foreign = clientOf(seed.other.owner, seed.other.accountId).rd(pid);
    const cross = await errOf(foreign.projects());
    expect(
      cross.status === 404 && cross.code === 'PUB_NOT_FOUND',
      `чужой кабинет: ${cross.code}`
    );
    return {
      sales: sales.code,
      viewerList: viewerList.items.length,
      viewerCreate: viewerCreate.code,
      cross: cross.code,
    };
  });

  await step(
    'проект: создание редактором, правка CAS, 409 на старой ревизии',
    async () => {
      const body = V.projectBody({
        title: 'SaaS UA E2E',
        locale: 'uk',
        market: 'UA',
      });
      expect(body, 'тело проекта');
      const p = await ed.createProject(key(), body);
      ctx.projectId = p.id;
      const p2 = await ed.patchProject(p.id, key(), {
        expectedRevision: p.revision,
        market: 'UA/EU',
      });
      const stale = await errOf(
        ed.patchProject(p.id, key(), {
          expectedRevision: p.revision,
          market: 'X',
        })
      );
      expect(stale.code === 'PUB_CONFLICT', `CAS: ${stale.code}`);
      const bad = await errOf(
        ed.createProject(key(), { title: 'x', locale: 'ukr_UA', market: 'UA' })
      );
      expect(bad.code === 'PUB_VALIDATION', `locale: ${bad.code}`);
      return {
        id: p.id,
        revision: p2.revision,
        market: p2.market,
        stale: stale.details,
      };
    }
  );

  await step(
    '10 сообществ: нормализация r/name и URL, канал community, дубль, мусор',
    async () => {
      for (const c of COMMUNITIES) {
        const input = c.input(c.name);
        expect(V.normalizeSubreddit(input) === c.name, `клиент: ${input}`);
        const body = V.communityBody(ctx.projectId, {
          community: input,
          descriptionManual: '',
          language: 'en',
          topics: 'saas, b2b',
        });
        expect(body, `тело ${input}`);
        const v = await ed.createCommunity(key(), body);
        expect(v.subreddit === c.name, `${input} → ${v.subreddit}`);
        expect(
          v.canonicalUrl === `https://www.reddit.com/r/${c.name}`,
          v.canonicalUrl
        );
        expect(
          v.rules === null && v.channelId && v.staleDays === 30,
          'новое сообщество'
        );
        ctx.communities[c.name] = v;
      }
      const dup = await errOf(
        ed.createCommunity(key(), {
          projectId: ctx.projectId,
          community: 'https://www.reddit.com/r/SaaS/',
        })
      );
      expect(
        dup.code === 'PUB_CONFLICT' &&
          dup.details.reason === 'duplicate' &&
          dup.details.existingId === ctx.communities.saas.id,
        `дубль: ${JSON.stringify(dup)}`
      );
      const bad = await errOf(
        ed.createCommunity(key(), {
          projectId: ctx.projectId,
          community: 'https://evil.com/r/saas',
        })
      );
      expect(bad.code === 'PUB_VALIDATION', `мусор: ${bad.code}`);
      const page = await vw.communities({
        projectId: ctx.projectId,
        limit: 100,
      });
      expect(page.items.length === 10, `в списке ${page.items.length}`);
      return { count: page.items.length, dup: dup.details, bad: bad.details };
    }
  );

  await step(
    'правила: снимки, проверка (PO), selfReview (ED), VW → 403, повтор → 409',
    async () => {
      const out: Record<string, unknown> = {};
      for (const c of COMMUNITIES) {
        if (!c.rules) continue;
        const comm = ctx.communities[c.name];
        const res = V.rulesBody(
          {
            sourceUrl: `https://www.reddit.com/r/${c.name}/about/rules`,
            sourceExcerpt: `Правила r/${c.name}: самореклама лише в щотижневому треді; <img src=x onerror=alert(1)>`,
            promotionPolicy: c.rules.promotion,
            linksPolicy: c.rules.links,
            flair: 'unknown',
            conditions: 'лише щотижневий тред\n10:1',
            checkedAt: iso((c.rules.ageDays ?? 0) * DAY + 60_000),
          },
          new Date()
        );
        expect(res.body, `правила ${c.name}: ${res.issues}`);
        const s = await ed.createRules(comm.id, key(), res.body);
        expect(
          s.reviewState === 'unreviewed' &&
            s.gate.verdict === 'block' &&
            s.gate.reasons.includes('rules_unreviewed'),
          `${c.name}: новый снимок не block`
        );
        expect(
          s.source.excerpt.includes('<img src=x onerror=alert(1)>'),
          'выдержка хранится как текст, без «очистки»'
        );
        if (c.name === 'saas') {
          const v403 = await errOf(vw.reviewRules(s.id, key()));
          expect(
            v403.code === 'PUB_ROLE_REQUIRED',
            `viewer review: ${v403.code}`
          );
          out.viewerReview = v403.code;
        }
        const reviewer = c.rules.review === 'ed' ? ed : po;
        const r = await reviewer.reviewRules(s.id, key());
        expect(r.reviewState === 'reviewed', 'review');
        expect(
          r.selfReview === (c.rules.review === 'ed'),
          `${c.name}: selfReview=${r.selfReview}`
        );
        ctx.snapshots[c.name] = r;
        if (c.name === 'saas') {
          const again = await errOf(po.reviewRules(s.id, key()));
          expect(
            again.code === 'PUB_TRANSITION_INVALID' &&
              again.details.reason === 'already_reviewed',
            `повтор: ${JSON.stringify(again)}`
          );
          out.again = again.details.reason;
        }
        const cv = await vw.community(comm.id);
        expect(
          cv.rules && cv.rules.gate.verdict === c.verdict,
          `${c.name}: гейт ${cv.rules?.gate.verdict} ≠ ${c.verdict}`
        );
        if (c.reason)
          expect(
            cv.rules!.gate.reasons.includes(c.reason),
            `${c.name}: нет ${c.reason}`
          );
        out[c.name] = {
          verdict: cv.rules!.gate.verdict,
          reasons: cv.rules!.gate.reasons,
          state: cv.rules!.state,
          selfReview: cv.rules!.selfReview,
        };
      }
      const future = await errOf(
        ed.createRules(ctx.communities.saas.id, key(), {
          sourceUrl: 'https://www.reddit.com/r/saas/about/rules',
          sourceExcerpt: 'x',
          promotionPolicy: 'unknown',
          linksPolicy: 'unknown',
          checkedAt: new Date(Date.now() + 3 * DAY).toISOString(),
        })
      );
      expect(
        future.code === 'PUB_VALIDATION' &&
          JSON.stringify(future.details).includes('future'),
        `будущее: ${JSON.stringify(future)}`
      );
      const side = await vw.community(ctx.communities.sideproject.id);
      expect(side.rules === null, 'sideproject без правил');
      return out;
    }
  );

  await step('6 ключевых запросов, дубль нормальной формы → 409', async () => {
    const phrases: Array<[string, R.RedditIntent, number]> = [
      ['best CRM for startups', 'recommendation', 5],
      ['crm vs spreadsheet', 'comparison', 4],
      ['alternative to hubspot', 'alternative', 4],
      ['how to track leads', 'how_to', 3],
      ['crm sync broken', 'troubleshooting', 2],
      ['small team sales tools', 'discussion', 3],
    ];
    for (const [phrase, intent, priority] of phrases) {
      const body = V.keywordBody(ctx.projectId, {
        phrase,
        intent,
        locale: 'en',
        priority: String(priority),
      });
      expect(body, phrase);
      ctx.keywords.push(await ed.createKeyword(key(), body));
    }
    const dup = await errOf(
      ed.createKeyword(key(), {
        projectId: ctx.projectId,
        phrase: '  Best   CRM for STARTUPS ',
        intent: 'other',
        priority: 1,
      })
    );
    expect(
      dup.code === 'PUB_CONFLICT' &&
        dup.details.existingId === ctx.keywords[0].id,
      `дубль запроса: ${JSON.stringify(dup)}`
    );
    return { count: ctx.keywords.length, norm: ctx.keywords[0].phraseNorm };
  });

  await step(
    '20 возможностей: тред → канон, факторы, score v1, гейт по сценарию',
    async () => {
      let i = 0;
      const out: Array<Record<string, unknown>> = [];
      for (const c of COMMUNITIES) {
        for (let j = 0; j < 2; j++) {
          i++;
          const comm = ctx.communities[c.name];
          const nullKey = i === 2 ? 'evidence_gap' : undefined;
          const form: V.OpportunityForm = {
            communityId: comm.id,
            threadUrl: `https://${j ? 'old' : 'www'}.reddit.com/r/${c.name}/comments/e2e${i}k/thread_${i}/?utm_source=share#c1`,
            titleManual: `Тред ${i}: яку CRM обрати?`,
            excerpt:
              i === 1
                ? '<script>alert(1)</script> **жирний** — шукаємо CRM до $50'
                : '',
            intent: 'recommendation',
            angle: '',
            keywordIds: [ctx.keywords[i % 6].id],
            factors: V.factorForm(null),
          };
          for (const [k, v] of Object.entries(factorsIn({}, nullKey)))
            form.factors[k as R.RedditOperatorFactor] = {
              value: v!.value === null ? '' : String(v!.value),
              why: v!.why ?? '',
            };
          const res = V.opportunityBody(ctx.projectId, form, comm);
          expect(res.body, `тело ${i}: ${res.issues}`);
          const o = await ed.createOpportunity(key(), res.body);
          expect(
            o.threadUrl ===
              `https://www.reddit.com/r/${c.name}/comments/e2e${i}k/thread_${i}`,
            `канон ${o.threadUrl}`
          );
          expect(o.threadKey === `e2e${i}k`, o.threadKey);
          expect(
            o.policy === c.verdict,
            `${c.name}: policy ${o.policy} ≠ ${c.verdict}`
          );
          const st =
            c.verdict === 'ok'
              ? 'new'
              : c.verdict === 'block'
                ? 'blocked'
                : 'recheck_required';
          expect(o.status === st, `${c.name}: status ${o.status} ≠ ${st}`);
          if (c.reason)
            expect(
              o.policyReasons.includes(c.reason),
              `${c.name}: причины ${o.policyReasons}`
            );
          const risk =
            c.rules && c.rules.promotion === 'allowed_with_conditions'
              ? RISK[c.rules.links]
              : 100;
          expect(
            o.factors.policy_risk.value === risk,
            `${c.name}: policy_risk ${o.factors.policy_risk.value} ≠ ${risk}`
          );
          // Раунд исправлений: обоснование policy_risk — коды, не текст.
          const riskCodes = c.rules
            ? [`promotion_${c.rules.promotion}`, `links_${c.rules.links}`]
            : ['rules_missing'];
          expect(
            o.factors.policy_risk.why === null &&
              JSON.stringify(o.factors.policy_risk.reasons) ===
                JSON.stringify(riskCodes),
            `${c.name}: policy_risk ${JSON.stringify(o.factors.policy_risk)}`
          );
          expect(
            o.policyNow === o.policy &&
              JSON.stringify(o.policyNowReasons) ===
                JSON.stringify(o.policyReasons),
            `${c.name}: policyNow ${o.policyNow} ≠ policy ${o.policy}`
          );
          if (nullKey) {
            expect(
              o.score.risk === null &&
                o.score.priority === null &&
                o.score.missing.includes('evidence_gap') &&
                o.factors.evidence_gap.value === null,
              'null-фактор → risk null, не 0'
            );
          } else {
            const exp = expectedScore(FACTORS, risk);
            expect(
              o.score.relevance === exp.relevance &&
                o.score.risk === exp.risk &&
                o.score.priority === exp.priority,
              `${c.name}: score ${JSON.stringify(o.score)} ≠ ${JSON.stringify(exp)}`
            );
          }
          if (i === 1)
            expect(
              o.excerpt?.text.startsWith('<script>alert(1)</script>'),
              'выдержка — как есть (текст)'
            );
          ctx.opportunities.push(o);
          out.push({
            c: c.name,
            policy: o.policy,
            status: o.status,
            score: o.score,
          });
        }
      }
      const all = await vw.opportunities({
        projectId: ctx.projectId,
        limit: 100,
      });
      expect(all.items.length === 20, `в списке ${all.items.length}`);
      return { created: out.length, sample: out.slice(0, 3) };
    }
  );

  await step(
    'A05/A15/ПД: дубль треда, чужое сообщество в ссылке, контакт в выдержке, policy_risk',
    async () => {
      const saas = ctx.communities.saas;
      const base = {
        projectId: ctx.projectId,
        communityId: saas.id,
        titleManual: 't',
        intent: 'how_to' as const,
      };
      const before = (
        await vw.opportunities({ projectId: ctx.projectId, limit: 100 })
      ).items.length;
      const dup = await errOf(
        ed.createOpportunity(key(), {
          ...base,
          threadUrl: 'https://m.reddit.com/r/saas/comments/E2E1K/other_slug',
        })
      );
      expect(
        dup.code === 'PUB_CONFLICT' &&
          dup.details.reason === 'duplicate' &&
          dup.details.existingId === ctx.opportunities[0].id,
        `дубль: ${JSON.stringify(dup)}`
      );
      const mm = await errOf(
        ed.createOpportunity(key(), {
          ...base,
          threadUrl: 'https://www.reddit.com/r/marketing/comments/zz1/x',
        })
      );
      expect(
        mm.code === 'PUB_VALIDATION' &&
          JSON.stringify(mm.details).includes('community_mismatch'),
        `A15: ${JSON.stringify(mm)}`
      );
      expect(
        V.threadMismatch(
          'https://www.reddit.com/r/marketing/comments/zz1/x',
          saas
        )?.url === 'marketing',
        'клиент видит несовпадение'
      );
      const short = await errOf(
        ed.createOpportunity(key(), {
          ...base,
          threadUrl: 'https://redd.it/zz2',
        })
      );
      expect(short.code === 'PUB_VALIDATION', `redd.it: ${short.code}`);
      const pii = await errOf(
        ed.createOpportunity(key(), {
          ...base,
          threadUrl: 'https://www.reddit.com/r/saas/comments/zz3/x',
          excerpt: 'пишіть на test.user@example.com або +380671234567',
        })
      );
      expect(
        pii.code === 'PUB_VALIDATION' &&
          JSON.stringify(pii.details).includes('pii'),
        `ПД: ${JSON.stringify(pii)}`
      );
      const derived = await errOf(
        ed.createOpportunity(key(), {
          ...base,
          threadUrl: 'https://www.reddit.com/r/saas/comments/zz4/x',
          factors: {
            policy_risk: { value: 0, why: 'x' },
          } as unknown as R.RedditFactorsInput,
        })
      );
      expect(
        derived.code === 'PUB_VALIDATION' &&
          JSON.stringify(derived.details).includes('derived'),
        `policy_risk: ${JSON.stringify(derived)}`
      );
      const after = (
        await vw.opportunities({ projectId: ctx.projectId, limit: 100 })
      ).items.length;
      expect(before === after, `строк прибавилось: ${before} → ${after}`);
      return {
        dup: dup.details,
        mismatch: mm.details,
        pii: pii.code,
        derived: derived.code,
        rows: after,
      };
    }
  );

  await step(
    'A03: блокировки — qualify из blocked → 409 policy_block, score 100 не снимает',
    async () => {
      const blocked = ctx.opportunities.find(
        (o) => o.subreddit === 'entrepreneur'
      )!;
      const hi = Object.fromEntries(
        Object.keys(FACTORS).map((k) => [
          k,
          k === 'promotionality' ||
          k === 'evidence_gap' ||
          k === 'context_uncertainty'
            ? 0
            : 100,
        ])
      );
      const patched = await ed.patchOpportunity(blocked.id, key(), {
        expectedRevision: blocked.revision,
        factors: factorsIn(hi as Partial<typeof FACTORS>),
      });
      expect(
        patched.score.relevance === 100 &&
          patched.policy === 'block' &&
          patched.status === 'blocked',
        `после score 100: ${patched.policy}/${patched.status}`
      );
      const q = await errOf(
        ed.transitionOpportunity(blocked.id, 'qualify', key(), {
          expectedRevision: patched.revision,
        })
      );
      expect(
        q.code === 'PUB_TRANSITION_INVALID' &&
          q.details.reason === 'policy_block' &&
          Array.isArray(q.details.reasons) &&
          (q.details.reasons as string[]).includes('promotion_unknown'),
        `qualify blocked: ${JSON.stringify(q)}`
      );
      const missing = ctx.opportunities.find(
        (o) => o.subreddit === 'sideproject'
      )!;
      const q2 = await errOf(
        ed.transitionOpportunity(missing.id, 'qualify', key(), {
          expectedRevision: missing.revision,
        })
      );
      expect(
        q2.details.reason === 'policy_block' &&
          (q2.details.reasons as string[]).includes('rules_missing'),
        `rules_missing: ${JSON.stringify(q2)}`
      );
      const stale = ctx.opportunities.find((o) => o.subreddit === 'webdev')!;
      const q3 = await errOf(
        ed.transitionOpportunity(stale.id, 'qualify', key(), {
          expectedRevision: stale.revision,
        })
      );
      expect(
        q3.code === 'PUB_TRANSITION_INVALID' &&
          q3.details.reason === 'policy_recheck',
        `stale: ${JSON.stringify(q3)}`
      );
      const prohibited = ctx.opportunities.find(
        (o) => o.subreddit === 'marketing'
      )!;
      const q4 = await errOf(
        ed.transitionOpportunity(prohibited.id, 'qualify', key(), {
          expectedRevision: prohibited.revision,
        })
      );
      expect(
        q4.details.reason === 'policy_block' &&
          (q4.details.reasons as string[]).includes('promotion_prohibited'),
        `prohibited: ${JSON.stringify(q4)}`
      );
      // Текст для экрана — словами, без кодов.
      const view = V.describeRedditError(
        new ApiError(q.code, 'x', 409, 'rq', q.details),
        (await import('../src/i18n/publisher-uk')).pubUk,
        V.getRedditDict('uk')
      );
      expect(
        !/policy_block|promotion_unknown/.test(view.lines.join(' ')),
        'экран показал бы коды'
      );
      return {
        blocked: q.details,
        rulesMissing: q2.details.reasons,
        stale: q3.details.reason,
        prohibited: q4.details.reasons,
        screen: view.lines,
      };
    }
  );

  await step(
    'переходы: qualify ok-возможности, skip, archive; архивная → PATCH 409',
    async () => {
      const [a, b, c] = ctx.opportunities.filter(
        (o) => o.subreddit === 'saas' || o.subreddit === 'smallbusiness'
      );
      expect(V.opportunityActions(a).qualify, 'клиент: qualify доступна');
      const qa = await ed.transitionOpportunity(a.id, 'qualify', key(), {
        expectedRevision: a.revision,
        reason: 'точно наша тема',
      });
      expect(qa.status === 'qualified', qa.status);
      const sb = await ed.transitionOpportunity(b.id, 'skip', key(), {
        expectedRevision: b.revision,
      });
      expect(sb.status === 'skipped', sb.status);
      const again = await errOf(
        ed.transitionOpportunity(b.id, 'qualify', key(), {
          expectedRevision: sb.revision,
        })
      );
      expect(
        again.details.reason === 'status' && again.details.from === 'skipped',
        `skipped → qualify: ${JSON.stringify(again)}`
      );
      const ar = await ed.transitionOpportunity(c.id, 'archive', key(), {
        expectedRevision: c.revision,
      });
      expect(
        ar.status === 'archived' && !V.opportunityActions(ar).edit,
        ar.status
      );
      const p = await errOf(
        ed.patchOpportunity(c.id, key(), {
          expectedRevision: ar.revision,
          titleManual: 'x',
        })
      );
      expect(
        p.code === 'PUB_TRANSITION_INVALID' && p.details.reason === 'status',
        `PATCH архивной: ${JSON.stringify(p)}`
      );
      ctx.opportunities = ctx.opportunities.map((o) =>
        o.id === qa.id ? qa : o.id === sb.id ? sb : o.id === ar.id ? ar : o
      );
      return { qualified: qa.id, skipped: sb.id, archived: ar.id };
    }
  );

  await step(
    'A04: новая версия правил → recheck_required (rules_changed), review + score → new',
    async () => {
      const eco = ctx.communities.ecommerce;
      const ops = ctx.opportunities.filter((o) => o.communityId === eco.id);
      const qa = await ed.transitionOpportunity(ops[0].id, 'qualify', key(), {
        expectedRevision: ops[0].revision,
      });
      expect(qa.status === 'qualified', 'qualify перед новой версией');
      const s2 = await ed.createRules(eco.id, key(), {
        sourceUrl: 'https://www.reddit.com/r/ecommerce/wiki/rules',
        sourceExcerpt: 'Нова редакція: посилання лише з дозволу модераторів.',
        promotionPolicy: 'allowed_with_conditions',
        linksPolicy: 'restricted',
        flairRequired: true,
        checkedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(s2.version === 2, `версия ${s2.version}`);
      const list = await vw.rules(eco.id);
      expect(
        list.items.length === 2 &&
          list.items[0].version === 2 &&
          list.items[1].status === 'superseded',
        'версии новые сверху, прежняя superseded'
      );
      const old = await errOf(po.reviewRules(list.items[1].id, key()));
      expect(
        old.details.reason === 'superseded' ||
          old.details.reason === 'already_reviewed',
        `старый снимок: ${JSON.stringify(old)}`
      );
      for (const o of ops) {
        const v = await vw.opportunity(o.id);
        expect(
          v.status === 'recheck_required' &&
            v.policyReasons.includes('rules_changed') &&
            v.policyNow === 'block' &&
            v.policyNowReasons.includes('rules_unreviewed'),
          `${o.id}: ${v.status} ${v.policyReasons} now=${v.policyNow} ${v.policyNowReasons}`
        );
      }
      const unrev = await vw.opportunity(ops[1].id);
      const sc0 = await ed.scoreOpportunity(unrev.id, key(), unrev.revision);
      expect(
        sc0.policy === 'block' &&
          sc0.policyReasons.includes('rules_unreviewed'),
        `до review: ${sc0.policy} ${sc0.policyReasons}`
      );
      await po.reviewRules(s2.id, key());
      const sc = await ed.scoreOpportunity(unrev.id, key(), sc0.revision);
      expect(
        sc.status === 'new' &&
          sc.policy === 'ok' &&
          sc.factors.policy_risk.value === 50 &&
          sc.ruleSnapshotVersion === 2,
        `после review+score: ${sc.status}/${sc.policy}/${sc.factors.policy_risk.value}`
      );
      return {
        v2: s2.id,
        after: {
          status: sc.status,
          risk: sc.factors.policy_risk.value,
          priority: sc.score.priority,
        },
      };
    }
  );

  await step(
    'списки: фильтры, курсор nextBefore, поиск q, CSV-колонки',
    async () => {
      const seenIds = new Set<string>();
      let before: string | undefined;
      let pages = 0;
      do {
        const pg = await vw.opportunities({
          projectId: ctx.projectId,
          limit: 6,
          before,
        });
        pg.items.forEach((x) => seenIds.add(x.id));
        before = pg.nextBefore ?? undefined;
        pages++;
      } while (before && pages < 10);
      expect(
        seenIds.size === 20 && pages === 4,
        `курсор: ${seenIds.size} за ${pages}`
      );
      const blocked = await vw.opportunities({
        projectId: ctx.projectId,
        status: 'blocked',
        limit: 100,
      });
      expect(
        blocked.items.length > 0 &&
          blocked.items.every((o) => o.status === 'blocked'),
        'фильтр status'
      );
      const byComm = await vw.opportunities({
        communityId: ctx.communities.webdev.id,
      });
      expect(
        byComm.items.length === 2 &&
          byComm.items.every((o) => o.subreddit === 'webdev'),
        'фильтр communityId'
      );
      const q = await vw.communities({ q: 'r/Micro' });
      expect(
        q.items.length === 1 && q.items[0].subreddit === 'microsaas',
        `q: ${q.items.map((x) => x.subreddit)}`
      );
      const badStatus = await errOf(vw.opportunities({ status: 'teleported' }));
      expect(
        badStatus.code === 'PUB_VALIDATION',
        `status enum: ${badStatus.code}`
      );
      const csv = await as.analyst.http.csv(
        R.redditListPath(pid, 'opportunities'),
        { projectId: ctx.projectId }
      );
      const header = csv.text.split(/\r?\n/)[0];
      expect(
        header ===
          'id,projectId,subreddit,threadUrl,titleManual,intent,relevance,risk,priority,missing,policy,policyReasons,policyNow,policyNowReasons,status,createdAt',
        `CSV: ${header}`
      );
      expect(
        csv.text.trim().split(/\r?\n/).length === 21,
        `строк CSV ${csv.text.trim().split(/\r?\n/).length}`
      );
      const kw = await vw.keywords({ projectId: ctx.projectId, q: 'crm' });
      return {
        pages,
        blocked: blocked.items.length,
        csvFile: csv.filename,
        keywordsQ: kw.items.length,
      };
    }
  );

  await step(
    'ключевой запрос и сообщество: правка, архив; архивный проект → 409',
    async () => {
      const k = ctx.keywords[5];
      const kp = V.keywordPatchBody(k, {
        phrase: k.phrase,
        intent: k.intent,
        locale: 'en',
        priority: '1',
      });
      expect(kp, 'тело правки запроса');
      const k2 = await ed.patchKeyword(k.id, key(), kp);
      const k3 = await ed.patchKeyword(k.id, key(), {
        expectedRevision: k2.revision,
        status: 'archived',
      });
      expect(k2.priority === 1 && k3.status === 'archived', 'запрос');
      const side = ctx.communities.sideproject;
      const sp = V.communityPatchBody(side, {
        ...V.communityForm(side),
        descriptionManual: 'Спільнота побічних проєктів',
      });
      expect(sp, 'тело правки сообщества');
      const s2 = await ed.patchCommunity(side.id, key(), sp);
      const s3 = await ed.patchCommunity(side.id, key(), {
        expectedRevision: s2.revision,
        status: 'archived',
      });
      expect(s3.status === 'archived', 'архив сообщества');
      const noOpp = await errOf(
        ed.createOpportunity(key(), {
          projectId: ctx.projectId,
          communityId: side.id,
          threadUrl: 'https://www.reddit.com/r/sideproject/comments/zz9/x',
          titleManual: 't',
          intent: 'other',
        })
      );
      expect(
        noOpp.details.reason === 'community_archived',
        `архивное сообщество: ${JSON.stringify(noOpp)}`
      );
      // Раунд исправлений: архивный родитель — 409 на PATCH/score/qualify
      // возможности, skip — можно.
      const [so1, so2] = ctx.opportunities.filter(
        (o) => o.communityId === side.id
      );
      const sp1 = await vw.opportunity(so1.id);
      const pa = await errOf(
        ed.patchOpportunity(so1.id, key(), {
          expectedRevision: sp1.revision,
          titleManual: 'нова назва',
        })
      );
      const sc = await errOf(ed.scoreOpportunity(so1.id, key(), sp1.revision));
      const qa = await errOf(
        ed.transitionOpportunity(so1.id, 'qualify', key(), {
          expectedRevision: sp1.revision,
        })
      );
      for (const [n, x] of [
        ['patch', pa],
        ['score', sc],
        ['qualify', qa],
      ] as const)
        expect(
          x.code === 'PUB_TRANSITION_INVALID' &&
            x.details.reason === 'community_archived',
          `${n} при архивном сообществе: ${JSON.stringify(x)}`
        );
      const sp2 = await vw.opportunity(so2.id);
      const sk = await ed.transitionOpportunity(so2.id, 'skip', key(), {
        expectedRevision: sp2.revision,
      });
      expect(sk.status === 'skipped', 'skip при архивном сообществе');
      const kwArch = await errOf(
        ed.patchKeyword(ctx.keywords[1].id, key(), {
          expectedRevision: ctx.keywords[1].revision,
          priority: 1,
        })
      );
      expect(kwArch.code === 'OK', `запрос активного проекта: ${kwArch.code}`);
      // Переименование запроса в существующую фразу → 409 {existingId}.
      const kw2 = await vw.keywords({ projectId: ctx.projectId, limit: 100 });
      const k1 = kw2.items.find((x) => x.id === ctx.keywords[1].id)!;
      const ren = await errOf(
        ed.patchKeyword(k1.id, key(), {
          expectedRevision: k1.revision,
          phrase: '  CRM   VS spreadsheet  ',
        })
      );
      expect(ren.code === 'OK', `переименование в свою же фразу: ${ren.code}`);
      const k1b = (
        await vw.keywords({ projectId: ctx.projectId, limit: 100 })
      ).items.find((x) => x.id === k1.id)!;
      const ren2 = await errOf(
        ed.patchKeyword(k1.id, key(), {
          expectedRevision: k1b.revision,
          phrase: 'Alternative to HubSpot',
        })
      );
      expect(
        ren2.code === 'PUB_CONFLICT' &&
          ren2.details.reason === 'duplicate' &&
          ren2.details.existingId === ctx.keywords[2].id,
        `переименование в чужую фразу: ${JSON.stringify(ren2)}`
      );
      const p2 = await ed.createProject(key(), {
        title: 'Архівний',
        locale: 'en',
        market: 'US',
      });
      const p3 = await ed.archiveProject(p2.id, key(), p2.revision);
      expect(p3.status === 'archived', 'архив проекта');
      const inArch = await errOf(
        ed.createCommunity(key(), { projectId: p2.id, community: 'r/startups' })
      );
      expect(
        inArch.details.reason === 'project_archived',
        `архивный проект: ${JSON.stringify(inArch)}`
      );
      return { keyword: k3.status, community: s3.status, project: p3.status };
    }
  );

  await step(
    'Р-RD-0: импорт по URL Reddit → PUB_IMPORT_BLOCKED reddit_manual_only',
    async () => {
      const r = await errOf(
        as.editor.content(pid).importUrl({
          url: 'https://www.reddit.com/r/saas/comments/abc/x',
          visibility: 'private',
        })
      );
      expect(
        r.code === 'PUB_IMPORT_BLOCKED' &&
          r.details.reason === 'reddit_manual_only',
        `импорт: ${JSON.stringify(r)}`
      );
      return r;
    }
  );

  await step(
    'декодеры кабинета приняли все ответы (ни одного PUB_RESPONSE_INVALID)',
    async () => {
      // Полный проход всех GET раздела строгими декодерами.
      const pr = await vw.projects({ limit: 100 });
      for (const p of pr.items) await vw.project(p.id);
      for (const c of Object.values(ctx.communities)) {
        await vw.community(c.id);
        await vw.rules(c.id);
      }
      for (const o of ctx.opportunities) await vw.opportunity(o.id);
      return { projects: pr.items.length };
    }
  );

  await step(
    'раунд 2: выдержка — новая редакция, отвязка, отзыв (урезанный ответ), правка отозванной → 409',
    async () => {
      const o0 = ctx.opportunities.find((o) => o.excerpt !== null)!;
      let o = await vw.opportunity(o0.id);
      expect(V.excerptEditable(o), 'клиент: правка доступна');
      const old = o.excerpt!.sourceId;
      const b1 = V.excerptPatchBody(o, 'Нова редакція: шукаємо CRM до $50/міс');
      expect(b1 && b1.excerpt, 'тело новой редакции');
      o = await ed.patchOpportunity(o.id, key(), b1);
      expect(
        o.excerpt &&
          o.excerpt.sourceId !== old &&
          o.excerpt.text.startsWith('Нова редакція'),
        `новая редакция: ${JSON.stringify(o.excerpt)}`
      );
      const b2 = V.excerptPatchBody(o, '   ');
      expect(b2 && b2.excerpt === null, 'тело отвязки');
      o = await ed.patchOpportunity(o.id, key(), b2);
      expect(o.excerpt === null, 'отвязано');
      const nick = await errOf(
        ed.patchOpportunity(o.id, key(), {
          expectedRevision: o.revision,
          excerpt: 'питали u/somebody',
        })
      );
      expect(
        nick.code === 'PUB_VALIDATION' &&
          JSON.stringify(nick.details).includes('profile_ref'),
        `ник в выдержке: ${JSON.stringify(nick)}`
      );
      o = await ed.patchOpportunity(o.id, key(), {
        expectedRevision: o.revision,
        excerpt: 'Третя редакція витягу',
      });
      const sid = o.excerpt!.sourceId;
      // Reddit-доказательства скрыты из общего раздела «Источники».
      const content = as.editor.content(pid);
      const listed = await content.sources({ limit: 100 });
      expect(
        !listed.items.some((x) => x.id === sid || x.id === old),
        'Reddit-источник в общем списке'
      );
      const one = await errOf(content.source(sid));
      expect(one.code === 'PUB_NOT_FOUND', `GET /sources/:id: ${one.code}`);
      const locked = await errOf(
        content.patchSource(sid, { usage: 'allowed', expectedRevision: 1 })
      );
      expect(
        locked.code === 'PUB_CONFLICT' &&
          locked.details.reason === 'reddit_evidence_locked',
        `PATCH /sources/:id: ${JSON.stringify(locked)}`
      );
      const rv = await content.revokeSource(
        sid,
        'вилучено на прохання автора треду'
      );
      expect(
        rv.source.url === null &&
          rv.source.title === null &&
          rv.source.fragment === '' &&
          rv.source.usage === 'revoked',
        `урезанный ответ отзыва: ${JSON.stringify(rv.source)}`
      );
      o = await vw.opportunity(o.id);
      expect(
        o.excerpt?.usage === 'revoked' && !V.excerptEditable(o),
        'выдержка отозвана, правка скрыта'
      );
      const e1 = await errOf(
        ed.patchOpportunity(o.id, key(), {
          expectedRevision: o.revision,
          excerpt: 'ще раз',
        })
      );
      const e2 = await errOf(
        ed.patchOpportunity(o.id, key(), {
          expectedRevision: o.revision,
          excerpt: null,
        })
      );
      for (const x of [e1, e2])
        expect(
          x.code === 'PUB_SOURCE_NOT_ALLOWED' && x.details.reason === 'revoked',
          `правка отозванной: ${JSON.stringify(x)}`
        );
      const t2 = await ed.patchOpportunity(o.id, key(), {
        expectedRevision: o.revision,
        titleManual: 'Інші поля правляться',
      });
      expect(t2.titleManual === 'Інші поля правляться', 'прочие поля');
      const ttl = await errOf(
        ed.patchOpportunity(o.id, key(), {
          expectedRevision: t2.revision,
          titleManual: 'дивись /user/somebody',
        })
      );
      expect(
        ttl.code === 'PUB_VALIDATION' &&
          JSON.stringify(ttl.details).includes('profile_ref'),
        `ник в заголовке: ${JSON.stringify(ttl)}`
      );
      ctx.opportunities = ctx.opportunities.map((x) =>
        x.id === t2.id ? t2 : x
      );
      return {
        old,
        revoked: sid,
        revokeResponse: { url: rv.source.url, fragment: rv.source.fragment },
        e1: e1.details,
      };
    }
  );

  await step(
    'раунд 2: отзыв первоисточника правил → rules_source_revoked, возможности → recheck_required/block',
    async () => {
      const shop = ctx.communities.shopify;
      const cur = (await vw.rules(shop.id)).items[0];
      await as.editor
        .content(pid)
        .revokeSource(cur.source.id, 'правила вилучено');
      const c = await vw.community(shop.id);
      expect(
        c.rules?.gate.verdict === 'block' &&
          c.rules.gate.reasons.includes('rules_source_revoked'),
        `гейт сообщества: ${JSON.stringify(c.rules?.gate)}`
      );
      const snap = (await vw.rules(shop.id)).items[0];
      expect(
        snap.source.usage === 'revoked' &&
          snap.gate.reasons.includes('rules_source_revoked'),
        'гейт снимка'
      );
      const ops = (await vw.opportunities({ communityId: shop.id })).items;
      for (const o of ops)
        expect(
          o.status === 'recheck_required' &&
            o.policy === 'block' &&
            o.policyNow === 'block' &&
            o.policyNowReasons.includes('rules_source_revoked'),
          `${o.id}: ${o.status}/${o.policy}/${o.policyNow} ${o.policyNowReasons}`
        );
      const q = await errOf(
        ed.transitionOpportunity(ops[0].id, 'qualify', key(), {
          expectedRevision: ops[0].revision,
        })
      );
      expect(
        q.details.reason === 'policy_block' &&
          (q.details.reasons as string[]).includes('rules_source_revoked'),
        `qualify: ${JSON.stringify(q)}`
      );
      const view = V.describeRedditError(
        new ApiError(q.code, 'x', 409, 'rq', q.details),
        (await import('../src/i18n/publisher-ru')).pubRu,
        V.getRedditDict('ru')
      );
      expect(
        !/rules_source_revoked/.test(view.lines.join(' ')),
        'экран показал бы код'
      );
      return { gate: c.rules?.gate, ops: ops.length, screen: view.lines };
    }
  );

  await step(
    'раунд 2: часы стенда +31 дн. → отобранная с policyNow≠ok (rules_stale), фильтр ?policyNow, CSV',
    async () => {
      const qualified = (
        await vw.opportunities({
          projectId: ctx.projectId,
          status: 'qualified',
          limit: 100,
        })
      ).items;
      expect(
        qualified.length > 0 && qualified.every((o) => o.policyNow === 'ok'),
        'до сдвига — ok'
      );
      const now = await advanceStandClock(31 * DAY);
      const after = (
        await vw.opportunities({
          projectId: ctx.projectId,
          status: 'qualified',
          limit: 100,
        })
      ).items;
      for (const o of after) {
        expect(
          o.status === 'qualified' &&
            o.policyNow === 'recheck_required' &&
            o.policyNowReasons.includes('rules_stale'),
          `${o.id}: ${o.policyNow} ${o.policyNowReasons}`
        );
        expect(
          V.opportunityActions(o).stale &&
            V.opportunityActions(o).skip &&
            V.opportunityActions(o).archive &&
            !V.opportunityActions(o).qualify,
          'клиент: подсветка; skip/archive доступны (S3-4)'
        );
      }
      const need = await vw.opportunities({
        projectId: ctx.projectId,
        status: 'qualified',
        policyNow: 'recheck_required',
      });
      expect(
        need.items.length === after.length,
        `фильтр «нужно пересчитать»: ${need.items.length} ≠ ${after.length}`
      );
      const okNow = await vw.opportunities({
        projectId: ctx.projectId,
        policyNow: 'ok',
        limit: 100,
      });
      expect(
        okNow.items.every((o) => o.policyNow === 'ok'),
        'фильтр policyNow=ok'
      );
      const bad = await as.viewer.http
        .get(`products/${pid}/reddit/opportunities`, { policyNow: 'maybe' })
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(
        bad instanceof ApiError &&
          bad.code === 'PUB_VALIDATION' &&
          JSON.stringify(bad.details).includes('policyNow'),
        `policyNow enum: ${errText(bad)}`
      );
      const csv = await as.analyst.http.csv(
        R.redditListPath(pid, 'opportunities'),
        {
          projectId: ctx.projectId,
          status: 'qualified',
          policyNow: 'recheck_required',
        }
      );
      const rows = csv.text.trim().split(/\r?\n/);
      expect(
        rows.length === after.length + 1 &&
          rows.slice(1).every((l) => l.includes('recheck_required')),
        `CSV с policyNow: ${rows.length}`
      );
      // Пересчёт по текущим правилам возвращает в работу: qualified → recheck_required.
      const o = after[0];
      const rs = await ed.scoreOpportunity(o.id, key(), o.revision);
      expect(
        rs.policy === 'recheck_required' && rs.policyNow === 'recheck_required',
        `пересчёт: ${rs.status}/${rs.policy}`
      );
      return {
        standNow: now,
        staleQualified: after.length,
        rescored: { status: rs.status, policy: rs.policy },
      };
    }
  );

  await step(
    'раунд 3 (S2-1): PO меняет topic_fit, ED — другой фактор → 409 → перечитать → сохранение не затирает',
    async () => {
      const id = ctx.opportunities.find((o) => o.subreddit === 'wordpress')!.id;
      const o0 = await as.editor.rd(pid).opportunity(id);
      const base = V.factorForm(o0.factors);
      // PO параллельно.
      const poSaved = await po.patchOpportunity(id, key(), {
        expectedRevision: o0.revision,
        factors: { topic_fit: { value: 93, why: 'PO: найточніше' } },
      });
      // ED правит только answerability в своей форме (снимок base).
      const mine = {
        ...base,
        answerability: { value: '41', why: 'ED: частково' },
      };
      const b1 = V.factorsBody(mine, base);
      expect(
        JSON.stringify(Object.keys(b1.body)) === '["answerability"]',
        'тело — только своё'
      );
      const c409 = await errOf(
        ed.patchOpportunity(id, key(), {
          expectedRevision: o0.revision,
          factors: b1.body,
        })
      );
      expect(c409.code === 'PUB_CONFLICT', `CAS: ${c409.code}`);
      const fresh = await vw.opportunity(id);
      const freshForm = V.factorForm(fresh.factors);
      const rb = V.rebaseForm(base, mine, freshForm);
      expect(
        rb.conflicts.length === 0 && rb.mine.topic_fit.value === '93',
        'перебазирование'
      );
      const b2 = V.factorsBody(rb.mine, freshForm);
      const saved = await ed.patchOpportunity(id, key(), {
        expectedRevision: fresh.revision,
        factors: b2.body,
      });
      expect(
        saved.factors.topic_fit.value === 93 &&
          saved.factors.topic_fit.why === 'PO: найточніше' &&
          saved.factors.answerability.value === 41,
        `правка PO затёрта: ${JSON.stringify(saved.factors.topic_fit)}`
      );
      // Тот же фактор у обоих — конфликт виден до отправки.
      const mine2 = { ...freshForm, topic_fit: { value: '5', why: 'ED' } };
      const po2 = await po.patchOpportunity(id, key(), {
        expectedRevision: saved.revision,
        factors: { topic_fit: { value: 94, why: 'PO знову' } },
      });
      const rb2 = V.rebaseForm(freshForm, mine2, V.factorForm(po2.factors));
      expect(
        rb2.conflicts.length === 1 && rb2.conflicts[0].key === 'topic_fit',
        'конфликт topic_fit'
      );
      return {
        po: poSaved.revision,
        saved: {
          topic: saved.factors.topic_fit,
          answer: saved.factors.answerability,
        },
        conflict: rb2.conflicts[0],
      };
    }
  );

  await step(
    'раунд 3 (S2-2): редакции выдержки и первоисточники — список и отзыв при любом статусе (архив, superseded)',
    async () => {
      const sb = ctx.communities.smallbusiness;
      const o1 = await ed.createOpportunity(key(), {
        projectId: ctx.projectId,
        communityId: sb.id,
        threadUrl: 'https://www.reddit.com/r/smallbusiness/comments/e2e99k/x',
        titleManual: 'Тред для архіву',
        intent: 'discussion',
        excerpt: 'Перша редакція витягу',
      });
      const o2 = await ed.patchOpportunity(o1.id, key(), {
        expectedRevision: o1.revision,
        excerpt: 'Друга редакція витягу',
      });
      const o3 = await ed.transitionOpportunity(o2.id, 'archive', key(), {
        expectedRevision: o2.revision,
      });
      expect(
        o3.status === 'archived' && !V.excerptEditable(o3),
        'архив: правки нет'
      );
      const ex = await vw.excerpts(o3.id);
      expect(
        ex.items.length === 2 &&
          ex.items[1].current &&
          ex.items[1].supersedesId === ex.items[0].sourceId,
        `редакции: ${JSON.stringify(ex.items.map((x) => [x.revision, x.current]))}`
      );
      expect(
        ex.items.every((x) => x.usage !== 'revoked'),
        'до отзыва'
      );
      // Отзыв прежней редакции у АРХИВНОЙ возможности.
      await as.editor
        .content(pid)
        .revokeSource(ex.items[0].sourceId, 'ПД у старій редакції');
      const ex2 = await vw.excerpts(o3.id);
      const old = ex2.items.find((x) => x.sourceId === ex.items[0].sourceId)!;
      expect(
        old.usage === 'revoked' &&
          old.revokeReason === 'ПД у старій редакції' &&
          old.revokedAt,
        `прежняя: ${JSON.stringify(old)}`
      );
      // Первоисточник ЗАМЕНЁННОГО снимка (ecommerce v1).
      const rules = await vw.rules(ctx.communities.ecommerce.id);
      const sup = rules.items.find((x) => x.status === 'superseded')!;
      const rs = await vw.rulesSource(ctx.communities.ecommerce.id, sup.id);
      expect(
        rs.status === 'superseded' &&
          rs.source.sourceId === sup.source.id &&
          rs.source.usage !== 'revoked',
        'источник superseded'
      );
      await as.editor
        .content(pid)
        .revokeSource(rs.source.sourceId, 'стара редакція правил');
      const rs2 = await vw.rulesSource(ctx.communities.ecommerce.id, sup.id);
      expect(
        rs2.source.usage === 'revoked' &&
          rs2.source.revokeReason === 'стара редакція правил',
        'отозван'
      );
      const foreign = await errOf(
        vw.rulesSource(ctx.communities.saas.id, sup.id)
      );
      expect(
        foreign.code === 'PUB_NOT_FOUND',
        `снимок чужого сообщества: ${foreign.code}`
      );
      const vwRevoke = await errOf(
        as.viewer.content(pid).revokeSource(ex2.items[1].sourceId, 'x')
      );
      expect(
        vwRevoke.code === 'PUB_ROLE_REQUIRED',
        `VW revoke: ${vwRevoke.code}`
      );
      return {
        excerpts: ex2.items.map((x) => ({
          rev: x.revision,
          usage: x.usage,
          current: x.current,
        })),
        rulesSource: { status: rs2.status, usage: rs2.source.usage },
      };
    }
  );

  await step(
    'раунд 3 (S3-2): r/u_* — profile_ref, клиент совпадает с сервером',
    async () => {
      const c = await errOf(
        ed.createCommunity(key(), {
          projectId: ctx.projectId,
          community: 'r/u_spez',
        })
      );
      expect(
        c.code === 'PUB_VALIDATION' &&
          JSON.stringify(c.details).includes('profile_ref'),
        `сообщество: ${JSON.stringify(c)}`
      );
      expect(
        V.subredditIssue('r/u_spez') === 'profile_ref',
        'клиент: сообщество'
      );
      const t = await errOf(
        ed.createOpportunity(key(), {
          projectId: ctx.projectId,
          communityId: ctx.communities.saas.id,
          threadUrl: 'https://old.reddit.com/r/u_spez/comments/abc12/x',
          titleManual: 't',
          intent: 'other',
        })
      );
      expect(
        t.code === 'PUB_VALIDATION' &&
          JSON.stringify(t.details).includes('profile_ref'),
        `тред: ${JSON.stringify(t)}`
      );
      expect(
        V.threadUrlIssue('https://old.reddit.com/r/u_spez/comments/abc12/x') ===
          'profile_ref',
        'клиент: тред'
      );
      const view = V.describeRedditError(
        new ApiError(t.code, 'x', 400, 'rq', t.details),
        (await import('../src/i18n/publisher-uk')).pubUk,
        V.getRedditDict('uk')
      );
      expect(
        !/threadUrl/.test(view.lines.join(' ')),
        `сырое имя поля: ${view.lines}`
      );
      return { community: c.details, thread: t.details, screen: view.lines };
    }
  );

  const out = process.env.PUB_E2E_OUT;
  if (out)
    writeFileSync(
      out,
      JSON.stringify(
        { ctx: { pid: ctx.pid, projectId: ctx.projectId }, results },
        null,
        2
      )
    );
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log(
    `publisher-e2e-reddit: шагов ${results.length}, passed ${results.length - failed}, failed ${failed}`
  );
  if (failed) process.exitCode = 1;
}

void main();
