/**
 * AI Publisher, P-C — контракт и интеграция с ядром (проектный документ
 * §11.3, §16.0): маршруты = `contracts/distribution-api.ts`; вклады
 * создания продукта (канал `site`, строка лимита); `BudgetLimitPort`
 * через решение по бюджетному ключу (10 000 → 12 000 двумя решениями:
 * между ними лимит не пересобирается, гейт видит несогласованность);
 * публикации (стадии test/live, замена по тому же URL, t0, снятие);
 * переназначение действий удалённого участника.
 */
import * as request from 'supertest';
import { DISTRIBUTION_ROUTES } from '../contracts/distribution-api';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { enumerateControllers } from '../core/route-enumerator';
import { seedAccount, seedVerifiedHost } from '../testing/fixtures.testing';
import { PublisherBudgetController } from './budget.controller';
import { PublisherDistributionController } from './distribution.controller';
import { DistributionActionsReassign } from './distribution.service';
import {
  apiAs,
  approveParam,
  approvedPlacementDirect,
  distStack,
  opKey,
  seedArticle,
  seedTd08,
  type DistStack,
} from './testing/td08.testing';

jest.setTimeout(120_000);

describe('contracts/distribution-api ↔ контроллеры P-C', () => {
  it('DISTRIBUTION_ROUTES = маршруты контроллеров (метод, путь, действие)', () => {
    const fromControllers = enumerateControllers([
      PublisherDistributionController as never,
      PublisherBudgetController as never,
    ])
      .map((r) => `${r.method} ${r.path} ${JSON.stringify(r.pubActions)}`)
      .sort();
    const fromContract = Object.values(DISTRIBUTION_ROUTES)
      .map(
        (r) =>
          `${r.method} ${r.path} ${JSON.stringify(Array.isArray(r.action) ? r.action : [r.action])}`,
      )
      .sort();
    expect(fromControllers).toEqual(fromContract);
    expect(fromContract.length).toBe(Object.keys(DISTRIBUTION_ROUTES).length);
  });
});

ciDescribe('P-C ↔ ядро: создание продукта, BudgetLimitPort, публикации', () => {
  let s: DistStack;
  beforeAll(async () => {
    s = await distStack();
  });
  afterAll(async () => {
    await s.close();
  });

  it('создание продукта: канал site и строка лимита из допущений (paramVersion = Σ версий)', async () => {
    const acc = await seedAccount(s.prisma);
    const owner = apiAs(s.app!.getHttpServer(), acc.accountId, acc.owner);
    const r = await owner.post(`/publisher/sites/${acc.siteId}/product`, {
      name: 'Пілот',
      kind: 'test',
    });
    expect(r.status).toBe(201);
    const pid = r.body.data.id;
    const ch = (await owner.get(`/publisher/products/${pid}/channels`)).body
      .data.items;
    expect(ch).toEqual([
      expect.objectContaining({ code: 'site', kind: 'site', title: 'Сайт' }),
    ]);
    const b = (await owner.get(`/publisher/products/${pid}/budget`)).body.data;
    expect(b).toMatchObject({
      built: true,
      currency: 'UAH',
      total: '1000000',
      available: '800000',
      paramVersion: 3,
      warnings: [],
    });
    const gates = (await owner.get(`/publisher/products/${pid}/gates`)).body
      .data;
    // Лимит собран и свеж; закрыто только неутверждёнными параметрами.
    expect(gates.spend.missing.map((m: { kind: string }) => m.kind)).toEqual([
      'parameter',
      'parameter',
    ]);
  });

  it('решения по бюджету: 10 000 → 12 000 двумя решениями; между ними лимит не пересобран, гейт — inconsistent', async () => {
    const acc = await seedAccount(s.prisma);
    const owner = apiAs(s.app!.getHttpServer(), acc.accountId, acc.owner);
    const pid = (
      await owner.post(`/publisher/sites/${acc.siteId}/product`, {
        name: 'П',
        kind: 'test',
      })
    ).body.data.id;
    const P = `/publisher/products/${pid}`;
    const decide = async (key: string, value: unknown) => {
      const pr = await owner.post(`${P}/parameters/${key}/proposals`, {
        value,
      });
      expect(pr.status).toBe(201);
      const cur = (await owner.get(`${P}/parameters`)).body.data.items.find(
        (x: { key: string }) => x.key === key,
      );
      const d = await owner.post(`${P}/parameters/${key}/decision`, {
        toStatus: 'approved',
        proposalId: pr.body.data.proposalId,
        basis: 'Рішення власника щодо бюджету',
        expectedRevision: cur.revision,
      });
      expect(d.status).toBe(200);
    };
    await decide('budget_total', { amountMinor: 1_200_000, currency: 'UAH' });
    let b = (await owner.get(`${P}/budget`)).body.data;
    expect(b).toMatchObject({ total: '1000000', paramVersion: 3 });
    expect(b.warnings).toContain('stale_limit');
    const gates = (await owner.get(`${P}/gates`)).body.data;
    expect(gates.spend.missing).toEqual(
      expect.arrayContaining([
        { kind: 'budget', key: 'budget_split', detail: 'inconsistent' },
        { kind: 'budget', key: 'pub_budget_limits', detail: 'stale' },
      ]),
    );
    await decide('budget_split', {
      placementsMinor: 800_000,
      toolsMinor: 200_000,
      reserveMinor: 200_000,
    });
    b = (await owner.get(`${P}/budget`)).body.data;
    expect(b).toMatchObject({
      total: '1200000',
      available: '1000000',
      paramVersion: 5,
      warnings: [],
    });
    expect(b.byCategory.placements.limit).toBe('800000');
  });

  it('публикации: test-стадия на kind=test; замена той же страницы новой версией; снятие страницы', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    // Публикация TD-08 той же версии по тому же URL уже есть — дубль 409.
    const dup = await op.post(`${P}/publications`, {
      versionId: w.versionId,
      channelId: w.siteChannelId,
    });
    expect(dup.status).toBe(409);
    // Новая версия той же статьи по тому же URL: прежняя → replaced.
    const v2 = await s.prisma.pubContentVersion.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        contentId: w.articleId,
        number: 2,
        title: 'Заголовок v2',
        body: 'Текст v2',
        meta: {},
        format: 'article',
        offerVersionId: (await s.prisma.pubContentVersion.findFirst({
          where: { id: w.versionId },
        }))!.offerVersionId,
        authorMemberId: 'td08-editor',
        status: 'submitted',
        hash: 'f'.repeat(64),
        frozenAt: new Date(),
        createdBy: 'member:td08-editor',
      },
    });
    const noAppr = await op.post(`${P}/publications`, {
      versionId: v2.id,
      channelId: w.siteChannelId,
    });
    expect(noAppr.body.error.code).toBe('PUB_APPROVAL_REQUIRED');
    await s.prisma.pubApproval.create({
      data: {
        accountId: w.ref.accountId,
        productId: w.ref.id,
        type: 'publish_version',
        objectType: 'content_version',
        objectId: v2.id,
        versionHash: 'f'.repeat(64),
        approverMemberId: 'td08-owner',
        approverDisplayName: 'Власник',
        createdBy: 'member:td08-owner',
      },
    });
    const p2 = await op.post(`${P}/publications`, {
      versionId: v2.id,
      channelId: w.siteChannelId,
    });
    expect(p2.status).toBe(201);
    expect(p2.body.data).toMatchObject({
      stage: 'test',
      status: 'published',
      finalUrl: `https://ai-publisher.org/materials/${w.slug}`,
    });
    const all = (await op.get(`${P}/publications?channelId=${w.siteChannelId}`))
      .body.data.items;
    expect(all.map((x: { status: string }) => x.status).sort()).toEqual([
      'published',
      'replaced',
    ]);
    expect(s.content.published).toEqual(
      expect.arrayContaining([
        { versionId: v2.id, publicationId: p2.body.data.id, stage: 'test' },
      ]),
    );
    const noReason = await op.post(
      `${P}/publications/${p2.body.data.id}/transition`,
      {
        to: 'withdrawn',
        expectedRevision: p2.body.data.revision,
      },
    );
    expect(noReason.status).toBe(400);
    const wd = await op.post(
      `${P}/publications/${p2.body.data.id}/transition`,
      {
        to: 'withdrawn',
        reason: 'Матеріал знято редактором',
        expectedRevision: p2.body.data.revision,
      },
    );
    expect(wd.status).toBe(200);
    expect(s.content.withdrawn).toContain(v2.id);
  });

  it('рабочий продукт live: страница сайта — гейт public_publish; с ним — stage live и t0 один раз', async () => {
    const w = await seedTd08(s.prisma, s.budget, {
      kind: 'working',
      mode: 'live',
    });
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    // Отдельная статья без тестовой публикации TD-08.
    const art = await seedArticle(s.prisma, w.ref);
    const closed = await op.post(`${P}/publications`, {
      versionId: art.versionId,
      channelId: w.siteChannelId,
    });
    expect(closed.status).toBe(409);
    expect(closed.body.error.details).toMatchObject({ gate: 'public_publish' });
    // Внешний канал live — тот же гейт (S3-3, §10: запись Publication(stage=live)).
    const tg = (
      await op.post(`${P}/channels`, {
        code: 'tg',
        title: 'Telegram',
        kind: 'own',
        utmSource: 'telegram',
        utmMedium: 'social',
      })
    ).body.data;
    const extClosed = await op.post(`${P}/publications`, {
      versionId: art.versionId,
      channelId: tg.id,
      finalUrl: 'https://t.me/s/ai_publisher_ua/1',
    });
    expect(extClosed.status).toBe(409);
    expect(extClosed.body.error.details).toMatchObject({
      gate: 'public_publish',
    });
    for (const key of [
      'niche',
      'language',
      'market',
      'offer_active_version',
      'domain_host',
      'hosting',
      'data_notice_version',
      'consent_map',
      'analytics_storage',
      'event_map',
      'perf_targets',
      'responsibles',
      'qualification_rules',
      'pilot_calendar',
      'launch_evidence_d0',
    ]) {
      await approveParam(s.prisma, w.ref, key);
    }
    await seedVerifiedHost(
      s.prisma,
      w.acc.accountId,
      w.product.siteId,
      'ai-publisher.org',
    );
    const spy = jest.spyOn(s.pilotClock, 'setT0Once');
    const live = await op.post(`${P}/publications`, {
      versionId: art.versionId,
      channelId: w.siteChannelId,
    });
    expect(live.status).toBe(201);
    expect(live.body.data).toMatchObject({
      stage: 'live',
      status: 'published',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.content.published).toEqual(
      expect.arrayContaining([
        {
          versionId: art.versionId,
          publicationId: live.body.data.id,
          stage: 'live',
        },
      ]),
    );
    // Публикация во внешнем канале (гейт открыт) t0 не ставит.
    const ext = await op.post(`${P}/publications`, {
      versionId: art.versionId,
      channelId: tg.id,
      finalUrl: 'https://t.me/s/ai_publisher_ua/1',
    });
    expect(ext.status).toBe(201);
    expect(ext.body.data.stage).toBe('live');
    expect(spy).toHaveBeenCalledTimes(1);
    // Неактивный оффер или открытые задачи изменения — live-публикация отвергнута.
    const art2 = await seedArticle(s.prisma, w.ref);
    s.content.overrides.set(art2.versionId, { openChangeTasks: 2 });
    const blocked = await op.post(`${P}/publications`, {
      versionId: art2.versionId,
      channelId: w.siteChannelId,
    });
    expect(blocked.body.error.code).toBe('PUB_BLOCKERS_OPEN');
    spy.mockRestore();
  });

  it('действие: имя владельца не хранится в ключе идемпотентности; повтор с тем же opKey пересобирает ответ (S2-3)', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const srv = s.app!.getHttpServer();
    const op = apiAs(srv, w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const key = opKey();
    const body = {
      opKey: key,
      versionId: w.versionId,
      channelId: w.siteChannelId,
      format: 'article',
      goal: 'Публікація',
      plannedAt: '2026-10-25T09:00:00.000Z',
      ownerMemberId: w.team.editor.memberId,
    };
    const first = await request(srv)
      .post(`${P}/distribution/actions`)
      .set(op.headers)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.ownerDisplayName).toEqual(expect.any(String));
    const replay = await request(srv)
      .post(`${P}/distribution/actions`)
      .set(op.headers)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const tr = await op.post(
      `${P}/distribution/actions/${first.body.data.id}/transition`,
      {
        to: 'cancelled',
        expectedRevision: first.body.data.revision,
      },
    );
    expect(tr.status).toBe(200);
    const keys = await s.prisma.pubIdempotencyKey.findMany({
      where: {
        productId: w.product.id,
        scope: { startsWith: 'distribution.action' },
      },
    });
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(JSON.stringify(k.responseBody)).not.toMatch(/DisplayName/i);
      expect(k.responseBody).toMatchObject({
        responseHash: expect.any(String),
        ref: { actionId: first.body.data.id },
      });
    }
  });

  it('переназначение действий и открытых претензий удалённого участника владельцу кабинета', async () => {
    const w = await seedTd08(s.prisma, s.budget);
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const a = await op.post(`${P}/distribution/actions`, {
      versionId: w.versionId,
      channelId: w.siteChannelId,
      format: 'article',
      goal: 'Публікація',
      plannedAt: '2026-10-25T09:00:00.000Z',
      ownerMemberId: w.team.editor.memberId,
    });
    expect(a.status).toBe(201);
    // Открытая претензия, владелец — тот же участник (S3-7).
    const x = await approvedPlacementDirect(s.prisma, w, {
      seq: 1,
      totalUah: 500,
    });
    await s.prisma.pubPlacement.update({
      where: { id: x.placementId },
      data: {
        status: 'disputed',
        claimStatus: 'open',
        claimOwnerMemberId: w.team.editor.memberId,
        nextActionAt: new Date(Date.now() + 86_400_000),
      },
    });
    const job = s.mod.get(DistributionActionsReassign);
    const n = await s.prisma.$transaction((tx) =>
      job.reassign(
        tx as never,
        w.ref,
        w.team.editor.memberId,
        w.acc.owner.memberId,
      ),
    );
    expect(n).toBe(2);
    const after = (await op.get(`${P}/distribution/actions`)).body.data
      .items[0];
    expect(after.ownerMemberId).toBe(w.acc.owner.memberId);
    expect(
      (await op.get(`${P}/placements/${x.placementId}`)).body.data
        .claimOwnerMemberId,
    ).toBe(w.acc.owner.memberId);
  });
});
