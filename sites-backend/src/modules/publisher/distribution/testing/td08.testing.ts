/**
 * AI Publisher, P-C — построители тестовых данных TD-08 (план внешнего
 * аудита; проектный документ §16.5): продукт `kind=test` с утверждёнными
 * параметрами закупок, собранной строкой лимита, подключённым измерением,
 * каналом `site`, согласованным материалом (опубликован в тестовой стадии
 * ≥ 7 дней назад), экспериментом `pilot` с этим материалом и проверенной
 * площадкой с доказательством; закупки и денежные состояния по сценарию.
 *
 * Пишет сырым клиентом владельца схемы (тест; `testing/` вне сканера
 * владения таблиц): чужие таблицы (контент P-B1, эксперимент P-E,
 * интеграции P-E, параметры P-A1) — только сид. id — случайные.
 *
 * `DbContentPort` — тестовый двойник `ContentPort` P-B1: читает hash
 * версии и активное согласование `publish_version` из базы (а не одно
 * значение на все версии, как `FakeContentPort`), записывает вызовы
 * `markPublished/markWithdrawn`.
 */
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { request as httpRequest } from 'http';
import * as supertest from 'supertest';
import type { Provider } from '@nestjs/common';
import type { PrismaService } from '../../../../prisma/prisma.service';
import type { ProductKind, ProductMode } from '../../contracts/states';
import { DEFAULT_PARAMETER_VALUES } from '../../contracts/parameters';
import { addKyivCalendarDays } from '../../core/kyiv-time';
import {
  AI_GATEWAY,
  CONTENT_PORT,
  LEAD_ENRICH_PORT,
  PILOT_CLOCK_PORT,
  RATE_LIMIT_RESET_PORT,
  type ContentPort,
  type ProductRef,
  type PubTx,
} from '../../core/ports';
import {
  FakeAiGateway,
  FakeContentsReassign,
  FakeLeadEnrichPort,
  FakeLeadsReassign,
  FakePilotClockPort,
  FakePilotExperimentInit,
  FakeRateLimitResetPort,
} from '../../core/testing/fake-ports';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../core/testing/core-stack.testing';
import {
  seedAccount,
  seedMembers,
  seedProduct,
  type SeededAccount,
  type SeededMembers,
  type SeededProduct,
} from '../../testing/fixtures.testing';
import { priceSnapshotHash } from '../approvals-purchase.service';
import { budgetFn } from '../budget-fn';
import { BudgetService } from '../budget.service';
import { PublisherDistributionModule } from '../distribution.module';
import { approvableValue, testSlug } from '../../testing/fixtures.testing';

export const hex64 = (): string => randomBytes(32).toString('hex');
export const opKey = (): string => randomUUID();
export const UAH = (v: number): string => String(Math.round(v * 100));

/** Двойник ContentPort P-B1 по данным базы. */
export class DbContentPort implements ContentPort {
  published: Array<{
    versionId: string;
    publicationId: string;
    stage: string;
  }> = [];
  withdrawn: string[] = [];
  /** Переопределения по версии (criticalStale, offerActive, openChangeTasks). */
  overrides = new Map<
    string,
    Partial<{
      criticalStale: boolean;
      offerActive: boolean;
      openChangeTasks: number;
      firstLivePublishedAt: Date | null;
    }>
  >();

  async publishableVersion(tx: PubTx, product: ProductRef, versionId: string) {
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      select: { id: true, contentId: true, hash: true },
    });
    if (!v) throw new Error(`DbContentPort: версии ${versionId} нет`);
    const c = await tx.pubContent.findFirst({
      where: { id: v.contentId },
      select: { criticalStale: true, firstPublishedAt: true },
    });
    const a = await tx.pubApproval.findFirst({
      where: {
        productId: product.id,
        type: 'publish_version',
        objectId: versionId,
        status: 'active',
      },
      select: { id: true, versionHash: true },
    });
    const o = this.overrides.get(versionId) ?? {};
    return {
      contentId: v.contentId,
      hash: v.hash ?? '',
      approvalId: a?.id ?? '',
      approvalActive: !!a && a.versionHash === v.hash,
      criticalStale: o.criticalStale ?? c?.criticalStale ?? false,
      firstLivePublishedAt:
        o.firstLivePublishedAt !== undefined
          ? o.firstLivePublishedAt
          : (c?.firstPublishedAt ?? null),
      offerActive: o.offerActive ?? true,
      openChangeTasks: o.openChangeTasks ?? 0,
    };
  }

  async markPublished(
    _tx: PubTx,
    _p: ProductRef,
    versionId: string,
    publicationId: string,
    stage: 'test' | 'live',
  ): Promise<void> {
    this.published.push({ versionId, publicationId, stage });
  }

  async markWithdrawn(
    _tx: PubTx,
    _p: ProductRef,
    versionId: string,
  ): Promise<void> {
    this.withdrawn.push(versionId);
  }
}

export interface DistStack extends CoreStack {
  content: DbContentPort;
  pilotClock: FakePilotClockPort;
  budget: BudgetService;
}

/**
 * Стенд P-C: ядро + модуль распространения (настоящие порты бюджета и
 * вклады P-C) + двойники соседей (контент — по базе, часы пилота, AI,
 * заявки, вклады P-B1/P-D/P-E).
 */
export async function distStack(
  opts: { http?: boolean; providers?: Provider[] } = {},
): Promise<DistStack> {
  const content = new DbContentPort();
  const pilotClock = new FakePilotClockPort();
  const s = await coreStack({
    http: opts.http ?? true,
    fakes: false,
    imports: [PublisherDistributionModule],
    providers: [
      { provide: CONTENT_PORT, useValue: content },
      { provide: PILOT_CLOCK_PORT, useValue: pilotClock },
      { provide: AI_GATEWAY, useValue: new FakeAiGateway() },
      { provide: LEAD_ENRICH_PORT, useValue: new FakeLeadEnrichPort() },
      {
        provide: RATE_LIMIT_RESET_PORT,
        useValue: new FakeRateLimitResetPort(),
      },
      FakePilotExperimentInit,
      FakeLeadsReassign,
      FakeContentsReassign,
      ...(opts.providers ?? []),
    ],
  });
  return { ...s, content, pilotClock, budget: s.mod.get(BudgetService) };
}

/** Утвердить параметр (решение той же версии, затем голова — контракт P-A0). */
export async function approveParam(
  db: PrismaService,
  p: ProductRef,
  key: string,
  value?: unknown,
  decidedBy = 'member:td08-owner',
): Promise<void> {
  const cur = await db.pubParameter.findFirst({
    where: { productId: p.id, key },
    select: { version: true, status: true, value: true },
  });
  if (!cur) throw new Error(`param ${key} нет`);
  // Р-PUB-Z2-26: заглушка уведомления о данных гейт не открывает.
  const v = (value ?? approvableValue(key, cur.value)) as Prisma.InputJsonValue;
  const version = cur.version + 1;
  await db.pubParameterDecision.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      parameterKey: key,
      version,
      fromStatus: cur.status,
      toStatus: 'approved',
      valueSnapshot: v,
      decidedBy,
      basis: 'Рішення власника продукту (TD-08)',
      dependentStages: [],
      createdBy: decidedBy,
    },
  });
  await db.pubParameter.updateMany({
    where: { productId: p.id, key },
    data: {
      value: v,
      status: 'approved',
      version,
      approvedAt: new Date(),
      approvedBy: decidedBy,
      revision: { increment: 1 },
    },
  });
}

export const PURCHASE_KEYS = [
  'budget_total',
  'budget_split',
  'per_purchase_max',
  'rates_by_role',
  'allowed_cpl_inputs',
  'cac_payment_window',
  'd42_thresholds',
  'own_channels',
  'attribution_tool',
  'launch_evidence_purchase',
] as const;

export interface BudgetSetup {
  total: number;
  placements: number;
  tools: number;
  reserve: number;
  perPurchase: number;
}
export const TZ17_BUDGET: BudgetSetup = {
  total: 10_000,
  placements: 6_000,
  tools: 2_000,
  reserve: 2_000,
  perPurchase: 2_000,
};

export interface Td08 {
  acc: SeededAccount;
  product: SeededProduct;
  team: SeededMembers;
  ref: ProductRef;
  siteChannelId: string;
  articleId: string;
  versionId: string;
  versionHash: string;
  slug: string;
  experimentId: string;
  venueId: string;
  sourceId: string;
}

/** Сид контента: статья, замороженная версия, согласование publish_version. */
export async function seedArticle(
  db: PrismaService,
  p: ProductRef,
  actor = 'member:td08-editor',
): Promise<{
  articleId: string;
  versionId: string;
  versionHash: string;
  slug: string;
}> {
  const q = await db.pubQuestion.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      text: 'Як обрати підрядника?',
      stage: 'decision',
      scores: {},
      createdBy: actor,
    },
  });
  let offer = await db.pubOfferVersion.findFirst({
    where: { productId: p.id, status: 'active' },
  });
  if (!offer) {
    offer = await db.pubOfferVersion.create({
      data: {
        accountId: p.accountId,
        productId: p.id,
        version: 1,
        title: 'Оффер',
        text: 'Текст оффера',
        priceNote: 'Отримати пропозицію',
        status: 'active',
        approvedBy: actor,
        approvedAt: new Date(),
        hash: hex64(),
        createdBy: actor,
      },
    });
  }
  const brief = await db.pubBrief.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      questionId: q.id,
      offerVersionId: offer.id,
      goal: 'Ціль',
      format: 'instruction',
      structure: [],
      channels: [],
      readinessCriteria: [],
      unresolved: [],
      createdBy: actor,
    },
  });
  const slug = testSlug('m');
  const content = await db.pubContent.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      kind: 'article',
      briefId: brief.id,
      slug,
      createdBy: actor,
    },
  });
  const versionHash = hex64();
  const version = await db.pubContentVersion.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      contentId: content.id,
      number: 1,
      title: 'Заголовок',
      body: 'Текст',
      meta: { description: 'Опис' },
      format: 'article',
      offerVersionId: offer.id,
      authorMemberId: 'td08-editor',
      status: 'submitted',
      hash: versionHash,
      frozenAt: new Date(),
      createdBy: actor,
    },
  });
  await db.pubApproval.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      type: 'publish_version',
      objectType: 'content_version',
      objectId: version.id,
      versionHash,
      approverMemberId: 'td08-owner',
      approverDisplayName: 'Власник',
      createdBy: actor,
    },
  });
  return { articleId: content.id, versionId: version.id, versionHash, slug };
}

/** Публикация тестовой стадии в прошлом (начало наблюдения продукта `kind=test`). */
export async function seedTestPublication(
  db: PrismaService,
  p: ProductRef,
  a: { versionId: string; channelId: string; slug: string; daysAgo: number },
): Promise<string> {
  const appr = await db.pubApproval.findFirst({
    where: {
      productId: p.id,
      objectId: a.versionId,
      type: 'publish_version',
      status: 'active',
    },
    select: { id: true },
  });
  const at = addKyivCalendarDays(new Date(), -a.daysAgo);
  const row = await db.pubPublication.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      versionId: a.versionId,
      channelId: a.channelId,
      approvalId: appr!.id,
      stage: 'test',
      finalUrl: `https://ai-publisher.org/materials/${a.slug}`,
      publishedAt: at,
      status: 'published',
      opKey: opKey(),
      createdBy: 'member:td08-operator',
    },
  });
  return row.id;
}

export async function seedTd08(
  db: PrismaService,
  budget: BudgetService,
  opts: {
    kind?: ProductKind;
    mode?: ProductMode;
    budget?: BudgetSetup;
    approve?: boolean;
    integrations?: 'connected' | 'degraded' | 'none';
    observationDays?: number;
  } = {},
): Promise<Td08> {
  const acc = await seedAccount(db);
  const product = await seedProduct(db, {
    accountId: acc.accountId,
    siteId: acc.siteId,
    kind: opts.kind ?? 'test',
    mode: opts.mode,
  });
  const ref = { id: product.id, accountId: product.accountId };
  const team = await seedMembers(db, ref, acc.owner);
  const b = opts.budget ?? TZ17_BUDGET;
  if (opts.approve !== false) {
    for (const key of PURCHASE_KEYS) {
      let value: unknown = (
        DEFAULT_PARAMETER_VALUES as Record<string, unknown>
      )[key];
      if (key === 'budget_total')
        value = { amountMinor: b.total * 100, currency: 'UAH' };
      if (key === 'budget_split') {
        value = {
          placementsMinor: b.placements * 100,
          toolsMinor: b.tools * 100,
          reserveMinor: b.reserve * 100,
        };
      }
      if (key === 'per_purchase_max')
        value = { amountMinor: b.perPurchase * 100 };
      await approveParam(db, ref, key, value, `member:${acc.owner.memberId}`);
    }
  }
  await db.$transaction(async (tx) => {
    await budget.build(tx as unknown as PubTx, ref, 'system:td08');
  });
  if ((opts.integrations ?? 'connected') !== 'none') {
    for (const kind of ['events_collector', 'web_analytics']) {
      await db.pubIntegration.create({
        data: {
          accountId: ref.accountId,
          productId: ref.id,
          kind,
          status: opts.integrations === 'degraded' ? 'degraded' : 'connected',
          manual: true,
          lastSuccessAt: new Date(),
          staleAfterHours: 48,
          createdBy: 'system:td08',
        },
      });
    }
  }
  const site = await db.pubChannel.create({
    data: {
      accountId: ref.accountId,
      productId: ref.id,
      code: 'site',
      name: 'Сайт',
      kind: 'site',
      utmSource: 'site',
      utmMedium: 'owned',
      createdBy: 'system:td08',
    },
  });
  const art = await seedArticle(db, ref);
  await seedTestPublication(db, ref, {
    versionId: art.versionId,
    channelId: site.id,
    slug: art.slug,
    daysAgo: opts.observationDays ?? 10,
  });
  const exp = await db.pubExperiment.create({
    data: {
      accountId: ref.accountId,
      productId: ref.id,
      key: `pilot-${randomBytes(3).toString('hex')}`,
      version: 1,
      kind: 'pilot',
      hypothesis: 'Гіпотеза',
      change: 'Зміна',
      metric: 'Метрика',
      expectedSignal: 'Сигнал',
      stopConditions: 'Стоп',
      windowStart: new Date('2026-10-20T07:00:00Z'),
      windowEnd: new Date('2027-01-18T07:00:00Z'),
      thresholds: { d42: { minSampleForConclusion: 5 } },
      createdBy: 'system:td08',
    },
  });
  await db.pubExperimentContent.create({
    data: {
      accountId: ref.accountId,
      productId: ref.id,
      experimentId: exp.id,
      contentId: art.articleId,
      createdBy: 'system:td08',
    },
  });
  const source = await db.pubSource.create({
    data: {
      accountId: ref.accountId,
      productId: ref.id,
      kind: 'manual_text',
      fragment: 'Умови розміщення від майданчика',
      usage: 'allowed',
      visibility: 'private',
      title: 'Прайс майданчика',
      url: 'https://venue.example/price',
      contentHash: hex64(),
      createdBy: 'system:td08',
    },
  });
  const venue = await db.pubVenue.create({
    data: {
      accountId: ref.accountId,
      productId: ref.id,
      name: 'Майданчик',
      url: 'https://venue.example',
      formats: ['article'],
      criteria: {
        topic: { score: 2, why: 'Тематика збігається' },
        geo_language: { score: 2, why: 'Україна, українська' },
        format: { score: 1, why: 'Стаття з поміткою' },
        evidence_freshness: { score: null, why: 'Немає свіжих даних' },
        real_distribution: { score: 1, why: 'Є розсилка' },
      },
      completeness: 4,
      checkTopicMarket: true,
      checkPriceConfirmed: true,
      checkFormatConfirmed: true,
      checkTermSet: true,
      checkSupplierKnown: true,
      linkMarking: 'sponsored',
      status: 'verified',
      createdBy: 'system:td08',
    },
  });
  await db.pubVenueEvidence.create({
    data: {
      accountId: ref.accountId,
      productId: ref.id,
      venueId: venue.id,
      criterion: 'topic',
      sourceId: source.id,
      checkedAt: new Date(),
      createdBy: 'system:td08',
    },
  });
  return {
    acc,
    product,
    team,
    ref,
    siteChannelId: site.id,
    articleId: art.articleId,
    versionId: art.versionId,
    versionHash: art.versionHash,
    slug: art.slug,
    experimentId: exp.id,
    venueId: venue.id,
    sourceId: source.id,
  };
}

/**
 * Закупка напрямую в статусе `approved` с согласованием (для сценариев,
 * где нужны две закупки одновременно — последовательность закупок кампании
 * сервис иначе не пропустит).
 */
export async function approvedPlacementDirect(
  db: PrismaService,
  w: Td08,
  a: {
    seq: number;
    totalUah: number;
    expiresInHours?: number;
    /** Согласование, истёкшее столько часов назад (решение — за 73 ч до этого). */
    expiredAgoHours?: number;
    /** Своя кампания (одновременные закупки — у каждой своя последовательность). */
    campaignCode?: string;
  },
): Promise<{
  placementId: string;
  approvalId: string;
  revision: number;
  snapshot: string;
}> {
  const campaign = a.campaignCode
    ? await db.pubCampaign.create({
        data: {
          accountId: w.ref.accountId,
          productId: w.ref.id,
          code: a.campaignCode,
          name: `Кампанія ${a.campaignCode}`,
          createdBy: 'system:td08',
        },
      })
    : await db.pubCampaign.findFirst({
        where: { productId: w.ref.id, code: 'pilot' },
      });
  const total = BigInt(Math.round(a.totalUah * 100));
  const fees = total / 10n;
  const code = `pl${a.seq}-${randomBytes(3).toString('hex')}`;
  const row = await db.pubPlacement.create({
    data: {
      accountId: w.ref.accountId,
      productId: w.ref.id,
      venueId: w.venueId,
      versionId: w.versionId,
      campaignId: campaign!.id,
      placementCode: code,
      issuedUrl: `https://ai-publisher.org/materials/${w.slug}?utm_source=venue.example&utm_medium=paid&utm_campaign=${campaign!.code}&utm_content=${code}`,
      purchaseSeq: a.seq,
      basePriceMinor: total - fees,
      feesMinor: fees,
      totalPriceMinor: total,
      currency: 'UAH',
      priceSource: 'Прайс майданчика',
      priceConfirmedAt: new Date(),
      terms: 'Публікація протягом 5 днів',
      observationOk: true,
      createdBy: `member:${w.team.operator.memberId}`,
    },
  });
  const snapshot = priceSnapshotHash(row);
  const decidedAt =
    a.expiredAgoHours !== undefined
      ? new Date(Date.now() - (a.expiredAgoHours + 71) * 3_600_000)
      : new Date();
  const appr = await db.pubApproval.create({
    data: {
      accountId: w.ref.accountId,
      productId: w.ref.id,
      type: 'purchase',
      objectType: 'placement',
      objectId: row.id,
      versionHash: w.versionHash,
      priceSnapshotHash: snapshot,
      maxAmountMinor: total,
      currency: 'UAH',
      approverMemberId: w.team.product_owner.memberId,
      approverDisplayName: 'Власник',
      decidedAt,
      expiresAt:
        a.expiredAgoHours !== undefined
          ? new Date(Date.now() - a.expiredAgoHours * 3_600_000)
          : new Date(
              decidedAt.getTime() + (a.expiresInHours ?? 24) * 3_600_000,
            ),
      createdBy: `member:${w.team.product_owner.memberId}`,
    },
  });
  const upd = await db.pubPlacement.update({
    where: { id: row.id },
    data: {
      approvalId: appr.id,
      status: 'approved',
      revision: { increment: 1 },
    },
  });
  return {
    placementId: row.id,
    approvalId: appr.id,
    revision: upd.revision,
    snapshot,
  };
}

/** Строка счётчиков лимита (для проверок сверки). */
export async function limitCounters(db: PrismaService, productId: string) {
  return db.pubBudgetLimit.findFirst({
    where: { productId },
    select: {
      totalLimitMinor: true,
      netPaidMinor: true,
      openCommitMinor: true,
      usedPlacementsMinor: true,
      usedToolsMinor: true,
      protectedReserveMinor: true,
      placementsLimitMinor: true,
      toolsLimitMinor: true,
    },
  });
}

/** Сырой HTTP-запрос (параллельные вызовы без supertest-агента). */
export function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{
  status: number;
  body: {
    error?: { code: string; details?: Record<string, unknown> };
    data?: unknown;
  };
}> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** HTTP-клиент участника (supertest): мутации получают свежий `opKey`. */
export function apiAs(
  srv: Parameters<typeof supertest>[0],
  accountId: string,
  member: { telegramId: bigint },
) {
  const h = asMember(member.telegramId, accountId);
  return {
    get: (path: string) => supertest(srv).get(path).set(h),
    post: (path: string, body: Record<string, unknown> = {}) =>
      supertest(srv)
        .post(path)
        .set(h)
        .send({ opKey: opKey(), ...body }),
    patch: (path: string, body: Record<string, unknown> = {}) =>
      supertest(srv)
        .patch(path)
        .set(h)
        .send({ opKey: opKey(), ...body }),
    headers: h,
  };
}

/**
 * Состояние вектора ТЗ §17 функциями денег: инструменты 2 000 оплачены
 * (net_paid 2 000), закупка P0 на 1 000 зарезервирована (open 1 000), из
 * них оказано 400. Доступно: 10 000 − 2 000 − 1 000 − 2 000 = 5 000.
 */
export async function seedTz17State(
  db: PrismaService,
  w: Td08,
): Promise<{ toolsExpenseId: string; p0: string; p0ExpenseId: string }> {
  const actor = `member:${w.team.operator.memberId}`;
  const p0 = await approvedPlacementDirect(db, w, {
    seq: 1,
    totalUah: 1_000,
    campaignCode: `p0-${randomBytes(3).toString('hex')}`,
  });
  return db.$transaction(async (raw) => {
    const tx = raw as unknown as PubTx;
    const toolsExpenseId = (await budgetFn.commitTools(tx, w.ref, {
      amount: 200_000n,
      category: 'tools',
      description: 'Хостинг і домен',
      fx: {
        origCurrency: null,
        origAmountMinor: null,
        fxRate: null,
        fxSource: null,
        fxAt: null,
      },
      sourceDocument: null,
      opKey: opKey(),
      actor,
    }))!;
    await budgetFn.pay(tx, w.ref, {
      expenseId: toolsExpenseId,
      amount: 200_000n,
      status: 'confirmed',
      externalRef: 'INV-T',
      opKey: opKey(),
      actor,
    });
    const p0ExpenseId = (await budgetFn.reserve(tx, w.ref, {
      amount: 100_000n,
      approvalId: p0.approvalId,
      priceSnapshotHash: p0.snapshot,
      placementId: p0.placementId,
      revision: p0.revision,
      opKey: opKey(),
      actor,
    }))!;
    await budgetFn.deliver(tx, w.ref, {
      expenseId: p0ExpenseId,
      amount: 40_000n,
      opKey: opKey(),
      actor,
    });
    return { toolsExpenseId, p0: p0.placementId, p0ExpenseId };
  });
}

/** Адаптация (пост) согласованной статьи: замороженная версия + согласование. */
export async function seedAdaptation(
  db: PrismaService,
  p: ProductRef,
  a: {
    articleId: string;
    articleVersionId: string;
    kind?: 'post' | 'cards' | 'checklist' | 'video_script';
  },
): Promise<{ contentId: string; versionId: string; versionHash: string }> {
  const actor = 'member:td08-editor';
  const kind = a.kind ?? 'post';
  const parentV = await db.pubContentVersion.findFirst({
    where: { id: a.articleVersionId },
    select: { offerVersionId: true },
  });
  const content = await db.pubContent.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      kind,
      parentContentId: a.articleId,
      createdBy: actor,
    },
  });
  const versionHash = hex64();
  const version = await db.pubContentVersion.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      contentId: content.id,
      number: 1,
      title: 'Пост до статті',
      body: 'Короткий текст',
      meta: { description: 'Пост' },
      format: kind,
      parentVersionId: a.articleVersionId,
      offerVersionId: parentV!.offerVersionId,
      authorMemberId: 'td08-editor',
      status: 'submitted',
      hash: versionHash,
      frozenAt: new Date(),
      createdBy: actor,
    },
  });
  await db.pubApproval.create({
    data: {
      accountId: p.accountId,
      productId: p.id,
      type: 'publish_version',
      objectType: 'content_version',
      objectId: version.id,
      versionHash,
      approverMemberId: 'td08-owner',
      approverDisplayName: 'Власник',
      createdBy: actor,
    },
  });
  return { contentId: content.id, versionId: version.id, versionHash };
}
