/**
 * AI Publisher P-B2 — AI-шлюз на базе (проектный документ §12.1, §6.7,
 * §7.5, §11.1; аудит P2-11, P3-13): пять выключенных генераторов,
 * гейт `ai_use`, лимит двух генераций и третья по согласованию, одна
 * повторная попытка при ошибке схемы, `opKey` → тот же вызов, неизвестная
 * цена ≠ ноль, потолок месяца при параллельных вызовах, таймаут, задания
 * `ai-calls-run` (очередь, аудит S2-1), `ai-calls-reap` и `ai-month-open`;
 * раунд исправлений: неизвестная/поздняя стоимость держит резерв (S1-4),
 * параллельный повтор `opKey` (S2-6), сверка версий конфигурации (S2-5),
 * генерация только по `open` (S3-5), смена потолка месяца (S3-6).
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { estimateCost } from '../../shared/ai-pricing';
import * as pricing from '../../shared/ai-pricing';
import { TextModelError } from '../../modules/site-ai/text-model';
import {
  P0_ENABLED_GENERATORS,
  GENERATOR_IDS,
  type GeneratorId,
} from '../../modules/publisher/contracts/ai';
import type { ProductCtx } from '../../modules/publisher/contracts/common';
import { kyivMonthOf } from '../../modules/publisher/core/kyiv-time';
import { OPERATION_TX_OPTIONS } from '../../modules/publisher/core/operation';
import type { PubTx } from '../../modules/publisher/core/ports';
import {
  coreStack,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import {
  AiGatewayService,
  type CabinetStart,
} from '../../modules/publisher/ai/ai-gateway.service';
import { PUB_CRON_SCHEDULE } from '../../modules/publisher/cron/job-registry';
import { AiCallsReapJob } from '../../modules/publisher/ai/ai-calls-reap.job';
import { AiCallsRunJob } from '../../modules/publisher/ai/ai-calls-run.job';
import { AiMonthOpenJob } from '../../modules/publisher/ai/ai-month.job';
import { AiTasksService } from '../../modules/publisher/ai/ai-tasks.service';
import { estimateCallMicroUsd } from '../../modules/publisher/ai/ai-budget';
import { PublisherAiModule } from '../../modules/publisher/ai/ai.module';
import {
  derivedOpKey,
  errorCodeOfStatus,
  isPendingEnvelope,
} from '../../modules/publisher/ai/gateway-core';
import { GENERATORS } from '../../modules/publisher/ai/generators';
import {
  AI_PARAMS,
  ScriptedModel,
  approveParams,
  helperJson,
  openAiMonth,
  seedAiSource,
  seedBoundConfig,
} from '../../modules/publisher/ai/testing/ai-kit.testing';
import {
  seedAccount,
  seedMembers,
  seedProduct,
  type SeededAccount,
} from '../../modules/publisher/testing/fixtures.testing';
import { sourceContentHash } from '../../modules/publisher/core/content-hash';
import { currentCallParams } from '../../modules/publisher/ai/config';

jest.setTimeout(90_000);

const FLAG = 'PUBLISHER_AI_ALLOW_UNEVALUATED';

ciDescribe('[AI-GW] P-B2: AI-шлюз на базі (§12.1)', () => {
  let s: CoreStack;
  let gw: AiGatewayService;
  let model: ScriptedModel;
  let acc: SeededAccount;
  let evalProduct: ProductCtx;
  const savedFlag = process.env[FLAG];

  beforeAll(async () => {
    s = await coreStack({ imports: [PublisherAiModule] });
    gw = s.mod.get(AiGatewayService);
    model = new ScriptedModel();
    gw.useModel(model);
    acc = await seedAccount(s.prisma);
    evalProduct = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'eval',
    });
  });
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    await s.close();
  });
  beforeEach(() => {
    model.queue = [];
    model.fallback = null;
    model.delayMs = 0;
    delete process.env[FLAG];
  });

  const owner = () => ({
    accountId: acc.accountId,
    ownerMemberId: acc.owner.memberId,
  });

  /** Рабочий продукт: параметры AI утверждены, месяц открыт, один источник. */
  async function freshProduct(
    opts: { month?: bigint | null; params?: boolean } = {},
  ) {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'working',
    });
    if (opts.params !== false)
      await approveParams(s.prisma, owner(), p.id, AI_PARAMS);
    if (opts.month !== null)
      await openAiMonth(s.prisma, p, opts.month ?? 20_000_000n);
    const src = await seedAiSource(s.prisma, p, {
      fragment: 'Ціна послуги — 2 000 грн.',
    });
    return { p, src };
  }

  function req(p: ProductCtx, over: Partial<CabinetStart> = {}): CabinetStart {
    return {
      product: p,
      memberId: acc.owner.memberId,
      generator: 'pub.helper.answer',
      opKey: randomUUID(),
      objectType: 'product',
      objectId: 'helper:test',
      input: { question: 'Яка ціна?', audience: 'internal' },
      context: { audience: 'internal', allowAll: true },
      ...over,
    };
  }

  /** Як маршрут: транзакція 1 + синхронний шлях (вікно 25 с). */
  function start(p: ProductCtx, over: Partial<CabinetStart> = {}) {
    return gw.startSync(req(p, over));
  }

  /** Лише транзакція 1 (модель не запускається). */
  function open(p: ProductCtx, over: Partial<CabinetStart> = {}) {
    return gw.open(req(p, over));
  }

  function done(p: ProductCtx, callId: string) {
    return gw.view(p, callId);
  }

  const estHelper = () =>
    estimateCallMicroUsd(
      'gemini-4-argon',
      GENERATORS['pub.helper.answer'].maxOutputTokens,
    ).estMicroUsd;

  const runJob = (p: ProductCtx, ms = 30_000) =>
    s.mod.get(AiCallsRunJob).run({
      now: new Date(),
      scope: { siteIds: [p.siteId] },
      deadline: new Date(Date.now() + ms),
    });

  const month = (productId: string) =>
    s.prisma.pubAiBudgetMonth.findFirst({
      where: { productId, month: kyivMonthOf(new Date()) },
    });

  it('шість генераторів поза P0 (з P-R M2 — і `pub.reddit.draft` до живого прогону 2.3) — `disabled` без виклику моделі; генерація не зараховується', async () => {
    process.env[FLAG] = 'true';
    const { p } = await freshProduct();
    const off = GENERATOR_IDS.filter(
      (g) => !(P0_ENABLED_GENERATORS as readonly string[]).includes(g),
    );
    expect(off).toHaveLength(6);
    expect(off).toContain('pub.reddit.draft');
    for (const g of off) {
      const opKey = randomUUID();
      const r = await start(p, {
        generator: g as GeneratorId,
        opKey,
        objectId: `x:${g}`,
      });
      expect(r.status).toBe('disabled');
      expect(r.plan).toBeUndefined();
      expect(errorCodeOfStatus(r.status)).toBe('PUB_AI_DISABLED');
      const again = await start(p, {
        generator: g as GeneratorId,
        opKey,
        objectId: `x:${g}`,
      });
      expect(again).toMatchObject({ callId: r.callId, replayed: true });
      const row = await s.prisma.pubAiCall.findUnique({
        where: { id: r.callId },
      });
      expect(row).toMatchObject({
        status: 'disabled',
        costStatus: 'priced',
        errorCode: 'PUB_AI_DISABLED',
      });
      expect(row!.finishedAt).not.toBeNull();
      const task = await s.prisma.pubAiTask.findUnique({
        where: { id: r.taskId },
      });
      expect(task!.generationsUsed).toBe(0);
    }
    expect(model.requests).toHaveLength(0);
  });

  it('гейт ai_use: без прив’язки — `not_evaluated` з переліком; модель не викликається', async () => {
    const { p } = await freshProduct();
    const r = await start(p);
    expect(r.status).toBe('not_evaluated');
    expect(r.missing).toContainEqual({
      kind: 'ai_config',
      key: 'binding',
      detail: 'none',
    });
    expect(errorCodeOfStatus(r.status, r.missing)).toBe('PUB_AI_NOT_EVALUATED');
    // параметри не затверджені, але прапорець розробки — лише параметри → PUB_GATE_CLOSED
    process.env[FLAG] = 'true';
    const { p: p2 } = await freshProduct({ params: false });
    const r2 = await start(p2);
    expect(r2.status).toBe('not_evaluated');
    expect(r2.missing!.every((m) => m.kind === 'parameter')).toBe(true);
    expect(errorCodeOfStatus(r2.status, r2.missing)).toBe('PUB_GATE_CLOSED');
    expect(model.requests).toHaveLength(0);
  });

  it('прив’язка до `passed`: виклик ok — журнал, вартість, резерв замінено фактом, usage pub-*, контекст недовірений', async () => {
    const { p, src } = await freshProduct();
    const { configId } = await seedBoundConfig(
      s.prisma,
      owner(),
      evalProduct.id,
      p.id,
    );
    const fact = await s.prisma.pubBrandFact.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        factKey: 'price.service',
        kind: 'price',
        value: { amountMinor: 200000, currency: 'UAH', note: 'без розміщень' },
        version: 1,
        status: 'active',
        approvedBy: `member:${acc.owner.memberId}`,
        approvedAt: new Date(),
        createdBy: 'system:test-seed',
      },
    });
    model.reply(helperJson([src]));
    const r = await start(p);
    expect(r.status).toBe('running');
    const v = await done(p, r.callId);
    expect(v).toMatchObject({
      status: 'ok',
      attemptNo: 1,
      costStatus: 'priced',
      contextSourceIds: [src],
      // факти бренду контексту — екрану для зв’язку з версією (§12.3)
      contextFactIds: [fact.id],
    });
    expect(v.output).toMatchObject({ used_source_ids: [src] });
    const row = await s.prisma.pubAiCall.findUnique({
      where: { id: r.callId },
    });
    expect(row).toMatchObject({
      configId,
      model: 'gemini-4-argon',
      provider: 'gemini',
      instructionVersion: 'pub.helper.answer@1',
      contextRulesVersion: 'ctx@1',
      inputTokens: 1000,
      outputTokens: 200,
    });
    const cost = estimateCost('gemini-4-argon', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200,
    }).costMicroUsd;
    expect(row!.costMicroUsd).toBe(BigInt(cost));
    const m = await month(p.id);
    expect(m!.reservedMicroUsd).toBe(0n);
    expect(m!.spentMicroUsd).toBe(BigInt(cost));
    const usage = await s.prisma.siteAiUsage.findFirst({
      where: { accountId: acc.accountId, operation: 'pub-helper-answer' },
      orderBy: { createdAt: 'desc' },
    });
    expect(usage).toMatchObject({
      product: 'publisher',
      siteId: p.siteId,
      unpriced: false,
    });
    const req = model.requests.at(-1)!;
    expect(req).toMatchObject({
      json: true,
      temperature: 0.2,
      model: 'gemini-4-argon',
    });
    expect(req.user).toContain(`<source id="${src}" trust="untrusted"`);
    expect(req.user).toContain('<request kind="question" trust="untrusted">');
    const task = await s.prisma.pubAiTask.findUnique({
      where: { id: r.taskId },
    });
    expect(task!.generationsUsed).toBe(1);
  });

  it('модель/інструкція виклику ≠ конфігурації → `not_evaluated` (mismatch)', async () => {
    const { p } = await freshProduct();
    await seedBoundConfig(s.prisma, owner(), evalProduct.id, p.id, {
      instructionVersions: Object.fromEntries(
        P0_ENABLED_GENERATORS.map((g) => [g, `${g}@0`]),
      ),
    });
    const r = await start(p);
    expect(r.status).toBe('not_evaluated');
    expect(r.missing).toContainEqual({
      kind: 'ai_config',
      key: 'instruction',
      detail: 'mismatch',
    });
    const { p: p2 } = await freshProduct();
    await seedBoundConfig(s.prisma, owner(), evalProduct.id, p2.id, {
      status: 'failed',
    });
    const r2 = await start(p2);
    expect(r2.missing).toContainEqual({
      kind: 'ai_config',
      key: 'eval',
      detail: 'failed',
    });
  });

  it('opKey: повтор — той самий виклик без моделі; той самий ключ з іншим запитом — 409', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.reply(helperJson([src]));
    const opKey = randomUUID();
    const r = await start(p, { opKey });
    const n = model.requests.length;
    const again = await start(p, { opKey });
    expect(again).toMatchObject({
      callId: r.callId,
      replayed: true,
      status: 'ok',
    });
    expect(model.requests).toHaveLength(n);
    await expect(
      start(p, {
        opKey,
        input: { question: 'Інше питання', audience: 'internal' },
      }),
    ).rejects.toMatchObject({
      code: 'PUB_IDEMPOTENCY_REUSED',
    });
  });

  it('ліміт 2 генерацій на задачу; третя — лише після рішення редактора (approval ai_extra_generation)', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.fallback = helperJson([src]);
    const a = await start(p);
    const b = await start(p);
    expect([a.taskId]).toEqual([b.taskId]);
    const third = start(p);
    await expect(third).rejects.toMatchObject({ code: 'PUB_AI_LIMIT' });
    const calls = await s.prisma.pubAiCall.count({
      where: { taskId: a.taskId },
    });
    expect(calls).toBe(2);
    // база: третья генерация без согласования невозможна
    await expect(
      s.prisma.pubAiTask.update({
        where: { id: a.taskId },
        data: { extraAllowance: 1 },
      }),
    ).rejects.toThrow(/ai_extra_generation/);
    const tasks = s.mod.get(AiTasksService);
    const now = new Date();
    const out = await s.db.forAccount(acc.accountId).$transaction(
      (tx) =>
        tasks.extra(tx as PubTx, p, a.taskId, {
          reason: 'Потрібен ще один варіант відповіді',
          memberId: acc.owner.memberId,
          actor: `member:${acc.owner.memberId}`,
          now,
        }),
      OPERATION_TX_OPTIONS,
    );
    expect(out.view).toMatchObject({ extraAllowance: 1, remaining: 1 });
    const approval = await s.prisma.pubApproval.findUnique({
      where: { id: out.view.extraApprovalId! },
    });
    expect(approval).toMatchObject({
      type: 'ai_extra_generation',
      objectType: 'ai_task',
      objectId: a.taskId,
      status: 'active',
    });
    const c = await start(p);
    expect(c.status).toBe('running');
    await expect(start(p)).rejects.toMatchObject({ code: 'PUB_AI_LIMIT' });
    // ліміт ще не вичерпано — додаткова генерація не потрібна
    const fresh = await start(p, { objectId: 'helper:other' });
    await expect(
      s.db.forAccount(acc.accountId).$transaction((tx) =>
        tasks.extra(tx as PubTx, p, fresh.taskId, {
          reason: 'Ще варіант',
          memberId: acc.owner.memberId,
          actor: `member:${acc.owner.memberId}`,
          now,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PUB_VALIDATION' });
  });

  it('помилка схеми → одна повторна спроба (друга генерація); друга невдача — задача needs_human', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.reply('{"answer": "без полів"}', helperJson([src]));
    const r = await start(p);
    const v = await done(p, r.callId);
    expect(v).toMatchObject({ status: 'ok', attemptNo: 2 });
    const first = await s.prisma.pubAiCall.findUnique({
      where: { id: r.callId },
    });
    expect(first).toMatchObject({
      status: 'schema_invalid',
      rawExcerpt: '{"answer": "без полів"}',
    });
    expect(first!.errorCode).toMatch(/^schema:/);
    const retry = await s.prisma.pubAiCall.findFirst({
      where: { opKey: derivedOpKey(first!.opKey, 'schema-retry') },
    });
    expect(retry!.id).toBe(v.callId);
    expect(model.requests.at(-1)!.user).toContain('не пройшла перевірку схеми');
    expect(
      (await s.prisma.pubAiTask.findUnique({ where: { id: r.taskId } }))!,
    ).toMatchObject({
      generationsUsed: 2,
      status: 'open',
    });
    // обидві невдалі
    model.reply('не json', helperJson(['src_not_in_context']));
    const r2 = await start(p, { objectId: 'helper:bad' });
    const v2 = await done(p, r2.callId);
    expect(v2).toMatchObject({ status: 'schema_invalid', attemptNo: 2 });
    expect(errorCodeOfStatus(v2.status)).toBe('PUB_AI_SCHEMA_INVALID');
    expect(
      (await s.prisma.pubAiTask.findUnique({ where: { id: r2.taskId } }))!
        .status,
    ).toBe('needs_human');
  });

  it('невідома ціна моделі — `unpriced_blocked`; дозволено параметром — `unpriced`, NULL (не нуль)', async () => {
    const { p, src } = await freshProduct();
    // A configured model stays Argon. Simulate a missing price entry rather
    // than selecting a different, unevaluated model through the binding.
    await seedBoundConfig(s.prisma, owner(), evalProduct.id, p.id);
    const realRate = pricing.rateFor;
    const realCost = pricing.estimateCost;
    const rate = jest
      .spyOn(pricing, 'rateFor')
      .mockImplementation((name, env) =>
        name === 'gemini-4-argon' ? null : realRate(name, env),
      );
    const cost = jest
      .spyOn(pricing, 'estimateCost')
      .mockImplementation((name, units, env) =>
        realCost(
          name === 'gemini-4-argon' ? 'mystery-model-x' : name,
          units,
          env,
        ),
      );
    try {
      const r = await start(p);
      expect(r.status).toBe('unpriced_blocked');
      expect(errorCodeOfStatus(r.status, r.missing)).toBe('PUB_AI_UNPRICED');
      await approveParams(s.prisma, owner(), p.id, {
        ai_unpriced_allowed: { allowed: true },
      });
      model.reply(helperJson([src]));
      const r2 = await start(p, { objectId: 'helper:u' });
      const v = await done(p, r2.callId);
      expect(v).toMatchObject({
        status: 'ok',
        costStatus: 'unpriced',
        costMicroUsd: null,
      });
      const row = await s.prisma.pubAiCall.findUnique({
        where: { id: r2.callId },
      });
      expect(row!.costMicroUsd).toBeNull();
      const usage = await s.prisma.siteAiUsage.findFirst({
        where: {
          accountId: acc.accountId,
          siteId: p.siteId,
          model: 'gemini-4-argon',
        },
      });
      expect(usage).toMatchObject({ unpriced: true, product: 'publisher' });
    } finally {
      rate.mockRestore();
      cost.mockRestore();
    }
  });

  it('потолок місяця: місяць не відкрито / вичерпано — `budget_blocked`; паралельні виклики не перевищують стелю', async () => {
    process.env[FLAG] = 'true';
    const noMonth = await freshProduct({ month: null });
    expect((await start(noMonth.p)).status).toBe('budget_blocked');
    const est = estimateCallMicroUsd(
      'gemini-4-argon',
      GENERATORS['pub.helper.answer'].maxOutputTokens,
    ).estMicroUsd;
    const { p, src } = await freshProduct({ month: est * 2n + est / 2n });
    model.fallback = helperJson([src]);
    model.delayMs = 300;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        open(p, { objectId: `helper:par${i}` }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([
      'budget_blocked',
      'budget_blocked',
      'budget_blocked',
      'budget_blocked',
      'running',
      'running',
    ]);
    const mid = await month(p.id);
    expect(mid!.reservedMicroUsd).toBe(est * 2n);
    expect(mid!.reservedMicroUsd + mid!.spentMicroUsd <= mid!.capMicroUsd).toBe(
      true,
    );
    await Promise.all(
      results.filter((r) => r.plan).map((r) => gw.execute(r.plan!)),
    );
    const after = await month(p.id);
    expect(after!.reservedMicroUsd).toBe(0n);
    expect(after!.spentMicroUsd > 0n).toBe(true);
    const blocked = await s.prisma.pubAiCall.findFirst({
      where: { id: results.find((r) => r.status === 'budget_blocked')!.callId },
    });
    expect(blocked!.errorCode).toBe('PUB_AI_BUDGET:cap_exhausted');
  });

  it('таймаут моделі — `timeout`, вартість невідома (NULL), резерв ТРИМАЄТЬСЯ (S1-4: невідоме не нуль), генерація зарахована', async () => {
    process.env[FLAG] = 'true';
    const { p } = await freshProduct();
    model.reply(new TextModelError('timeout'));
    const r = await start(p);
    const v = await done(p, r.callId);
    expect(v).toMatchObject({
      status: 'timeout',
      costStatus: 'unknown',
      costMicroUsd: null,
    });
    expect(errorCodeOfStatus(v.status)).toBe('PUB_AI_UNAVAILABLE');
    const m = await month(p.id);
    expect([String(m!.reservedMicroUsd), String(m!.spentMicroUsd)]).toEqual([
      String(estHelper()),
      '0',
    ]);
    expect(
      (await s.prisma.pubAiTask.findUnique({ where: { id: r.taskId } }))!
        .generationsUsed,
    ).toBe(1);
  });

  it('ai-calls-reap: running старше 10 хв → timeout, резерв НЕ знято (S1-4); пізня відповідь моделі дописує факт у виклик і місяць', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    let release!: () => void;
    model.reply(
      () =>
        new Promise<string>((res) => (release = () => res(helperJson([src])))),
    );
    const r = await open(p);
    const est = estHelper();
    expect(String((await month(p.id))!.reservedMicroUsd)).toBe(String(est));
    const pending = gw.execute(r.plan!);
    const job = s.mod.get(AiCallsReapJob);
    const scope = { siteIds: [p.siteId] };
    const fresh = await job.run({
      now: new Date(),
      scope,
      deadline: new Date(Date.now() + 30_000),
    });
    expect(fresh.processed).toBe(0);
    const later = new Date(Date.now() + 11 * 60_000);
    const res = await job.run({
      now: later,
      scope,
      deadline: new Date(Date.now() + 30_000),
    });
    expect(res.processed).toBe(1);
    const row = await s.prisma.pubAiCall.findUnique({
      where: { id: r.callId },
    });
    expect(row).toMatchObject({
      status: 'timeout',
      errorCode: 'reaped',
      costStatus: 'unknown',
    });
    // резерв тримається до звірки (невідома вартість — не нуль)
    expect(String((await month(p.id))!.reservedMicroUsd)).toBe(String(est));
    // пізня відповідь: підсумок завдання не перезаписано, факт дописано
    release();
    await pending;
    const cost = estimateCost('gemini-4-argon', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200,
    }).costMicroUsd;
    const late = await s.prisma.pubAiCall.findUnique({
      where: { id: r.callId },
    });
    expect({
      status: late!.status,
      errorCode: late!.errorCode,
      costStatus: late!.costStatus,
      cost: String(late!.costMicroUsd),
      outputTokens: late!.outputTokens,
    }).toEqual({
      status: 'timeout',
      errorCode: 'reaped:late_cost',
      costStatus: 'priced',
      cost: String(cost),
      outputTokens: 200,
    });
    const m = await month(p.id);
    expect([String(m!.reservedMicroUsd), String(m!.spentMicroUsd)]).toEqual([
      '0',
      String(cost),
    ]);
  });

  it('S2-1 черга: вікно синхронного шляху вийшло — виклик `running` (202), конверт без відповіді; `ai-calls-run` виконує під орендою, резерв за перервану спробу тримається', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.fallback = helperJson([src]);
    model.delayMs = 400;
    const r = await gw.startSync(req(p), 100);
    expect({ status: r.status, handedOff: r.handedOff }).toEqual({
      status: 'running',
      handedOff: true,
    });
    const v = await done(p, r.callId);
    expect({ status: v.status, output: v.output }).toEqual({
      status: 'running',
      output: null,
    });
    const row = await s.prisma.pubAiCall.findUnique({
      where: { id: r.callId },
    });
    expect(isPendingEnvelope(row!.output)).toBe(true);
    expect(
      (row!.output as { pending: { aborted?: number } }).pending.aborted,
    ).toBe(1);
    // свіжий виклик під орендою (процес ще може виконувати) — завдання не бере
    const leased = await open(p, { objectId: 'helper:leased' });
    const n = model.requests.length;
    const pass = await runJob(p);
    expect(pass.details).toMatchObject({ executed: 1, refused: 0 });
    expect(model.requests.length).toBe(n + 1);
    const after = await done(p, r.callId);
    expect(after).toMatchObject({ status: 'ok', costStatus: 'priced' });
    expect(after.output).toMatchObject({ used_source_ids: [src] });
    expect(
      (await s.prisma.pubAiCall.findUnique({ where: { id: leased.callId } }))!
        .status,
    ).toBe('running');
    // повторний прохід — нічого (ідемпотентно)
    expect((await runJob(p)).details).toMatchObject({ executed: 0 });
    const cost = estimateCost('gemini-4-argon', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200,
    }).costMicroUsd;
    const m = await month(p.id);
    // перервана спроба могла коштувати — її оцінка лишається в резерві;
    // + оцінка ще не виконаного leased
    expect([String(m!.reservedMicroUsd), String(m!.spentMicroUsd)]).toEqual([
      String(estHelper() * 2n),
      String(cost),
    ]);
  });

  it('S2-1 черга: джерело відкликано за час очікування — виклик `refused`, модель не викликається', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.delayMs = 400;
    model.fallback = helperJson([src]);
    const r = await gw.startSync(
      req(p, {
        objectId: 'helper:revoke',
        context: { audience: 'internal', sourceIds: [src] },
      }),
      100,
    );
    expect(r.handedOff).toBe(true);
    await s.prisma.pubSource.update({
      where: { id: src },
      data: {
        usage: 'revoked',
        revokedAt: new Date(),
        revokedBy: 'system:test-seed',
        revokeReason: 'тест',
      },
    });
    const n = model.requests.length;
    const pass = await runJob(p);
    expect(pass.details).toMatchObject({ refused: 1, executed: 0 });
    expect(model.requests.length).toBe(n);
    const row = await s.prisma.pubAiCall.findUnique({
      where: { id: r.callId },
    });
    expect({
      status: row!.status,
      errorCode: row!.errorCode,
      output: row!.output,
    }).toEqual({
      status: 'refused',
      errorCode: 'PUB_SOURCE_NOT_ALLOWED',
      output: null,
    });
  });

  it('S2-6: паралельні повтори того самого opKey → той самий callId (не 409); інший учасник з чужим opKey — 409', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.fallback = helperJson([src]);
    const opKey = randomUUID();
    const all = await Promise.all(
      Array.from({ length: 4 }, () =>
        open(p, { opKey, objectId: 'helper:race' }),
      ),
    );
    expect(new Set(all.map((x) => x.callId)).size).toBe(1);
    expect(all.filter((x) => !x.replayed)).toHaveLength(1);
    expect(
      await s.prisma.pubAiCall.count({ where: { productId: p.id, opKey } }),
    ).toBe(1);
    // M4: той самий ключ і запит, але інший учасник — не чужий виклик
    await expect(
      gw.open({
        ...req(p, { opKey, objectId: 'helper:race' }),
        memberId: 'other-member-x',
      }),
    ).rejects.toMatchObject({ code: 'PUB_IDEMPOTENCY_REUSED' });
  });

  it('S2-5: правила контексту, набір схем, провайдер виклику ≠ конфігурації → `not_evaluated` (mismatch)', async () => {
    for (const [key, over] of [
      ['contextRulesVersion', { contextRulesVersion: 'ctx@0' }],
      ['schemaSetVersion', { schemaSetVersion: 'schemas@0' }],
      ['provider', { provider: 'other-provider' }],
      ['model', { model: 'gemini-3.6-flash' }],
    ] as const) {
      const { p } = await freshProduct();
      await seedBoundConfig(s.prisma, owner(), evalProduct.id, p.id, over);
      const r = await open(p, { objectId: `helper:${key}` });
      expect({ status: r.status, missing: r.missing }).toEqual({
        status: 'not_evaluated',
        missing: expect.arrayContaining([
          { kind: 'ai_config', key, detail: 'mismatch' },
        ]),
      });
    }
  });

  it('S3-5: генерація лише за задачею `open`; `needs_human` повертає в роботу лише рішення редактора (reopen), `done` — ні', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    const tasks = s.mod.get(AiTasksService);
    const t = s.db.forAccount(acc.accountId);
    // done: прийнятий результат — нова генерація неможлива
    model.reply(helperJson([src]));
    const ok = await start(p, { objectId: 'helper:accepted' });
    await t.$transaction(
      (tx) =>
        tasks.accept(tx as PubTx, p, ok.taskId, {
          callId: ok.callId,
          actors: ['editor'],
        }),
      OPERATION_TX_OPTIONS,
    );
    await expect(
      start(p, { objectId: 'helper:accepted' }),
    ).rejects.toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: expect.objectContaining({ from: 'done' }),
    });
    const now = new Date();
    const extra = (taskId: string) =>
      t.$transaction(
        (tx) =>
          tasks.extra(tx as PubTx, p, taskId, {
            reason: 'Потрібна ще одна спроба',
            memberId: acc.owner.memberId,
            actor: `member:${acc.owner.memberId}`,
            now,
            actors: ['editor'],
          }),
        OPERATION_TX_OPTIONS,
      );
    await expect(extra(ok.taskId)).rejects.toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
    });
    // needs_human: дві невдачі схеми
    model.reply('не json', 'теж не json');
    const bad = await start(p, { objectId: 'helper:nh' });
    expect(
      (await s.prisma.pubAiTask.findUnique({ where: { id: bad.taskId } }))!
        .status,
    ).toBe('needs_human');
    await expect(start(p, { objectId: 'helper:nh' })).rejects.toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: expect.objectContaining({ from: 'needs_human' }),
    });
    // роль без права reopen (оператор) — відмова машини
    await expect(
      t.$transaction(
        (tx) =>
          tasks.extra(tx as PubTx, p, bad.taskId, {
            reason: 'Потрібна ще одна спроба',
            memberId: acc.owner.memberId,
            actor: `member:${acc.owner.memberId}`,
            now,
            actors: ['operator'],
          }),
        OPERATION_TX_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: 'PUB_ROLE_REQUIRED' });
    const reopened = await extra(bad.taskId);
    expect(reopened.view).toMatchObject({
      status: 'open',
      extraAllowance: 1,
      remaining: 1,
    });
    model.reply(helperJson([src]));
    const again = await start(p, { objectId: 'helper:nh' });
    expect((await done(p, again.callId)).status).toBe('ok');
  });

  it('S3-8: порт acceptCall приймає лише виклик `ok`', async () => {
    process.env[FLAG] = 'true';
    const { p } = await freshProduct();
    model.reply('не json', 'не json');
    const bad = await start(p, { objectId: 'helper:port' });
    const tasks = s.mod.get(AiTasksService);
    await expect(
      s.db.forAccount(acc.accountId).$transaction(
        (tx) =>
          tasks.acceptCall(tx as PubTx, p, bad.callId, {
            actors: ['editor'],
          }),
        OPERATION_TX_OPTIONS,
      ),
    ).rejects.toMatchObject({
      code: 'PUB_VALIDATION',
      details: { fields: [{ field: 'aiCallId', code: 'ai_call' }] },
    });
  });

  it('завдання P-B2 зареєстровані за §15.1: ai-calls-run — minute, ai-calls-reap і ai-month-open — tick', () => {
    const jobs = [
      s.mod.get(AiCallsRunJob),
      s.mod.get(AiCallsReapJob),
      s.mod.get(AiMonthOpenJob),
    ];
    expect(jobs.map((j) => [j.key, j.schedule])).toEqual([
      ['ai-calls-run', 'minute'],
      ['ai-calls-reap', 'tick'],
      ['ai-month-open', 'tick'],
    ]);
    for (const job of jobs) {
      expect(PUB_CRON_SCHEDULE[job.key]).toEqual({
        schedule: job.schedule,
        owner: 'P-B2',
      });
    }
  });

  /** Функции бюджета P-C в базе (до интеграции Z их может не быть). */
  async function budgetFns(): Promise<boolean> {
    const r = await s.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'sites' AND p.proname IN ('pub_budget_commit_tools', 'pub_budget_cancel')`,
    );
    return r[0].n === 2;
  }

  it('ai-month-open: без функцій бюджету P-C — `pending` (крон 501); месяц без зобов’язання не створюється', async () => {
    const fns = await budgetFns();
    const { p } = await freshProduct({ month: null });
    const job = s.mod.get(AiMonthOpenJob);
    const r = await job.run({
      now: new Date(),
      scope: { siteIds: [p.siteId] },
      deadline: new Date(Date.now() + 30_000),
    });
    // гейт spend закритий (бюджет не затверджено) — місяць не відкрито
    expect({
      pending: r.pending ?? [],
      spendGateClosed: r.details?.spendGateClosed ?? 0,
      processed: r.processed,
      month: await month(p.id),
    }).toEqual({
      pending: fns
        ? []
        : ['pub_budget_commit_tools (P-C)', 'pub_budget_cancel (P-C)'],
      spendGateClosed: fns ? 1 : 0,
      processed: 0,
      month: null,
    });
    // продукт без затверджених параметрів AI — не кандидат
    const { p: p2 } = await freshProduct({ month: null, params: false });
    const r2 = await job.run({
      now: new Date(),
      scope: { siteIds: [p2.siteId] },
      deadline: new Date(Date.now() + 30_000),
    });
    expect(r2).toEqual({
      processed: 0,
      details: expect.objectContaining({ open: 0 }),
    });
  });

  it('ai-month-open з функціями P-C: зобов’язання tools за курсом під гейтом spend; наступний місяць закриває невикористане', async () => {
    if (!(await budgetFns())) return; // до інтеграції Z — перевіряє тест вище (pending)
    const { p } = await freshProduct({ month: null });
    await approveParams(s.prisma, owner(), p.id, {
      budget_total: null,
      budget_split: null,
      per_purchase_max: null,
    });
    const versions = await s.prisma.pubParameter.findMany({
      where: {
        productId: p.id,
        key: { in: ['budget_total', 'budget_split', 'per_purchase_max'] },
      },
      select: { key: true, version: true },
    });
    const paramVersion = versions.reduce((n, v) => n + v.version, 0);
    await s.prisma.$queryRawUnsafe(
      `SELECT "sites"."pub_budget_apply_limits"($1, $2, 'UAH', 1000000, 600000, 200000, 200000, 200000, $3, 'system:test-seed')`,
      p.id,
      acc.accountId,
      paramVersion,
    );
    const job = s.mod.get(AiMonthOpenJob);
    const scope = { siteIds: [p.siteId] };
    const now = new Date('2026-10-20T09:00:00Z');
    const r = await job.run({
      now,
      scope,
      deadline: new Date(Date.now() + 30_000),
    });
    expect(r).toMatchObject({ processed: 1, details: { open: 1 } });
    const m = await s.prisma.pubAiBudgetMonth.findFirst({
      where: { productId: p.id, month: '2026-10' },
    });
    expect(String(m!.capMicroUsd)).toBe('20000000');
    const exp = await s.prisma.pubExpense.findUnique({
      where: { id: m!.expenseId! },
    });
    // 20 USD = 2 000 центів × 41.5 = 83 000 копійок, категорія tools, валюта ліміту
    expect({
      category: exp!.category,
      amount: String(exp!.amountTotalMinor),
      currency: exp!.currency,
      orig: `${exp!.origAmountMinor} ${exp!.origCurrency}`,
    }).toEqual({
      category: 'tools',
      amount: '83000',
      currency: 'UAH',
      orig: '2000 USD',
    });
    const limit = await s.prisma.pubBudgetLimit.findFirst({
      where: { productId: p.id },
    });
    expect([
      String(limit!.openCommitMinor),
      String(limit!.usedToolsMinor),
    ]).toEqual(['83000', '83000']);
    // повтор у тому ж місяці — нічого
    expect(
      (await job.run({ now, scope, deadline: new Date(Date.now() + 30_000) }))
        .processed,
    ).toBe(0);
    const monthExpenses = async (mm: string) => {
      const rows = await s.prisma.pubExpense.findMany({
        where: { productId: p.id, sourceDocument: `ai_budget_usd_month@${mm}` },
      });
      return {
        count: rows.length,
        total: String(rows.reduce((a, r) => a + r.amountTotalMinor, 0n)),
        cancelled: String(rows.reduce((a, r) => a + r.cancelledMinor, 0n)),
      };
    };
    // S3-6: потолок піднято до 30 USD посеред місяця → додаткове зобов’язання
    // на різницю (10 USD = 41 500 коп.) тим самим документом
    await approveParams(s.prisma, owner(), p.id, {
      ai_budget_usd_month: { microUsd: 30_000_000 },
    });
    const raise = await job.run({
      now,
      scope,
      deadline: new Date(Date.now() + 30_000),
    });
    expect(raise.details).toMatchObject({ adjusted: 1, open: 0 });
    expect(await monthExpenses('2026-10')).toEqual({
      count: 2,
      total: '124500',
      cancelled: '0',
    });
    expect(
      String(
        (await s.prisma.pubAiBudgetMonth.findUnique({ where: { id: m!.id } }))!
          .capMicroUsd,
      ),
    ).toBe('30000000');
    // витрачено 5 USD і 2 USD у резерві; потолок знижено до 4 USD → не нижче
    // витраченого + резерву (7 USD = 29 050 коп.): скасовано 95 450
    await s.prisma.pubAiBudgetMonth.update({
      where: { id: m!.id },
      data: { spentMicroUsd: 5_000_000n, reservedMicroUsd: 2_000_000n },
    });
    await approveParams(s.prisma, owner(), p.id, {
      ai_budget_usd_month: { microUsd: 4_000_000 },
    });
    await job.run({ now, scope, deadline: new Date(Date.now() + 30_000) });
    expect(await monthExpenses('2026-10')).toEqual({
      count: 2,
      total: '124500',
      cancelled: '95450',
    });
    // закриття жовтня: скасовується все понад витрачене + резерв (резерв
    // невідомої вартості, S1-4, не скасовується): 5 + 1 USD = 24 900 коп.
    // лишаються, скасовано ще 4 150
    await s.prisma.pubAiBudgetMonth.update({
      where: { id: m!.id },
      data: { reservedMicroUsd: 1_000_000n },
    });
    await approveParams(s.prisma, owner(), p.id, {
      ai_budget_usd_month: { microUsd: 20_000_000 },
    });
    const nov = await job.run({
      now: new Date('2026-11-02T09:00:00Z'),
      scope,
      deadline: new Date(Date.now() + 30_000),
    });
    expect(nov.processed).toBe(1);
    expect(await monthExpenses('2026-10')).toEqual({
      count: 2,
      total: '124500',
      cancelled: '99600',
    });
    expect(
      await s.prisma.pubAiBudgetMonth.count({
        where: { productId: p.id, month: '2026-11' },
      }),
    ).toBe(1);
  });

  /** Аренда снята: вызов, созданный `open`, берёт ближайший проход очереди. */
  const expireLease = (callId: string) =>
    s.prisma.$executeRawUnsafe(
      `UPDATE "sites"."pub_ai_calls" SET "updatedAt" = now() - interval '2 minutes' WHERE "id" = $1`,
      callId,
    );

  it('D2-03: очередь перепроверяет право автора — грант отозван после 202 → `refused` (PUB_ROLE_REQUIRED), модель не вызвана, стоимость 0, резерв снят', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    const team = await seedMembers(s.prisma, p, acc.owner);
    model.fallback = helperJson([src]);
    const r = await open(p, {
      memberId: team.editor.memberId,
      objectId: 'helper:role-revoked',
    });
    expect(r.status).toBe('running');
    // D2-04: параметри виклику — у журналі виклику
    const created = await s.prisma.pubAuditEvent.findFirstOrThrow({
      where: { objectType: 'ai_call', objectId: r.callId, action: 'create' },
    });
    expect((created.meta as { params?: unknown }).params).toEqual({
      temperature: 0.2,
      maxOutputTokens: GENERATORS['pub.helper.answer'].maxOutputTokens,
      thinkingHeadroom: 1024,
      thinkingBudget: 'provider_default',
    });
    await s.prisma.pubRoleGrant.updateMany({
      where: {
        productId: p.id,
        memberId: team.editor.memberId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedBy: `member:${acc.owner.memberId}`,
      },
    });
    await expireLease(r.callId);
    const n = model.requests.length;
    expect((await runJob(p)).details).toMatchObject({
      refused: 1,
      executed: 0,
    });
    expect(model.requests.length).toBe(n);
    const row = await s.prisma.pubAiCall.findUniqueOrThrow({
      where: { id: r.callId },
    });
    expect({
      status: row.status,
      errorCode: row.errorCode,
      costStatus: row.costStatus,
      cost: String(row.costMicroUsd),
    }).toEqual({
      status: 'refused',
      errorCode: 'PUB_ROLE_REQUIRED',
      costStatus: 'priced',
      cost: '0',
    });
    const m = await month(p.id);
    expect([String(m!.reservedMicroUsd), String(m!.spentMicroUsd)]).toEqual([
      '0',
      '0',
    ]);
    // з дійсним грантом той самий шлях виконується
    const ok = await open(p, {
      memberId: team.product_owner.memberId,
      objectId: 'helper:role-ok',
    });
    await expireLease(ok.callId);
    expect((await runJob(p)).details).toMatchObject({ executed: 1 });
  });

  it('D2-03: прив’язку конфігурації знято, поки виклик у черзі → `refused` (PUB_AI_NOT_EVALUATED)', async () => {
    const { p, src } = await freshProduct();
    const { bindingId } = await seedBoundConfig(
      s.prisma,
      owner(),
      evalProduct.id,
      p.id,
    );
    model.fallback = helperJson([src]);
    const r = await open(p, { objectId: 'helper:unbound' });
    expect(r.status).toBe('running');
    await s.prisma.pubAiConfigBinding.update({
      where: { id: bindingId },
      data: {
        unboundAt: new Date(),
        unboundBy: `member:${acc.owner.memberId}`,
      },
    });
    await expireLease(r.callId);
    const n = model.requests.length;
    expect((await runJob(p)).details).toMatchObject({ refused: 1 });
    expect(model.requests.length).toBe(n);
    expect(
      (await s.prisma.pubAiCall.findUniqueOrThrow({ where: { id: r.callId } }))
        .errorCode,
    ).toBe('PUB_AI_NOT_EVALUATED');
  });

  it('D2-04: параметри виклику — у hash конфігурації; змінено (температура) → прив’язана конфігурація не підходить коду (`config_hash`)', async () => {
    const { p } = await freshProduct();
    await seedBoundConfig(s.prisma, owner(), evalProduct.id, p.id, {
      callParams: { ...currentCallParams(), temperature: 0.7 },
    });
    const r = await open(p, { objectId: 'helper:params' });
    expect({ status: r.status, missing: r.missing }).toEqual({
      status: 'not_evaluated',
      missing: [{ kind: 'ai_config', key: 'config_hash', detail: 'mismatch' }],
    });
  });

  it('D2-02: реальний cuid з цифрами в id джерела не маскується (флейк Z2-11), а `tel_380…` у тексті — маскується', async () => {
    process.env[FLAG] = 'true';
    const { p } = await freshProduct();
    // cuid-формат (25 знаків) з 10 цифрами поспіль — як у флейку Z2-11
    const id = `c0671234567${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const fragment = 'Контакт: tel_380670001122, ціна 2 000 грн.';
    await s.prisma.pubSource.create({
      data: {
        id,
        accountId: p.accountId,
        productId: p.id,
        kind: 'manual_text',
        title: 'Джерело',
        fragment,
        usage: 'allowed',
        visibility: 'private',
        contentHash: sourceContentHash(null, fragment),
        createdBy: 'system:test-seed',
      },
    });
    model.reply(helperJson([id]));
    const r = await start(p, {
      objectId: 'helper:cuid',
      context: { audience: 'internal', sourceIds: [id] },
    });
    const v = await done(p, r.callId);
    expect(v.status).toBe('ok');
    expect(v.output).toMatchObject({ used_source_ids: [id] });
    const sent = model.requests.at(-1)!.user;
    expect(sent).toContain(`<source id="${id}"`);
    expect(sent).not.toContain('380670001122');
  });

  it('D2-05: «числа поза контекстом» — показано, які саме; однозначне число з одиницею теж ловиться, номер пункту — ні', async () => {
    process.env[FLAG] = 'true';
    const { p, src } = await freshProduct();
    model.reply(helperJson([src], 'Крок 1. Займе рівно 3 тижні та 1500 грн.'));
    const r = await start(p, { objectId: 'helper:numbers' });
    const v = await done(p, r.callId);
    expect(v.findings).toContainEqual({
      code: 'number_not_in_context',
      severity: 'warning',
      text: 'Є числа, яких немає в контексті — перевірте: 1500, 3',
    });
  });
});
