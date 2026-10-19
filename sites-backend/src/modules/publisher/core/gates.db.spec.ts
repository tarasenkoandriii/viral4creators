/**
 * Гейты на базе (P-A1, проектный документ §10; гейты для AT-CORE-12):
 * каждый вид `missing`, продукт `kind=test` без live/хоста, eval/restored —
 * закрыто, предложение параметра гейт не закрывает, `refreshGateFlags` ≡
 * параметрической части `evaluateGate`.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { P0_ENABLED_GENERATORS } from '../contracts/ai';
import type { GateName } from '../contracts/common';
import {
  DEFAULT_PARAMETER_VALUES,
  GATE_PARAMETER_KEYS,
  PARAMETER_KEYS,
  type ParameterKey,
} from '../contracts/parameters';
import {
  seedAccount,
  seedProduct,
  seedVerifiedHost,
  type SeededAccount,
  approvableValue,
} from '../testing/fixtures.testing';
import { sha256Hex } from './content-hash';
import { PUB_ERROR_MESSAGES } from '../contracts/errors';
import type { PubError } from './errors';
import { GateService, evaluateGate } from './gates';
import { OPERATION_TX_OPTIONS } from './operation';
import { ParametersService } from './parameters.service';
import { ProductService } from './product.service';
import { refreshGateFlags } from './refresh-gate-flags';
import type { Actor } from './state-machines';
import { coreStack, type CoreStack } from './testing/core-stack.testing';

jest.setTimeout(60_000);

ciDescribe('Publisher P-A1: гейты (§10) на базе', () => {
  let s: CoreStack;
  let acc: SeededAccount;
  const now = new Date();

  beforeAll(async () => {
    s = await coreStack();
    acc = await seedAccount(s.prisma);
  });
  afterAll(async () => {
    await s.close();
  });

  /** Утвердить ключи напрямую (решение той же версии — потом параметр). */
  async function approve(
    productId: string,
    keys: readonly ParameterKey[],
    values: Partial<Record<ParameterKey, unknown>> = {},
  ) {
    for (const key of keys) {
      const p = await s.prisma.pubParameter.findFirst({
        where: { productId, key },
      });
      const value = (values[key] ?? approvableValue(key, p!.value)) as object;
      await s.prisma.$transaction(async (tx) => {
        await tx.pubParameterDecision.create({
          data: {
            accountId: acc.accountId,
            productId,
            parameterKey: key,
            version: p!.version + 1,
            fromStatus: p!.status,
            toStatus: 'approved',
            valueSnapshot: value,
            decidedBy: `member:${acc.owner.memberId}`,
            basis: 'Тестове затвердження',
            dependentStages: [],
            createdBy: `member:${acc.owner.memberId}`,
          },
        });
        await tx.pubParameter.update({
          where: { id: p!.id },
          data: {
            value,
            status: 'approved',
            version: p!.version + 1,
            approvedAt: now,
            approvedBy: `member:${acc.owner.memberId}`,
          },
        });
      });
    }
  }

  const gate = (productId: string, g: GateName, ctx = {}) =>
    s.db
      .forAccount(acc.accountId)
      .$transaction((tx) => evaluateGate(tx, productId, g, now, ctx));

  it('kind=test: public_publish — только параметры (без live и хоста); все утверждены — открыт', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const r = await gate(p.id, 'public_publish');
    expect(r.open).toBe(false);
    expect(r.missing.map((m) => m.kind)).toEqual(
      GATE_PARAMETER_KEYS.public_publish.map(() => 'parameter'),
    );
    await approve(p.id, GATE_PARAMETER_KEYS.public_publish, {
      offer_active_version: { offerVersionId: 'ov', version: 1 },
    });
    expect(await gate(p.id, 'public_publish')).toEqual({
      gate: 'public_publish',
      open: true,
      missing: [],
    });
  });

  it('Р-PUB-Z2-26: утверждённая (в обход решения) заглушка уведомления о данных не открывает public_publish и флаги', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await approve(p.id, GATE_PARAMETER_KEYS.public_publish, {
      offer_active_version: { offerVersionId: 'ov', version: 1 },
      data_notice_version: DEFAULT_PARAMETER_VALUES.data_notice_version,
    });
    expect(await gate(p.id, 'public_publish')).toEqual({
      gate: 'public_publish',
      open: false,
      missing: [
        {
          kind: 'parameter',
          key: 'data_notice_version',
          detail: 'placeholder',
        },
      ],
    });
    const flags = await s.prisma.$transaction((tx) =>
      refreshGateFlags(tx as never, p.id),
    );
    expect(flags).toEqual({
      paramsPublicPublishOk: false,
      paramsRealLeadsOk: false,
    });
  });

  it('kind=working: хост domain_host — нет / истёк / подтверждён', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'working',
    });
    const host = `g-${randomUUID().slice(0, 8)}.example.com`;
    await approve(p.id, GATE_PARAMETER_KEYS.public_publish, {
      domain_host: { host },
    });
    expect((await gate(p.id, 'public_publish')).missing).toEqual([
      { kind: 'host', key: host, detail: 'not_found' },
    ]);
    const hostId = await seedVerifiedHost(
      s.prisma,
      acc.accountId,
      p.siteId,
      host,
    );
    await s.prisma.siteHost.update({
      where: { id: hostId },
      data: { expiresAt: new Date(now.getTime() - 1000) },
    });
    expect((await gate(p.id, 'public_publish')).missing).toEqual([
      { kind: 'host', key: host, detail: 'not_verified' },
    ]);
    await s.prisma.siteHost.update({
      where: { id: hostId },
      data: { expiresAt: new Date(now.getTime() + 3_600_000) },
    });
    expect((await gate(p.id, 'public_publish')).open).toBe(true);
    // real_leads: ещё пять ключей
    expect(
      (await gate(p.id, 'real_leads')).missing.map((m) => m.key).sort(),
    ).toEqual([
      'alt_contact',
      'contact_sla',
      'form_limit',
      'retention_policy',
      'sales_hours_t42_t72',
    ]);
  });

  it('eval и restored — закрыты все гейты (missing product/kind); архивный — product/status', async () => {
    const ev = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'eval',
    });
    for (const g of [
      'public_publish',
      'real_leads',
      'spend',
      'purchases',
      'ai_use',
      // IA-AB-09 / Р-RD-53: копирование Reddit — только продукт test|working
      // (restored — та же ветка `kind`, что eval).
      'reddit_publish',
    ] as const) {
      expect(await gate(ev.id, g)).toEqual({
        gate: g,
        open: false,
        missing: [{ kind: 'product', key: 'kind', detail: 'eval' }],
      });
    }
    const t = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await s.prisma.pubProduct.update({
      where: { id: t.id },
      data: { status: 'archived' },
    });
    expect((await gate(t.id, 'spend')).missing).toEqual([
      { kind: 'product', key: 'status', detail: 'archived' },
    ]);
  });

  it('spend: лимит не собран → budget/not_built; собран из текущих версий → нет пункта; устарел → stale; сверка tools → reconcile', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await approve(p.id, ['budget_total', 'budget_split']);
    expect((await gate(p.id, 'spend')).missing).toEqual([
      { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
    ]);
    // budget_total v2 + budget_split v2 + per_purchase_max v1 = 5
    await s.prisma.pubBudgetLimit.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        currency: 'UAH',
        paramVersion: 5,
        createdBy: 'system:test',
      },
    });
    expect(await gate(p.id, 'spend')).toEqual({
      gate: 'spend',
      open: true,
      missing: [],
    });
    await approve(p.id, ['per_purchase_max']);
    expect((await gate(p.id, 'spend')).missing).toEqual([
      { kind: 'budget', key: 'pub_budget_limits', detail: 'stale' },
    ]);
    await s.prisma.pubBudgetLimit.update({
      where: { productId: p.id },
      data: { paramVersion: 6 },
    });
    await s.prisma.pubExpense.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        category: 'other',
        description: 'Домен',
        amountTotalMinor: 50_000n,
        currency: 'UAH',
        reconcileRequired: true,
        createdBy: 'system:test',
      },
    });
    expect((await gate(p.id, 'spend')).missing).toEqual([
      { kind: 'reconcile', key: 'tools|other', detail: 'pending_or_unknown:1' },
    ]);
    expect((await gate(p.id, 'spend', { category: 'tools' })).open).toBe(true);
  });

  it('purchases: интеграции измерения (нет / degraded / устарела / connected), live рабочего, наблюдение и решение отчёта для 3+', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await approve(p.id, GATE_PARAMETER_KEYS.purchases, {
      rates_by_role: {
        currency: 'UAH',
        rates: {
          product_owner: 1,
          editor: 1,
          operator: 1,
          analyst: 1,
          sales: 1,
          viewer: null,
          admin: null,
        },
      },
      allowed_cpl_inputs: {
        contributionMinor: 100_000,
        pPayBp: 3000,
        shareBp: 5000,
      },
      own_channels: { channels: [{ code: 'tg', name: 'Канал', url: null }] },
      launch_evidence_purchase: { qaRunId: 'qa-30', note: null },
    });
    await s.prisma.pubBudgetLimit.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        currency: 'UAH',
        paramVersion: 6,
        createdBy: 'system:test',
      },
    });
    expect((await gate(p.id, 'purchases')).missing).toEqual([
      { kind: 'integration', key: 'events_collector', detail: 'missing' },
      { kind: 'integration', key: 'web_analytics', detail: 'missing' },
    ]);
    await s.prisma.pubIntegration.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        kind: 'events_collector',
        status: 'degraded',
        staleAfterHours: 24,
        createdBy: 'system:test',
      },
    });
    await s.prisma.pubIntegration.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        kind: 'web_analytics',
        status: 'connected',
        lastSuccessAt: new Date(now.getTime() - 30 * 3_600_000),
        staleAfterHours: 24,
        createdBy: 'system:test',
      },
    });
    expect((await gate(p.id, 'purchases')).missing).toEqual([
      { kind: 'integration', key: 'events_collector', detail: 'degraded' },
      { kind: 'integration', key: 'web_analytics', detail: 'stale' },
    ]);
    await s.prisma.pubIntegration.updateMany({
      where: { productId: p.id },
      data: {
        status: 'connected',
        lastSuccessAt: new Date(now.getTime() - 3_600_000),
      },
    });
    expect(await gate(p.id, 'purchases')).toEqual({
      gate: 'purchases',
      open: true,
      missing: [],
    });
    expect(
      (
        await gate(p.id, 'purchases', {
          placement: {
            observationOk: false,
            purchaseSeq: 3,
            reportDecisionId: null,
          },
        })
      ).missing,
    ).toEqual([
      { kind: 'observation', key: 'free_observation_7d', detail: 'pending' },
      { kind: 'report_decision', key: 'reportDecisionId', detail: 'required' },
    ]);
    // рабочий продукт не в live — закупка закрыта
    const w = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'working',
    });
    expect((await gate(w.id, 'purchases')).missing).toContainEqual({
      kind: 'product',
      key: 'mode',
      detail: 'closed',
    });
  });

  it('per_purchase_max = 0: purchases закрыт purchases_disabled (reason и текст), spend открыт', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await approve(p.id, GATE_PARAMETER_KEYS.purchases, {
      per_purchase_max: { amountMinor: 0 },
      rates_by_role: {
        currency: 'UAH',
        rates: {
          product_owner: 1,
          editor: 1,
          operator: 1,
          analyst: 1,
          sales: 1,
          viewer: null,
          admin: null,
        },
      },
      allowed_cpl_inputs: {
        contributionMinor: 100_000,
        pPayBp: 3000,
        shareBp: 5000,
      },
      own_channels: { channels: [{ code: 'tg', name: 'Канал', url: null }] },
      launch_evidence_purchase: { qaRunId: 'qa-30', note: null },
    });
    await s.prisma.pubBudgetLimit.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        currency: 'UAH',
        perPurchaseMaxMinor: 0n,
        paramVersion: 6,
        createdBy: 'system:test',
      },
    });
    for (const kind of ['events_collector', 'web_analytics'] as const)
      await s.prisma.pubIntegration.create({
        data: {
          accountId: acc.accountId,
          productId: p.id,
          kind,
          status: 'connected',
          lastSuccessAt: new Date(now.getTime() - 3_600_000),
          staleAfterHours: 24,
          createdBy: 'system:test',
        },
      });
    const disabled = {
      kind: 'budget',
      key: 'per_purchase_max',
      detail: 'purchases_disabled',
    };
    expect(await gate(p.id, 'purchases')).toEqual({
      gate: 'purchases',
      open: false,
      missing: [disabled],
    });
    // инструменты и месяц AI (продукт «только AI») — не задеты
    expect(await gate(p.id, 'spend')).toEqual({
      gate: 'spend',
      open: true,
      missing: [],
    });
    const err = await s.db
      .forAccount(acc.accountId)
      .$transaction((tx) =>
        s.mod.get(GateService).assertOpen(tx, p, 'purchases', now),
      )
      .then(
        () => null,
        (e: PubError) => e,
      );
    expect(err?.code).toBe('PUB_GATE_CLOSED');
    expect(err?.details).toEqual({
      gate: 'purchases',
      missing: [disabled],
      reason: 'purchases_disabled',
    });
    expect(err?.messageIn('ru')).toBe(
      'Закупки отключены: максимум одной закупки — 0',
    );
    // прочие закрытия purchases — без reason, текст кода
    const q = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const other = await s.db
      .forAccount(acc.accountId)
      .$transaction((tx) =>
        s.mod.get(GateService).assertOpen(tx, q, 'purchases', now),
      )
      .then(
        () => null,
        (e: PubError) => e,
      );
    expect(other?.details.reason).toBeUndefined();
    expect(other?.messageIn('ru')).toBe(PUB_ERROR_MESSAGES.PUB_GATE_CLOSED.ru);
  });

  it('ai_use: нет привязки; привязка к конфигурации не passed; passed — сверка генератора, модели, инструкции, цены', async () => {
    const work = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'working',
    });
    const ev = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'eval',
    });
    expect((await gate(work.id, 'ai_use')).missing).toContainEqual({
      kind: 'ai_config',
      key: 'binding',
      detail: 'none',
    });
    const cfg = await s.prisma.pubAiConfig.create({
      data: {
        accountId: acc.accountId,
        productId: ev.id,
        provider: 'gemini',
        model: 'gemini-x',
        contextRulesVersion: 'ctx@1',
        schemaSetVersion: '1',
        instructionVersions: Object.fromEntries(
          P0_ENABLED_GENERATORS.map((g) => [g, `${g}@1`]),
        ),
        configHash: sha256Hex(randomUUID()),
        coveredGenerators: [...P0_ENABLED_GENERATORS],
        createdBy: 'system:test',
      },
    });
    await s.prisma.pubAiConfigBinding.create({
      data: {
        accountId: acc.accountId,
        productId: work.id,
        configId: cfg.id,
        boundBy: `member:${acc.owner.memberId}`,
        basis: 'Застосувати конфігурацію',
        createdBy: `member:${acc.owner.memberId}`,
      },
    });
    expect((await gate(work.id, 'ai_use')).missing).toContainEqual({
      kind: 'ai_config',
      key: 'eval',
      detail: 'not_run',
    });
    // «passed» требует 30 оценённых задач (триггер) — для проверки гейта
    // ставим статус в обход триггеров (session_replication_role, стенд).
    await s.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_ai_configs" SET "evalStatus" = 'passed' WHERE "id" = $1`,
        cfg.id,
      );
    });
    await approve(work.id, ['ai_budget_usd_month', 'ai_fx_rate'], {
      ai_fx_rate: {
        rate: '41.5',
        source: 'НБУ',
        at: '2026-10-12T10:00:00+03:00',
      },
    });
    const ok = {
      generator: 'pub.brief.draft',
      model: 'gemini-x',
      instructionVersion: 'pub.brief.draft@1',
      priced: true,
    };
    expect(await gate(work.id, 'ai_use', { ai: ok })).toEqual({
      gate: 'ai_use',
      open: true,
      missing: [],
    });
    expect(
      (
        await gate(work.id, 'ai_use', {
          ai: {
            ...ok,
            generator: 'pub.draft.write',
            instructionVersion: 'pub.draft.write@1',
          },
        })
      ).missing,
    ).toEqual([
      {
        kind: 'ai_config',
        key: 'pub.draft.write',
        detail: 'not_covered_by_eval_set',
      },
      { kind: 'ai_config', key: 'pub.draft.write', detail: 'not_in_config' },
      { kind: 'ai_config', key: 'instruction', detail: 'mismatch' },
    ]);
    expect(
      (await gate(work.id, 'ai_use', { ai: { ...ok, model: 'other' } }))
        .missing,
    ).toEqual([{ kind: 'ai_config', key: 'model', detail: 'mismatch' }]);
    expect(
      (await gate(work.id, 'ai_use', { ai: { ...ok, priced: false } })).missing,
    ).toEqual([
      {
        kind: 'parameter',
        key: 'ai_unpriced_allowed',
        detail: 'unpriced_model',
      },
    ]);
  });

  it('refreshGateFlags ≡ параметрической части evaluateGate; предложение параметра флаги не трогает', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const db = s.db.forAccount(acc.accountId);
    const check = async () => {
      const flags = await db.$transaction((tx) => refreshGateFlags(tx, p.id));
      const pp = await gate(p.id, 'public_publish');
      const rl = await gate(p.id, 'real_leads');
      expect(flags).toEqual({
        paramsPublicPublishOk: pp.open,
        paramsRealLeadsOk: rl.open,
      });
      const row = await s.prisma.pubProduct.findFirst({ where: { id: p.id } });
      expect(row).toMatchObject(flags);
      return flags;
    };
    expect(await check()).toEqual({
      paramsPublicPublishOk: false,
      paramsRealLeadsOk: false,
    });
    await approve(p.id, GATE_PARAMETER_KEYS.public_publish, {
      offer_active_version: { offerVersionId: 'o', version: 1 },
    });
    expect(await check()).toEqual({
      paramsPublicPublishOk: true,
      paramsRealLeadsOk: false,
    });
    await approve(
      p.id,
      GATE_PARAMETER_KEYS.real_leads.filter(
        (k) => !GATE_PARAMETER_KEYS.public_publish.includes(k),
      ),
      {
        alt_contact: { label: 'Пишіть', href: 'mailto:hello@ai-publisher.org' },
        sales_hours_t42_t72: { minutes: 600 },
      },
    );
    expect(await check()).toEqual({
      paramsPublicPublishOk: true,
      paramsRealLeadsOk: true,
    });
    const rev = (await s.prisma.pubProduct.findFirst({ where: { id: p.id } }))!
      .revision;
    await s.prisma.pubParameterProposal.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        parameterKey: 'form_limit',
        value: { count: 2, windowSec: 600 },
        proposedBy: `member:${acc.owner.memberId}`,
        createdBy: `member:${acc.owner.memberId}`,
      },
    });
    expect(await check()).toEqual({
      paramsPublicPublishOk: true,
      paramsRealLeadsOk: true,
    });
    // производные флаги не двигают ревизию продукта (Р-PUB-A1-6)
    expect(
      (await s.prisma.pubProduct.findFirst({ where: { id: p.id } }))!.revision,
    ).toBe(rev);
    expect(PARAMETER_KEYS.length).toBe(
      Object.keys(DEFAULT_PARAMETER_VALUES).length,
    );
  });
  // ── Аудит P1-1: сериализация операций над параметрами и режимом ─────────

  const PO: Actor[] = ['product_owner'];
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('P1-1: два параллельных решения (language → approved, market → revoked) — флаг ≡ evaluateGate', async () => {
    const params = s.mod.get(ParametersService);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await approve(
      p.id,
      GATE_PARAMETER_KEYS.public_publish.filter((k) => k !== 'language'),
      { offer_active_version: { offerVersionId: 'ov', version: 1 } },
    );
    const tenant = s.db.forAccount(acc.accountId);
    await tenant.$transaction((tx) => refreshGateFlags(tx, p.id));
    const member = `member:${acc.owner.memberId}`;
    const decided = deferred();
    const release = deferred();
    // T1 утверждает последний ключ и «засыпает» до фиксации.
    const t1 = tenant.$transaction(async (tx) => {
      await params.decide(tx, p, {
        key: 'language',
        toStatus: 'approved',
        basis: 'Мова: українська',
        decidedBy: member,
        actors: PO,
      });
      decided.resolve();
      await release.promise;
    }, OPERATION_TX_OPTIONS);
    await decided.promise;
    // T2 отзывает другой ключ, пока T1 не зафиксирована.
    let t2Done = false;
    const t2 = tenant
      .$transaction(
        (tx) =>
          params.decide(tx, p, {
            key: 'market',
            toStatus: 'revoked',
            basis: 'Ринок переглядаємо',
            decidedBy: member,
            actors: PO,
          }),
        OPERATION_TX_OPTIONS,
      )
      .then(() => {
        t2Done = true;
      });
    await sleep(400);
    expect(t2Done).toBe(false); // ждёт блокировку строки продукта
    release.resolve();
    await Promise.all([t1, t2]);
    const row = await s.prisma.pubProduct.findUniqueOrThrow({
      where: { id: p.id },
    });
    const g = await gate(p.id, 'public_publish');
    expect(g.missing).toEqual([
      { kind: 'parameter', key: 'market', detail: 'revoked' },
    ]);
    expect(row.paramsPublicPublishOk).toBe(g.open);
    expect(row.paramsPublicPublishOk).toBe(false);
  });

  it('P1-1: отзыв параметра держит блокировку — параллельный changeMode → live получает PUB_GATE_CLOSED', async () => {
    const params = s.mod.get(ParametersService);
    const products = s.mod.get(ProductService);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'working',
      mode: 'test',
    });
    const host = `race-${randomUUID().slice(0, 8)}.example.com`;
    await seedVerifiedHost(s.prisma, acc.accountId, p.siteId, host);
    await approve(p.id, GATE_PARAMETER_KEYS.public_publish, {
      domain_host: { host },
      offer_active_version: { offerVersionId: 'ov', version: 1 },
    });
    const tenant = s.db.forAccount(acc.accountId);
    await tenant.$transaction((tx) => refreshGateFlags(tx, p.id));
    expect((await gate(p.id, 'public_publish')).open).toBe(true);
    const { revision } = await s.prisma.pubProduct.findUniqueOrThrow({
      where: { id: p.id },
    });
    const member = `member:${acc.owner.memberId}`;
    const decided = deferred();
    const release = deferred();
    const t1 = tenant.$transaction(async (tx) => {
      await params.decide(tx, p, {
        key: 'market',
        toStatus: 'revoked',
        basis: 'Ринок переглядаємо',
        decidedBy: member,
        actors: PO,
      });
      decided.resolve();
      await release.promise;
    }, OPERATION_TX_OPTIONS);
    await decided.promise;
    const t2 = tenant
      .$transaction(
        (tx) =>
          products.changeMode(
            tx,
            p,
            { mode: 'live', expectedRevision: revision },
            member,
            new Date(),
          ),
        OPERATION_TX_OPTIONS,
      )
      .then(
        () => 'live',
        (e: { code?: string }) => e.code ?? String(e),
      );
    await sleep(400);
    release.resolve();
    await t1;
    expect(await t2).toBe('PUB_GATE_CLOSED');
    const row = await s.prisma.pubProduct.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect([row.mode, row.paramsPublicPublishOk]).toEqual(['test', false]);
  });

  it('P1-1: GatePort.assertOpen ждёт параллельного отзыва — гейт, открытый в операции, не закрыт до её фиксации', async () => {
    const params = s.mod.get(ParametersService);
    const gates = s.mod.get(GateService);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    await approve(p.id, GATE_PARAMETER_KEYS.public_publish, {
      offer_active_version: { offerVersionId: 'ov', version: 1 },
    });
    const tenant = s.db.forAccount(acc.accountId);
    const member = `member:${acc.owner.memberId}`;
    const decided = deferred();
    const release = deferred();
    const t1 = tenant.$transaction(async (tx) => {
      await params.decide(tx, p, {
        key: 'niche',
        toStatus: 'revoked',
        basis: 'Нішу переглядаємо',
        decidedBy: member,
        actors: PO,
      });
      decided.resolve();
      await release.promise;
    }, OPERATION_TX_OPTIONS);
    await decided.promise;
    const t2 = tenant
      .$transaction(
        (tx) => gates.assertOpen(tx, p, 'public_publish', new Date()),
        OPERATION_TX_OPTIONS,
      )
      .then(
        () => 'open',
        (e: { code?: string }) => e.code ?? String(e),
      );
    await sleep(400);
    release.resolve();
    await t1;
    expect(await t2).toBe('PUB_GATE_CLOSED');
  });

  // ── Аудит P2-1/P3-7: согласованность бюджета — пункт гейта, не решение ──

  it('P2-1: бюджет 10 000 → 12 000 двумя решениями; между ними spend — budget/inconsistent', async () => {
    const params = s.mod.get(ParametersService);
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const tenant = s.db.forAccount(acc.accountId);
    const member = `member:${acc.owner.memberId}`;
    const decide = (key: ParameterKey, value: unknown) =>
      tenant.$transaction(
        (tx) =>
          params.decide(tx, p, {
            key,
            toStatus: 'approved',
            value,
            basis: 'Бюджет пілоту змінено',
            decidedBy: member,
            actors: PO,
          }),
        OPERATION_TX_OPTIONS,
      );
    const inconsistent = async (g: GateName) =>
      (await gate(p.id, g)).missing.filter((m) => m.detail === 'inconsistent');
    expect(await inconsistent('spend')).toEqual([]);
    await decide('budget_total', { amountMinor: 1_200_000, currency: 'UAH' });
    expect(await inconsistent('spend')).toEqual([
      { kind: 'budget', key: 'budget_split', detail: 'inconsistent' },
    ]);
    await decide('budget_split', {
      placementsMinor: 800_000,
      toolsMinor: 200_000,
      reserveMinor: 200_000,
    });
    expect(await inconsistent('spend')).toEqual([]);
    expect(s.fakes.budgetLimit.calls.filter((id) => id === p.id)).toHaveLength(
      2,
    );
    // P3-7: валюта ставок ≠ валюте бюджета — пункт закупок (не spend).
    await decide('rates_by_role', {
      currency: 'USD',
      rates: {
        product_owner: 50_000,
        editor: 40_000,
        operator: 30_000,
        analyst: 40_000,
        sales: 30_000,
        viewer: null,
        admin: null,
      },
    });
    expect(await inconsistent('purchases')).toEqual([
      { kind: 'budget', key: 'rates_by_role', detail: 'inconsistent' },
    ]);
    expect(await inconsistent('spend')).toEqual([]);
  });
});
