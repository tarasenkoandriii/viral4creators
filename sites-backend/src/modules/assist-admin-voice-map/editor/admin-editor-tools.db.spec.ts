/**
 * Заход 13 (хвост Р-З11-А11) — инструменты панели `wa.` на НАСТОЯЩЕМ
 * Postgres, основной ролью:
 *  - деньги панели — суточный потолок «Админки» (`reserveAdminTurn`): резерв
 *    до вызова, снятие фактом, исчерпанный потолок — отказ, без резерва в
 *    строке «Сайта»;
 *  - «Промахи»/«Пропозиції» из append-only журнала «Админки» (строки
 *    `ui-plan`/`ui-step` с JSON-запросом): планы мастера (`test`, у плана —
 *    `voiceTestId`) и сухие прогоны — не сигнал; «просили, не нашли» — по
 *    маскированному пути страницы и шаблону карты; «не предлагать» — строка
 *    журнала с одним id.
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import { AdminActionLogService } from '../../assist-admin-mode/action-log.service';
import { AdminModeService } from '../../assist-admin-mode/admin-mode.service';
import { setPlan } from '../../assist-billing/testing/billing-fixtures.testing';
import { siteDailyCapFromPlan } from '../../assist-billing/plans';
import {
  describeDb,
  testPrisma as ownerPrisma,
} from '../../site-crawl/testing/crawl-db.testing';
import type { GeminiText } from '../../site-ai/text-model';
import type { AiUsageRecorder } from '../../site-ai/usage-recorder';
import type { HostAccessService } from '../../site-core/ownership/host-access.service';
import { AdminVoiceMapService } from '../admin-voice-map.service';
import { AdminEditorAssistService } from './admin-editor-assist.service';
import { AdminEditorBudget } from './admin-editor-budget';
import type { ResolvedAdminEditor } from './admin-editor-session.service';

jest.setTimeout(120_000);

describeDb('панель `wa.` — потолок «Админки» и «Промахи» из журнала', () => {
  let prisma: PrismaService;
  let db: SitesDb;
  let log: AdminActionLogService;
  let maps: AdminVoiceMapService;
  const accounts: string[] = [];

  beforeAll(() => {
    prisma = ownerPrisma();
    db = new SitesDb(prisma);
    log = new AdminActionLogService(db);
    maps = new AdminVoiceMapService(
      db,
      new AdminModeService(db, prisma, {} as HostAccessService),
      log,
    );
  });
  afterAll(async () => {
    if (accounts.length)
      await prisma.siteAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.$disconnect();
  });

  async function site() {
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `z13a-${randomUUID()}` },
    });
    accounts.push(account.id);
    const member = await prisma.siteAccountMember.create({
      data: {
        accountId: account.id,
        telegramId: BigInt(Math.floor(Math.random() * 1e12) + 1e12),
        role: 'owner',
        productRoles: { assistAdmin: 'owner' },
      },
    });
    const s = await prisma.site.create({
      data: {
        accountId: account.id,
        name: `Адмінка ${randomUUID().slice(0, 6)}`,
      },
    });
    await prisma.assistAdminSettings.create({
      data: { accountId: account.id, siteId: s.id, adminModeEnabled: true },
    });
    await setPlan(prisma, account.id, 'pro');
    const ed: ResolvedAdminEditor = {
      sessionId: 'ed-1',
      accountId: account.id,
      siteId: s.id,
      memberId: member.id,
      hostId: 'h',
      host: 'admin.z13a.example',
      origin: 'https://admin.z13a.example',
      employeeRef: 'jwt:owner-1',
      customerRole: 'director',
    };
    return ed;
  }

  const dayRow = async (siteId: string) =>
    (
      await prisma.$queryRawUnsafe<Array<{ r: bigint; s: bigint }>>(
        `SELECT "reservedMicroUsd" AS r, "spentMicroUsd" AS s FROM "sites"."assist_budget_days" WHERE "scope" = 'admin' AND "key" = $1`,
        siteId,
      )
    )[0];

  it('потолок «Админки»: резерв до вызова и снятие фактом; исчерпан фактом дня — отказ; сбой без факта — оценка в расход', async () => {
    const ed = await site();
    const budget = new AdminEditorBudget(prisma);
    budget.env = {};
    const r = await budget.reserve(ed.accountId, ed.siteId, 5_000);
    expect(r).not.toBeNull();
    expect(Number((await dayRow(ed.siteId)).r)).toBe(5_000);
    await budget.settle(r!, 1_200);
    expect(Number((await dayRow(ed.siteId)).r)).toBe(0);
    // Сбой после вызова без факта — оценка остаётся расходом строки «Админки».
    const r2 = await budget.reserve(ed.accountId, ed.siteId, 3_000);
    await budget.settle(r2!, null);
    expect(Number((await dayRow(ed.siteId)).s)).toBe(3_000);
    // Факт дня «Админки» (любая её операция) съел потолок — отказ.
    await prisma.siteAiUsage.create({
      data: {
        accountId: ed.accountId,
        siteId: ed.siteId,
        product: 'assist',
        provider: 'GEMINI',
        operation: 'assist-admin-map-synonyms',
        model: 'gemini-3.6-flash',
        calls: 1,
        costMicroUsd: siteDailyCapFromPlan('pro'),
        pricingVersion: 'test',
      },
    });
    expect(await budget.reserve(ed.accountId, ed.siteId, 1)).toBeNull();
    // Строк бюджета «Сайта» (виджет/обучение) панель «Админки» не трогала.
    const others = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "sites"."assist_budget_days" WHERE "key" = $1 AND "scope" <> 'admin'`,
      ed.siteId,
    );
    expect(Number(others[0].n)).toBe(0);
  });

  it('«Промахи» из журнала: мастер и сухой прогон — не сигнал; путь — маской; шаблон карты; «не предлагать» — только id', async () => {
    const ed = await site();
    const svc = new AdminEditorAssistService(
      db,
      maps,
      {
        rateHit: async () => true,
      } as unknown as AdminSessionService,
      {} as GeminiText,
      {} as AiUsageRecorder,
      {} as AdminEditorBudget,
    );
    // Шаблон «Замовлення» и цель на нём.
    const row = await maps.loadMap(
      db.forAccount(ed.accountId),
      ed.accountId,
      ed.siteId,
    );
    await maps.patch(
      {
        accountId: ed.accountId,
        memberId: ed.memberId,
        actor: 'tg:1',
        actorRole: 'owner',
        channel: 'tma',
      },
      ed.siteId,
      {
        expectedRevision: row.draftRevision,
        ops: [
          {
            op: 'upsert-template',
            template: {
              name: 'Замовлення',
              pathPattern: '/admin/orders/*',
              samplePages: ['/admin/orders/1'],
            },
          },
        ],
      },
      'tma',
    );
    const plan = async (
      id: string,
      actor: string,
      extra: Record<string, unknown> = {},
    ) =>
      prisma.assistAdminUiPlan.create({
        data: {
          id,
          accountId: ed.accountId,
          siteId: ed.siteId,
          actor,
          sessionId: 's',
          utteranceMasked: 'відкрий звіт по клієнтах',
          source: 'typed',
          lang: 'uk',
          pageUrl: 'https://admin.z13a.example/admin/orders/:n',
          steps: [],
          needsConfirm: false,
          confirmBefore: new Date(),
          expiresAt: new Date(),
          status: 'failed',
          ...extra,
        },
      });
    const test = await prisma.assistAdminVoiceTest.create({
      data: {
        accountId: ed.accountId,
        siteId: ed.siteId,
        hostId: 'h',
        host: 'admin.z13a.example',
        origin: 'https://admin.z13a.example',
        startedBy: 'tg:1',
        tokenHash: `t-${randomUUID()}`,
        tokenExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const ids = [1, 2, 3, 4].map(() => randomUUID());
    await plan(ids[0], 'jwt:a');
    await plan(ids[1], 'jwt:b');
    // Порог «Админки» (аудит P3-3): 2 сотрудника И 3 повтора.
    await plan(ids[3], 'jwt:a');
    await plan(ids[2], 'jwt:c', { voiceTestId: test.id });
    const append = (
      planId: string,
      req: Record<string, unknown>,
      outcome = 'refused',
    ) =>
      log.append({
        accountId: ed.accountId,
        siteId: ed.siteId,
        actor: 'jwt:x',
        actorRole: null,
        channel: 'embed',
        conversationId: null,
        connectorId: null,
        operationRowId: null,
        operation: 'ui.plan',
        kind: 'ui-plan',
        outcome,
        httpStatus: null,
        durationMs: null,
        requestMasked: {
          plan: planId,
          page: '/admin/orders/:n',
          notes: [],
          mapKey: null,
          mapMiss: false,
          ...req,
        },
        responseBytes: null,
        error: null,
      });
    await append(ids[0], {});
    await append(ids[1], {});
    await append(ids[3], {});
    // Мастер: и строка с `test`, и план с `voiceTestId` — не сигнал.
    await append(ids[2], { test: test.id });
    await append(randomUUID(), {}, 'dryrun');
    // Путь страницы в журнале — маской (`:n`), а панель спрашивает живой
    // путь: совпадение — по шаблону `/admin/orders/*`.
    const m = await svc.misses(ed, '/admin/orders/1042');
    expect(m.asked).toEqual([
      expect.objectContaining({
        phrase: 'звіт по клієнтах',
        count: 3,
        visitors: 2,
      }),
    ]);
    // Без шаблона: путь с ПД (≥ 9 цифр) в журнале — маской, совпадение — по маске.
    const [c1, c2] = [randomUUID(), randomUUID()];
    for (const [id, who] of [
      [c1, 'jwt:a'],
      [c2, 'jwt:b'],
    ]) {
      await plan(id, who, { utteranceMasked: 'відкрий картку боржника' });
      await append(id, { page: '/admin/customers/:n' });
    }
    // Аудит З13-А P3-4 (A4): тепловые значки — только цели ЭТОЙ страницы.
    const r2 = await maps.loadMap(
      db.forAccount(ed.accountId),
      ed.accountId,
      ed.siteId,
    );
    const tab = (text: string) => ({
      tag: 'button',
      role: 'tab',
      text,
      toggle: true,
      unique: true,
    });
    await maps.patch(
      {
        accountId: ed.accountId,
        memberId: ed.memberId,
        actor: 'tg:1',
        actorRole: 'owner',
        channel: 'tma',
      },
      ed.siteId,
      {
        expectedRevision: r2.draftRevision,
        ops: [
          {
            op: 'upsert-target',
            target: {
              key: 'here',
              scope: 'site',
              descriptor: tab('Історія'),
              names: { uk: 'Історія' },
            },
          },
          {
            op: 'upsert-target',
            target: {
              key: 'there',
              scope: 'page',
              pagePath: '/admin/settings',
              descriptor: tab('Податки'),
              names: { uk: 'Податки' },
            },
          },
        ],
      },
      'tma',
    );
    for (const key of ['here', 'there'])
      await log.append({
        accountId: ed.accountId,
        siteId: ed.siteId,
        actor: 'jwt:x',
        actorRole: null,
        channel: 'embed',
        conversationId: null,
        connectorId: null,
        operationRowId: null,
        operation: 'ui.click',
        kind: 'ui-step',
        outcome: 'manual',
        httpStatus: null,
        durationMs: null,
        requestMasked: { plan: randomUUID(), mapKey: key },
        responseBytes: null,
        error: null,
      });
    const heat = await svc.misses(ed, '/admin/orders/1042');
    expect(heat.heat.map((h) => h.key)).toEqual(['here']);
    expect(heat.items.map((h) => h.key)).toEqual(['here']);
    expect(
      (await svc.misses(ed, '/admin/settings')).heat.map((h) => h.key).sort(),
    ).toEqual(['here', 'there']);
    const mc = await svc.misses(ed, '/admin/customers/123456789012');
    expect(mc.asked.map((x) => x.phrase)).toEqual(['картку боржника']);
    const s = await svc.suggestions(ed, '/admin/orders/7');
    expect(s.items).toEqual([
      expect.objectContaining({ kind: 'asked', visitors: 2 }),
    ]);
    await svc.mute(ed, { id: s.items[0].id });
    expect((await svc.suggestions(ed, '/admin/orders/7')).items).toEqual([]);
    const row2 = await prisma.assistAdminActionLog.findFirst({
      where: { siteId: ed.siteId, operation: 'voice-map.suggestion-mute' },
    });
    expect(row2).toMatchObject({
      actor: 'jwt:owner-1',
      channel: 'embed',
      kind: 'voice-map',
      requestMasked: { id: s.items[0].id },
    });
    // Цепочка журнала цела после строк панели.
    expect(await log.verifyChain(ed.accountId, ed.siteId)).toBe(-1);
  });
});
