/**
 * [P-R-ADM v1.4] Админка: AI платформенного продукта — полностью из Админки
 * (Р-RD-ADM-14, -15; аудит S2-1). Ни одного засева параметров или месяца AI
 * в базу: кабинет и сайт — фикстура, дальше только внутренний API.
 *
 *  1. `setup` → платформенный продукт; `status.aiGate` честно показывает
 *     флаг выключен → генератор выключен до eval 2.3 → гейт `ai_use` закрыт;
 *     `status.aiMonth` — ключи AI не утверждены;
 *  2. оффер, источник, ключи `reddit_publish` — решения оператора;
 *  3. ключи `ai_use` (+ `ai_unpriced_allowed`) — решения оператора → гейт
 *     открыт, месяц — `spend_gate_closed` (пункты гейта `spend`);
 *     генерация → 409 `PUB_AI_BUDGET {reason:'month_not_open'}`;
 *  4. бюджет «только AI» по подсказке `hints.budget` (размещения, резерв,
 *     закупка — 0) → гейт `spend` открыт, месяц ждёт задания; проход
 *     `ai-month-open` открывает месяц (обязательство `tools`);
 *  5. генерация 200 (fake-модель, актор admin); снижение потолка решением
 *     оператора → `aiMonth.reason='cap_exhausted'`, генерация → 409
 *     `PUB_AI_BUDGET {reason:'cap_exhausted'}`, код прежний.
 * Ноль запросов к Reddit (`watchEgress`).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { AiMonthOpenJob } from '../../modules/publisher/ai/ai-month.job';
import { GATE_PARAMETER_KEYS } from '../../modules/publisher/contracts/parameters';
import { PUBLISHER_REDDIT_AI_ENABLED_ENV } from '../../config/publisher-env';
import { seedAccount } from '../../modules/publisher/testing/fixtures.testing';
import {
  ADMIN_USER,
  adminApi,
  useAdminEnv,
  type AdminApi,
} from '../../modules/publisher/reddit/testing/admin-kit.testing';
import {
  factorsBody,
  ok,
  redditAi,
  redditDraftJson,
  redditStack,
  rulesBody,
  subredditName,
  threadUrl,
  type RedditAi,
  type RedditStack,
  type RedditWorld,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';
import { watchEgress, type EgressWatch } from './reddit-egress.testing';

jest.setTimeout(300_000);

const ACTOR = `admin:${ADMIN_USER}`;

interface Missing {
  kind: string;
  key: string;
  detail: string;
}
interface Status {
  product: { id: string; kind: string } | null;
  aiGate: {
    open: boolean;
    missing: Missing[];
    generatorEnabled: boolean;
    reason: string | null;
  } | null;
  aiMonth: {
    month: string;
    open: boolean;
    reason: string | null;
    missing: Missing[];
  } | null;
}
interface Params {
  items: Array<{ key: string; value: unknown; status: string }>;
  keys: string[];
  hints: {
    offerActiveVersion: { offerVersionId: string; version: number } | null;
    accountOwnerMemberId: string | null;
    budget: {
      mode: string;
      currency: string;
      months: number;
      aiMonthMinor: number | null;
      values: Record<string, unknown> | null;
    };
  };
}

const shape = (r: { status: number; body: unknown }) => {
  const b = r.body as { error?: { code?: string; details?: unknown } };
  return {
    status: r.status,
    code: b?.error?.code ?? null,
    details: b?.error?.details ?? null,
  };
};

ciDescribe(
  '[P-R-ADM v1.4] Админка: ключи ai_use и бюджета — решения оператора; месяц AI; причины PUB_AI_BUDGET',
  () => {
    let s: RedditStack;
    let A: AdminApi;
    let ai: RedditAi | null = null;
    let net: EgressWatch;
    let restoreEnv: () => void;
    let siteId: string;
    let productId: string;
    let savedAiFlag: string | undefined;

    beforeAll(async () => {
      s = await redditStack();
      const acc = await seedAccount(s.prisma);
      siteId = acc.siteId;
      restoreEnv = useAdminEnv(siteId);
      savedAiFlag = process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
      A = adminApi(s);
      net = watchEgress();
    });
    afterAll(async () => {
      net?.restore();
      ai?.restore();
      if (savedAiFlag === undefined)
        delete process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
      else process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = savedAiFlag;
      restoreEnv?.();
      await s?.close();
    });

    const status = async () => ok<Status>(await A.get('status'), 200);
    const params = async () => ok<Params>(await A.get('params'), 200);

    /** Предложить и утвердить значение ключа (актор admin). */
    async function decide(key: string, value: unknown): Promise<void> {
      const pr = ok<{ proposalId: string; parameter: { revision: number } }>(
        await A.post(`params/${key}/propose`, { value }),
        201,
      );
      ok(
        await A.post(`params/${key}/decide`, {
          toStatus: 'approved',
          proposalId: pr.proposalId,
          expectedRevision: pr.parameter.revision,
          basis: 'Рішення оператора платформи в Адмінці',
        }),
        200,
      );
    }

    async function monthJob() {
      return s.mod.get(AiMonthOpenJob).run({
        now: new Date(),
        scope: { siteIds: [siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
    }

    it('полный путь AI из Админки без засева параметров', async () => {
      // ── 1. setup и честный status ─────────────────────────────────────
      const created = ok<{ created: boolean; product: { id: string } }>(
        await A.postRaw('setup', {}),
        201,
      );
      productId = created.product.id;
      process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = 'false';
      let st = await status();
      expect(st.product).toMatchObject({ id: productId, kind: 'working' });
      expect(st.aiGate).toMatchObject({
        open: false,
        generatorEnabled: false,
        reason: 'flag_off',
      });
      process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = 'true';
      st = await status();
      // генератор выключен в коде до eval 2.3 (стенд без fake-AI)
      expect(st.aiGate).toMatchObject({
        generatorEnabled: false,
        reason: 'generator_disabled',
      });
      // fake-модель стенда, допуск без eval; параметры и месяц — НЕ засеваются
      ai = await redditAi(s, {} as RedditWorld, { params: false });
      st = await status();
      expect(st.aiGate!.generatorEnabled).toBe(true);
      expect(st.aiGate!.reason).toBe('gate_closed');
      expect(
        st.aiGate!.missing.map((m) => `${m.kind}:${m.key}`).sort(),
      ).toEqual(['parameter:ai_budget_usd_month', 'parameter:ai_fx_rate']);
      expect(st.aiMonth).toMatchObject({
        open: false,
        reason: 'ai_params_missing',
      });
      expect(st.aiMonth!.month).toMatch(/^\d{4}-\d{2}$/);

      // ── 2. оффер, источник, reddit_publish — решения оператора ────────
      const offer = ok<{ id: string }>(
        await A.post('cx/offers', {
          title: 'Платформа: супровід Reddit',
          text: 'Ручний режим: дослідження, чернетки, перевірка правил.',
        }),
        201,
      );
      ok(
        await A.post(`cx/offers/${offer.id}/activate`, {
          basis: 'Оффер платформи затверджено оператором',
        }),
        200,
      );
      const src = ok<{ id: string }>(
        await A.post('cx/sources', {
          kind: 'manual_text',
          title: 'Методика платформи',
          fragment:
            'З одного перевіреного матеріалу можна підготувати пост, картки і сценарій.',
          visibility: 'private',
          usage: 'allowed',
        }),
        201,
      ).id;
      let p = await params();
      expect(p.keys).toHaveLength(13);
      expect(p.hints.budget).toMatchObject({
        mode: 'ai_only',
        currency: 'UAH',
        aiMonthMinor: null,
        values: null,
      });
      for (const key of GATE_PARAMETER_KEYS.reddit_publish) {
        const cur = p.items.find((x) => x.key === key)!;
        if (cur.status === 'approved') continue; // offer_active_version — активация
        const owner = p.hints.accountOwnerMemberId;
        await decide(
          key,
          key === 'responsibles'
            ? {
                formOwnerMemberId: owner,
                salesMemberIds: [owner],
                afterT72MemberId: null,
              }
            : key === 'niche'
              ? { text: 'Платформа: власники сайтів і малий бізнес' }
              : cur.value,
        );
      }

      // ── 3. ключи ai_use — решения оператора ──────────────────────────
      await decide('ai_budget_usd_month', { microUsd: 20_000_000 });
      await decide('ai_fx_rate', {
        rate: '41.5',
        source: 'НБУ',
        at: '2026-10-12T10:00:00+03:00',
      });
      await decide('ai_unpriced_allowed', { allowed: false });
      st = await status();
      expect(st.aiGate).toEqual({
        open: true,
        missing: [],
        generatorEnabled: true,
        reason: null,
      });
      expect(st.aiMonth!.reason).toBe('spend_gate_closed');
      expect(st.aiMonth!.missing.map((m) => m.key)).toEqual(
        expect.arrayContaining(['budget_total', 'budget_split']),
      );

      // бриф → генерация: месяц не открыт
      const name = subredditName('aim');
      const proj = ok<{ id: string }>(
        await A.post('rx/projects', {
          title: 'Платформа: Reddit',
          locale: 'en',
          market: 'US',
        }),
        201,
      );
      const comm = ok<{ id: string }>(
        await A.post('rx/communities', {
          projectId: proj.id,
          community: `r/${name}`,
        }),
        201,
      );
      const snap = ok<{ id: string }>(
        await A.post(
          `rx/communities/${comm.id}/rules`,
          rulesBody(name, 'restricted'),
        ),
        201,
      );
      ok(await A.post(`rx/rules/${snap.id}/review`), 200);
      const opp = ok<{ id: string; revision: number }>(
        await A.post('rx/opportunities', {
          projectId: proj.id,
          communityId: comm.id,
          threadUrl: threadUrl(name),
          titleManual: 'Which AI chat widget answers only from site content?',
          excerpt: 'Looking for a widget that answers from our docs only.',
          intent: 'recommendation',
          factors: factorsBody(),
        }),
        201,
      );
      ok(
        await A.post(`rx/opportunities/${opp.id}/qualify`, {
          expectedRevision: opp.revision,
        }),
        200,
      );
      const b = ok<{ id: string; revision: number }>(
        await A.post('rx/briefs', {
          projectId: proj.id,
          contentType: 'comment',
          opportunityId: opp.id,
          objective: 'Help the author reuse one article',
          keyPoints: [
            {
              text: 'One verified article can become a post, cards and a video script',
              sourceIds: [src],
            },
            {
              text: 'Ask which formats the author tried',
              sourceIds: 'needs_verification',
            },
          ],
          affiliation: 'founder',
          brand: 'Demo',
          language: 'en',
        }),
        201,
      );
      ok(
        await A.post(`rx/briefs/${b.id}/ready`, {
          expectedRevision: b.revision,
        }),
        200,
      );
      const gen = () =>
        A.post(`rx/briefs/${b.id}/generate`, { template: 'helpful_answer' });
      const notOpen = shape(await gen());
      expect(notOpen).toMatchObject({
        status: 409,
        code: 'PUB_AI_BUDGET',
        details: { reason: 'month_not_open', generator: 'pub.reddit.draft' },
      });

      // ── 4. бюджет «только AI» по подсказке → spend → месяц ────────────
      p = await params();
      expect(p.hints.budget.aiMonthMinor).toBe(83_000);
      const hint = p.hints.budget.values!;
      expect(hint).toEqual({
        budget_total: { amountMinor: 83_000 * 12, currency: 'UAH' },
        budget_split: {
          placementsMinor: 0,
          toolsMinor: 83_000 * 12,
          reserveMinor: 0,
        },
        per_purchase_max: { amountMinor: 0 },
      });
      for (const key of ['budget_total', 'budget_split', 'per_purchase_max'])
        await decide(key, hint[key]);
      st = await status();
      expect(st.aiMonth).toMatchObject({
        open: false,
        reason: 'month_not_open',
        missing: [],
      });
      const r = await monthJob();
      expect(r).toMatchObject({ processed: 1, details: { open: 1 } });
      st = await status();
      expect(st.aiMonth).toMatchObject({ open: true, reason: null });

      // ── 5. генерация 200; снижение потолка → cap_exhausted ────────────
      ai!.model.reply(redditDraftJson(3, 'comment', src));
      const g = ok<{
        callId: string;
        call: { output: { variants: unknown[] } };
      }>(await gen(), 200);
      expect(g.call.output.variants).toHaveLength(3);
      const call = await s.prisma.pubAiCall.findUniqueOrThrow({
        where: { id: g.callId },
      });
      expect(call.requestedBy).toBe(ACTOR);
      await decide('ai_budget_usd_month', { microUsd: 1 });
      expect(await monthJob()).toMatchObject({ details: { adjusted: 1 } });
      st = await status();
      expect(st.aiMonth).toMatchObject({ open: true, reason: 'cap_exhausted' });
      expect(shape(await gen())).toMatchObject({
        status: 409,
        code: 'PUB_AI_BUDGET',
        details: { reason: 'cap_exhausted' },
      });

      // кто решал — только оператор Админки; засева нет
      const decisions = await s.prisma.pubParameterDecision.findMany({
        where: { productId },
        select: { parameterKey: true, decidedBy: true },
      });
      expect(new Set(decisions.map((d) => d.decidedBy))).toEqual(
        new Set([ACTOR]),
      );
      expect(new Set(decisions.map((d) => d.parameterKey))).toEqual(
        new Set([
          ...GATE_PARAMETER_KEYS.reddit_publish,
          'ai_budget_usd_month',
          'ai_fx_rate',
          'ai_unpriced_allowed',
          'budget_total',
          'budget_split',
          'per_purchase_max',
        ]),
      );
      const approved = await s.prisma.pubParameter.findMany({
        where: { productId, status: 'approved' },
        select: { approvedBy: true },
      });
      expect(new Set(approved.map((x) => x.approvedBy))).toEqual(
        new Set([ACTOR]),
      );
      expect(net.foreign()).toEqual([]);
    });
  },
);
