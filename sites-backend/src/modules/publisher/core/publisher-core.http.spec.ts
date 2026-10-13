/**
 * Маршруты ядра Publisher по HTTP на базе (P-A1, проектный документ §3.3,
 * §4, §10, §11.1–11.3): настоящий `TelegramIdentityGuard`,
 * `SiteAccountGuard`, `PubRoleGuard`, конверт и фильтры; база — тестовая,
 * порты пакетов этапа 1 — фейки.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { CORE_ROUTES } from '../contracts/core-api';
import { PARAMETER_KEYS } from '../contracts/parameters';
import {
  seedMembers,
  seedProduct,
  seedSite,
  seedTwoAccounts,
  seedVerifiedHost,
  type SeededMembers,
  type TwoAccounts,
} from '../testing/fixtures.testing';
import { fillPath } from './route-enumerator';
import { FakeProductInit } from './testing/fake-ports';
import {
  asMember,
  coreStack,
  type CoreStack,
} from './testing/core-stack.testing';

jest.setTimeout(90_000);

ciDescribe('Publisher P-A1: маршруты ядра по HTTP', () => {
  let s: CoreStack;
  let w: TwoAccounts;
  let team: SeededMembers;
  const srv = () => s.app!.getHttpServer();
  const owner = () => asMember(w.a.owner.telegramId, w.a.accountId);
  const op = () => randomUUID();

  beforeAll(async () => {
    s = await coreStack({ http: true });
    w = await seedTwoAccounts(s.prisma, { withProducts: true });
    team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
  });
  afterAll(async () => {
    await s.close();
  });

  it('создание продукта: 201, ключ pp_, 38 допущений, кампания «пилот», шаги пакетов в той же транзакции; повтор opKey — тот же ответ', async () => {
    const siteId = await seedSite(s.prisma, w.a.accountId);
    const opKey = op();
    FakeProductInit.calls = [];
    const res = await request(srv())
      .post(`/publisher/sites/${siteId}/product`)
      .set(owner())
      .send({ opKey, name: 'Пілот AI Publisher', kind: 'working' });
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({
      siteId,
      kind: 'working',
      mode: 'closed',
      status: 'active',
      revision: 1,
    });
    expect(p.publicKey).toMatch(/^pp_[A-Za-z0-9]{24}$/);
    expect(p.myRoles).toEqual({
      roles: [
        'product_owner',
        'editor',
        'operator',
        'analyst',
        'sales',
        'viewer',
      ],
      admin: true,
      accountOwner: true,
    });
    expect(p.gates.public_publish).toEqual({
      open: false,
      missingCount: expect.any(Number),
    });
    expect(
      await s.prisma.pubParameter.count({
        where: { productId: p.id, status: 'assumption' },
      }),
    ).toBe(PARAMETER_KEYS.length);
    expect(
      await s.prisma.pubCampaign.count({
        where: { productId: p.id, code: 'pilot' },
      }),
    ).toBe(1);
    expect(FakeProductInit.calls.map((c) => c.key).sort()).toEqual([
      'budget-limit',
      'pilot-experiment',
      'site-channel',
    ]);
    const again = await request(srv())
      .post(`/publisher/sites/${siteId}/product`)
      .set(owner())
      .send({ opKey, name: 'Пілот AI Publisher', kind: 'working' });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(p.id);
    expect(await s.prisma.pubProduct.count({ where: { siteId } })).toBe(1);
    // GET продукта сайта
    const got = await request(srv())
      .get(`/publisher/sites/${siteId}/product`)
      .set(owner());
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(p.id);
  });

  it('второй продукт на сайт — 409 PUB_PRODUCT_EXISTS; сайт чужого кабинета — 404; restored — 400', async () => {
    const dup = await request(srv())
      .post(`/publisher/sites/${w.a.siteId}/product`)
      .set(owner())
      .send({ opKey: op(), name: 'Ще один', kind: 'test' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PUB_PRODUCT_EXISTS');
    const foreign = await request(srv())
      .post(`/publisher/sites/${w.b.siteId}/product`)
      .set(owner())
      .send({ opKey: op(), name: 'Чужий', kind: 'test' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('PUB_NOT_FOUND');
    const siteId = await seedSite(s.prisma, w.a.accountId);
    const restored = await request(srv())
      .post(`/publisher/sites/${siteId}/product`)
      .set(owner())
      .send({ opKey: op(), name: 'X', kind: 'restored' });
    expect(restored.status).toBe(400);
    expect(restored.body.error.details.fields).toEqual([
      { field: 'kind', code: 'enum' },
    ]);
    const none = await request(srv())
      .get(`/publisher/sites/${siteId}/product`)
      .set(owner());
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('PUB_PRODUCT_NONE');
  });

  it('основа AT-CORE-08: каждый маршрут ядра с :pid/:siteId чужого кабинета — 404 PUB_NOT_FOUND', async () => {
    const foreign = {
      pid: w.b.product!.id,
      siteId: w.b.siteId,
      key: 'niche',
      id: 'x',
      grantId: 'x',
    };
    for (const r of Object.values(CORE_ROUTES)) {
      const path = fillPath(r.path, foreign);
      const req = request(srv())
        [r.method.toLowerCase() as 'get' | 'post' | 'patch'](path)
        .set(owner());
      const res =
        r.method === 'GET'
          ? await req
          : await req.send({ opKey: op(), expectedRevision: 1 });
      expect({
        route: `${r.method} ${r.path}`,
        status: res.status,
        code: res.body.error?.code,
      }).toEqual({
        route: `${r.method} ${r.path}`,
        status: 404,
        code: 'PUB_NOT_FOUND',
      });
    }
  });

  it('ошибка — конверт с details и текстом по Accept-Language', async () => {
    const p = w.a.product!;
    const res = await request(srv())
      .patch(`/publisher/products/${p.id}`)
      .set({ ...owner(), 'Accept-Language': 'en-US,en;q=0.9' })
      .send({ opKey: op(), name: 'X', expectedRevision: 999 });
    expect(res.status).toBe(409);
    // аудит P3-3: ответы кабинета и ошибки — не в кэш
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'PUB_CONFLICT',
        message: 'Someone else changed this — reload and try again',
        details: { currentRevision: 1 },
      },
    });
    const uk = await request(srv())
      .patch(`/publisher/products/${p.id}`)
      .set(owner())
      .send({ opKey: op(), name: 'X' });
    expect(uk.status).toBe(400);
    const okRead = await request(srv())
      .get(`/publisher/products/${p.id}/parameters`)
      .set(owner());
    expect(okRead.status).toBe(200);
    expect(okRead.headers['cache-control']).toBe('private, no-store');
    const denied = await request(srv())
      .get(`/publisher/products/${p.id}/parameters`)
      .set(asMember(team.noAccess.telegramId, w.a.accountId));
    expect(denied.status).toBe(403);
    expect(denied.headers['cache-control']).toBe('private, no-store');
    expect(uk.body.error).toMatchObject({
      code: 'PUB_VALIDATION',
      message: 'Перевірте поля форми',
      details: { fields: [{ field: 'expectedRevision', code: 'required' }] },
    });
  });

  it('роли: матрица §4.2 на маршрутах — viewer читает, но не предлагает; аналитик предлагает, но не решает; без допуска — 403 site-core', async () => {
    const p = w.a.product!;
    const viewer = asMember(team.viewer.telegramId, w.a.accountId);
    expect(
      (await request(srv()).get(`/publisher/products/${p.id}`).set(viewer))
        .status,
    ).toBe(200);
    const vp = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/proposals`)
      .set(viewer)
      .send({ opKey: op(), value: { count: 3, windowSec: 600 } });
    expect(vp.status).toBe(403);
    expect(vp.body.error).toMatchObject({
      code: 'PUB_ROLE_REQUIRED',
      details: { action: 'parameter.propose' },
    });
    const analyst = asMember(team.analyst.telegramId, w.a.accountId);
    const ap = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/proposals`)
      .set(analyst)
      .send({ opKey: op(), value: { count: 3, windowSec: 600 } });
    expect(ap.status).toBe(201);
    const ad = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/decision`)
      .set(analyst)
      .send({
        opKey: op(),
        toStatus: 'approved',
        proposalId: ap.body.data.proposalId,
        basis: 'Рішення аналітика',
        expectedRevision: 1,
      });
    expect(ad.status).toBe(403);
    const noAccess = await request(srv())
      .get(`/publisher/products/${p.id}`)
      .set(asMember(team.noAccess.telegramId, w.a.accountId));
    expect(noAccess.status).toBe(403);
    expect(noAccess.body.error.code).toBe('PRODUCT_ROLE_REQUIRED');
    const memberNoRoles = await request(srv())
      .get(`/publisher/products/${p.id}`)
      .set(asMember(team.memberNoRoles.telegramId, w.a.accountId));
    expect(memberNoRoles.status).toBe(403);
    expect(memberNoRoles.body.error.code).toBe('PUB_ROLE_REQUIRED');
    // admin без ролей продукта: роли и режим — да, параметры — нет
    const admin = asMember(team.admin.telegramId, w.a.accountId);
    expect(
      (await request(srv()).get(`/publisher/products/${p.id}/roles`).set(admin))
        .status,
    ).toBe(200);
    expect(
      (
        await request(srv())
          .post(`/publisher/products/${p.id}/parameters/niche/decision`)
          .set(admin)
          .send({
            opKey: op(),
            toStatus: 'approved',
            basis: 'Адміністратор не вирішує',
            expectedRevision: 1,
          })
      ).status,
    ).toBe(403);
  });

  it('Р-PUB-Z2-6: GET …/parameters/:key/proposals — список с автором, mine/canWithdraw по правилу withdraw, фильтр и курсор', async () => {
    const p = w.a.product!;
    const analyst = asMember(team.analyst.telegramId, w.a.accountId);
    const viewer = asMember(team.viewer.telegramId, w.a.accountId);
    const url = `/publisher/products/${p.id}/parameters/niche/proposals`;
    const mk = async (text: string) => {
      const r = await request(srv())
        .post(url)
        .set(analyst)
        .send({ opKey: op(), value: { text } });
      expect(r.status).toBe(201);
      return r.body.data.proposalId as string;
    };
    // Предложение ДРУГОГО ключа в списке niche не появляется.
    const otherKey = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/language/proposals`)
      .set(analyst)
      .send({ opKey: op(), value: { code: 'uk' } });
    const first = await mk('Ніша А — малий бізнес');
    const second = await mk('Ніша Б — експерти');
    const wd = await request(srv())
      .post(`${url}/${first}/withdraw`)
      .set(analyst)
      .send({ opKey: op() });
    expect(wd.status).toBe(200);

    const mine = await request(srv()).get(url).set(analyst);
    expect(mine.status).toBe(200);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    const items = mine.body.data.items as Array<Record<string, unknown>>;
    expect(otherKey.status).toBe(201);
    expect(items.map((i) => i.id)).toEqual([second, first]);
    expect(items[0]).toEqual({
      id: second,
      parameterKey: 'niche',
      value: { text: 'Ніша Б — експерти' },
      status: 'open',
      proposedBy: `member:${team.analyst.memberId}`,
      proposedAt: expect.any(String),
      decisionId: null,
      revision: 1,
      mine: true,
      canWithdraw: true,
    });
    expect(items[1]).toMatchObject({
      status: 'withdrawn',
      mine: true,
      canWithdraw: false,
    });
    expect(mine.body.data.nextBefore).toBeNull();
    // Наблюдатель читает, но не отзывает; владелец отзывает чужое.
    const v = await request(srv())
      .get(url)
      .query({ status: 'open' })
      .set(viewer);
    expect(v.status).toBe(200);
    expect(v.body.data.items).toEqual([
      expect.objectContaining({ id: second, mine: false, canWithdraw: false }),
    ]);
    const o = await request(srv()).get(url).query({ limit: 1 }).set(owner());
    expect(o.body.data.items).toEqual([
      expect.objectContaining({ id: second, mine: false, canWithdraw: true }),
    ]);
    expect(o.body.data.nextBefore).toBe(second);
    const o2 = await request(srv())
      .get(url)
      .query({ limit: 1, before: second })
      .set(owner());
    expect(o2.body.data.items.map((i: { id: string }) => i.id)).toEqual([
      first,
    ]);
    const bad = await request(srv())
      .get(url)
      .query({ status: 'closed' })
      .set(owner());
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields).toEqual([
      { field: 'status', code: 'enum' },
    ]);
    const unknown = await request(srv())
      .get(`/publisher/products/${p.id}/parameters/nope/proposals`)
      .set(owner());
    expect(unknown.status).toBe(404);
  });

  it('параметры: предложение не меняет значение и гейты; решение владельца — версия +1, журнал, флаги гейтов', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'test',
    });
    const before = await request(srv())
      .get(`/publisher/products/${p.id}/parameters`)
      .set(owner());
    const fl = before.body.data.items.find(
      (i: { key: string }) => i.key === 'form_limit',
    );
    expect(fl).toMatchObject({
      status: 'assumption',
      version: 1,
      value: { count: 5, windowSec: 600 },
      gates: ['real_leads'],
    });
    const prop = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/proposals`)
      .set(owner())
      .send({ opKey: op(), value: { count: 4, windowSec: 600 } });
    expect(prop.status).toBe(201);
    expect(prop.body.data.parameter).toMatchObject({
      value: { count: 5, windowSec: 600 },
      openProposals: 1,
    });
    const bad = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/proposals`)
      .set(owner())
      .send({ opKey: op(), value: { count: 0, windowSec: 600, extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields).toEqual(
      expect.arrayContaining([
        { field: 'value.extra', code: 'unknown_field' },
        { field: 'value.count', code: 'range' },
      ]),
    );
    const dec = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'approved',
        proposalId: prop.body.data.proposalId,
        basis: 'Ліміт 4 за 10 хвилин — рішення власника',
        expectedRevision: fl.revision,
      });
    expect(dec.status).toBe(200);
    expect(dec.body.data).toMatchObject({
      version: 2,
      proposalStatus: 'accepted',
      parameter: {
        status: 'approved',
        version: 2,
        value: { count: 4, windowSec: 600 },
        openProposals: 0,
      },
    });
    const log = await request(srv())
      .get(`/publisher/products/${p.id}/parameters/decisions?key=form_limit`)
      .set(owner());
    expect(log.body.data.items).toHaveLength(1);
    expect(log.body.data.items[0]).toMatchObject({
      fromStatus: 'assumption',
      toStatus: 'approved',
      version: 2,
    });
    // основание с телефоном — 400 pii
    const pii = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/niche/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'approved',
        basis: 'Погоджено з ним: 067 123 45 67',
        expectedRevision: 1,
      });
    expect(pii.status).toBe(400);
    expect(pii.body.error.details.fields).toEqual([
      { field: 'basis', code: 'pii' },
    ]);
    // неполное значение не утверждается (курс без источника)
    const fx = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/ai_fx_rate/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'approved',
        basis: 'Курс ще не відомий',
        expectedRevision: 1,
      });
    expect(fx.status).toBe(400);
    expect(
      fx.body.error.details.fields.map((f: { field: string }) => f.field),
    ).toEqual(['value.rate', 'value.source', 'value.at']);
  });

  it('бюджетный ключ: после решения ядро зовёт BudgetLimitPort.applyParameters (P-C) в той же транзакции', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'test',
    });
    s.fakes.budgetLimit.calls = [];
    const res = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/budget_total/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'approved',
        basis: 'Ліміт 10 000 грн затверджено',
        expectedRevision: 1,
      });
    expect(res.status).toBe(200);
    expect(s.fakes.budgetLimit.calls).toEqual([p.id]);
    // сбой порта — откат решения
    s.fakes.budgetLimit.fail = new Error('порт упал');
    const r2 = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/budget_split/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'approved',
        basis: 'Розподіл 6/2/2 тисячі',
        expectedRevision: 1,
      });
    s.fakes.budgetLimit.fail = null;
    expect(r2.status).toBe(500);
    expect(
      await s.prisma.pubParameterDecision.count({
        where: { productId: p.id, parameterKey: 'budget_split' },
      }),
    ).toBe(0);
  });

  it('режим: live при закрытом гейте — 409 с перечнем недостающего; test → closed — да; eval режим не меняет', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'working',
    });
    const live = await request(srv())
      .post(`/publisher/products/${p.id}/mode`)
      .set(owner())
      .send({ opKey: op(), mode: 'live', expectedRevision: 1 });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe('PUB_GATE_CLOSED');
    expect(live.body.error.details.gate).toBe('public_publish');
    expect(live.body.error.details.missing).toEqual(
      expect.arrayContaining([
        { kind: 'parameter', key: 'niche', detail: 'assumption' },
        { kind: 'host', key: 'ai-publisher.org', detail: 'not_found' },
      ]),
    );
    const test = await request(srv())
      .post(`/publisher/products/${p.id}/mode`)
      .set(owner())
      .send({ opKey: op(), mode: 'test', expectedRevision: 1 });
    expect(test.status).toBe(200);
    expect(test.body.data).toMatchObject({ mode: 'test', revision: 2 });
    const ev = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'eval',
    });
    const evm = await request(srv())
      .post(`/publisher/products/${ev.id}/mode`)
      .set(owner())
      .send({ opKey: op(), mode: 'test', expectedRevision: 1 });
    expect(evm.status).toBe(409);
    expect(evm.body.error).toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: { allowed: [] },
    });
  });

  it('режим live: все ключи public_publish утверждены и хост domain_host подтверждён — переход проходит', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'working',
    });
    const host = `pub-${randomUUID().slice(0, 8)}.example.com`;
    await seedVerifiedHost(s.prisma, w.a.accountId, p.siteId, host);
    const approve = async (key: string, value?: unknown) => {
      const pr =
        value === undefined
          ? null
          : await request(srv())
              .post(`/publisher/products/${p.id}/parameters/${key}/proposals`)
              .set(owner())
              .send({ opKey: op(), value });
      expect(pr === null || pr.status === 201).toBe(true);
      const proposalId: string | undefined = pr?.body.data.proposalId;
      const cur = await s.prisma.pubParameter.findFirst({
        where: { productId: p.id, key },
      });
      const r = await request(srv())
        .post(`/publisher/products/${p.id}/parameters/${key}/decision`)
        .set(owner())
        .send({
          opKey: op(),
          toStatus: 'approved',
          proposalId,
          basis: 'Затверджено до запуску',
          expectedRevision: cur!.revision,
        });
      expect({
        key,
        status: r.status,
        body: r.status === 200 ? null : r.body.error,
      }).toEqual({ key, status: 200, body: null });
    };
    await approve('niche');
    await approve('language');
    await approve('market');
    await approve('offer_active_version', {
      offerVersionId: 'ov1',
      version: 1,
    });
    await approve('domain_host', { host });
    await approve('hosting');
    // Р-PUB-Z2-26: заглушка умолчания («Чернетка…», draft-1) не утверждается.
    {
      const cur = await s.prisma.pubParameter.findFirstOrThrow({
        where: { productId: p.id, key: 'data_notice_version' },
      });
      const draft = await request(srv())
        .post(
          `/publisher/products/${p.id}/parameters/data_notice_version/decision`,
        )
        .set(owner())
        .send({
          opKey: op(),
          toStatus: 'approved',
          basis: 'Затверджено до запуску',
          expectedRevision: cur.revision,
        });
      expect(draft.status).toBe(400);
      expect(draft.body.error).toMatchObject({
        code: 'PUB_VALIDATION',
        details: {
          fields: [
            { field: 'value.version', code: 'draft_placeholder' },
            { field: 'value.text', code: 'draft_placeholder' },
          ],
        },
      });
    }
    await approve('data_notice_version', {
      version: 'notice-2026-10',
      text: 'Ми обробляємо ім’я та контакт із заявки, щоб відповісти на неї.',
    });
    await approve('consent_map');
    await approve('analytics_storage');
    await approve('event_map');
    await approve('perf_targets', {
      leadsP95Ms: 1500,
      leadsRps: 2,
      parallelSubmits: 5,
      publicReadP95Ms: 500,
      mainTextInFirstHtml: true,
      protocolRef: 'run-42',
    });
    await approve('responsibles', {
      formOwnerMemberId: w.a.owner.memberId,
      salesMemberIds: [team.sales.memberId],
      afterT72MemberId: null,
    });
    await approve('qualification_rules');
    await approve('pilot_calendar', { t0Planned: '2026-10-20T10:00:00+03:00' });
    // Р-PUB-Z2-27: qaRunId — сохранённый прогон qa-catalog, 21 AT D0 passed.
    const evidence = async (qaRunId: string) => {
      const pr = await request(srv())
        .post(
          `/publisher/products/${p.id}/parameters/launch_evidence_d0/proposals`,
        )
        .set(owner())
        .send({
          opKey: op(),
          value: { qaRunId, perfProtocolRef: 'perf-1', note: null },
        });
      expect(pr.status).toBe(201);
      const cur = await s.prisma.pubParameter.findFirstOrThrow({
        where: { productId: p.id, key: 'launch_evidence_d0' },
      });
      return request(srv())
        .post(
          `/publisher/products/${p.id}/parameters/launch_evidence_d0/decision`,
        )
        .set(owner())
        .send({
          opKey: op(),
          toStatus: 'approved',
          proposalId: pr.body.data.proposalId,
          basis: 'Протокол приймання',
          expectedRevision: cur.revision,
        });
    };
    const ghost = await evidence('qa-run-free-text');
    expect(ghost.status).toBe(409);
    expect(ghost.body.error).toMatchObject({
      code: 'PUB_CONFLICT',
      details: {
        reason: 'qa_run_not_found',
        key: 'launch_evidence_d0',
        qaRunId: 'qa-run-free-text',
        required: 21,
      },
    });
    const partial = s.fakes.qaRuns.passing(w.a.accountId, 'qa-run-partial');
    s.fakes.qaRuns.runs.get(partial)!.cases['AT-CORE-03'].status = 'failed';
    s.fakes.qaRuns.runs.get(partial)!.cases['AT-CORE-21'].status = null;
    s.fakes.qaRuns.runs.get(partial)!.cases['AT-F02-01'].version = 0;
    delete s.fakes.qaRuns.runs.get(partial)!.cases['AT-F11-02'];
    const bad = await evidence(partial);
    expect(bad.status).toBe(409);
    expect(bad.body.error.details).toMatchObject({
      reason: 'qa_run_incomplete',
      required: 21,
      missing: [
        { caseKey: 'AT-CORE-03', problem: 'status', status: 'failed' },
        { caseKey: 'AT-CORE-21', problem: 'status', status: null },
        {
          caseKey: 'AT-F02-01',
          problem: 'version',
          version: 0,
          expectedVersion: 1,
        },
        { caseKey: 'AT-F11-02', problem: 'not_in_run' },
      ],
    });
    // Прогон чужого кабинета — как несуществующий.
    const foreign = s.fakes.qaRuns.passing('other-account', 'qa-run-foreign');
    expect((await evidence(foreign)).body.error.details.reason).toBe(
      'qa_run_not_found',
    );
    const good = await evidence(s.fakes.qaRuns.passing(w.a.accountId));
    expect(good.status).toBe(200);
    const flags = await s.prisma.pubProduct.findFirst({ where: { id: p.id } });
    expect(flags).toMatchObject({
      paramsPublicPublishOk: true,
      paramsRealLeadsOk: false,
    });
    const gates = await request(srv())
      .get(`/publisher/products/${p.id}/gates`)
      .set(owner());
    expect(gates.body.data.public_publish).toEqual({
      gate: 'public_publish',
      open: true,
      missing: [],
    });
    const live = await request(srv())
      .post(`/publisher/products/${p.id}/mode`)
      .set(owner())
      .send({ opKey: op(), mode: 'live', expectedRevision: 1 });
    expect(live.status).toBe(200);
    expect(live.body.data.mode).toBe('live');
    expect(live.body.data.liveSince).toEqual(expect.any(String));
    // аудит P3-6: live → closed — только с утверждённым alt_contact
    const closeNo = await request(srv())
      .post(`/publisher/products/${p.id}/mode`)
      .set(owner())
      .send({
        opKey: op(),
        mode: 'closed',
        expectedRevision: live.body.data.revision,
        reason: 'Набір завершено',
      });
    expect(closeNo.status).toBe(409);
    expect(closeNo.body.error).toMatchObject({
      code: 'PUB_PARAMETER_UNAPPROVED',
      details: { key: 'alt_contact', status: 'assumption' },
    });
    await approve('alt_contact', {
      label: 'Пишіть',
      href: 'https://t.me/ai_publisher',
    });
    const closeOk = await request(srv())
      .post(`/publisher/products/${p.id}/mode`)
      .set(owner())
      .send({
        opKey: op(),
        mode: 'closed',
        expectedRevision: live.body.data.revision,
        reason: 'Набір завершено',
      });
    expect(closeOk.status).toBe(200);
    expect(closeOk.body.data.mode).toBe('closed');
  });

  it('роли: выдача (себе — selfReview в журнале), повтор — 409, без допуска к Publisher — 400; отзыв — с причиной без контактов', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'test',
    });
    const g = await request(srv())
      .post(`/publisher/products/${p.id}/roles`)
      .set(owner())
      .send({ opKey: op(), memberId: w.a.owner.memberId, role: 'editor' });
    expect(g.status).toBe(201);
    // аудит P3-14в: имя участника в ключе идемпотентности не хранится
    const key = await s.prisma.pubIdempotencyKey.findFirst({
      where: { accountId: w.a.accountId, scope: 'role.grant' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(key?.responseBody ?? null)).not.toContain(
      'memberDisplayName',
    );
    const ev = await s.prisma.pubAuditEvent.findFirst({
      where: { objectId: g.body.data.id, action: 'grant' },
    });
    expect(ev?.meta).toMatchObject({ selfReview: true, role: 'editor' });
    const dup = await request(srv())
      .post(`/publisher/products/${p.id}/roles`)
      .set(owner())
      .send({ opKey: op(), memberId: w.a.owner.memberId, role: 'editor' });
    expect(dup.status).toBe(409);
    const na = await request(srv())
      .post(`/publisher/products/${p.id}/roles`)
      .set(owner())
      .send({ opKey: op(), memberId: team.noAccess.memberId, role: 'viewer' });
    expect(na.status).toBe(400);
    expect(na.body.error.details.fields).toEqual([
      { field: 'memberId', code: 'no_publisher_access' },
    ]);
    const foreignMember = await request(srv())
      .post(`/publisher/products/${p.id}/roles`)
      .set(owner())
      .send({ opKey: op(), memberId: w.b.owner.memberId, role: 'viewer' });
    expect(foreignMember.status).toBe(404);
    const rv = await request(srv())
      .post(`/publisher/products/${p.id}/roles/${g.body.data.id}/revoke`)
      .set(owner())
      .send({ opKey: op(), reason: 'пишіть на boss@example.com' });
    expect(rv.status).toBe(400);
    const ok = await request(srv())
      .post(`/publisher/products/${p.id}/roles/${g.body.data.id}/revoke`)
      .set(owner())
      .send({ opKey: op(), reason: 'Роль більше не потрібна' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      active: false,
      revokedBy: `member:${w.a.owner.memberId}`,
    });
    const twice = await request(srv())
      .post(`/publisher/products/${p.id}/roles/${g.body.data.id}/revoke`)
      .set(owner())
      .send({ opKey: op(), reason: 'Ще раз' });
    expect(twice.status).toBe(409);
  });

  it('задачи проверки: продажи видят и решают только retention_review; решение — CAS и журнал', async () => {
    const p = w.a.product!;
    const review = s.mod.get(
      (await import('./review-tasks.service')).ReviewTasksService,
    );
    await s.db.forAccount(p.accountId).$transaction(async (tx) => {
      const n = await review.open(tx, p, [
        {
          objectType: 'lead',
          objectId: 'lead-1',
          reason: 'retention_review',
          triggerRef: 'due:1',
          severity: 'normal',
        },
        {
          objectType: 'content',
          objectId: 'c-1',
          reason: 'offer_changed',
          triggerRef: 'offer:2',
          severity: 'critical',
        },
        {
          objectType: 'content',
          objectId: 'c-1',
          reason: 'offer_changed',
          triggerRef: 'offer:2',
          severity: 'critical',
        },
      ]);
      expect(n).toBe(2);
    });
    const sales = asMember(team.sales.telegramId, w.a.accountId);
    const list = await request(srv())
      .get(`/publisher/products/${p.id}/review-tasks?status=open`)
      .set(sales);
    expect(list.status).toBe(200);
    expect(
      list.body.data.items.map((t: { reason: string }) => t.reason),
    ).toEqual(['retention_review']);
    const editorList = await request(srv())
      .get(`/publisher/products/${p.id}/review-tasks?status=open`)
      .set(asMember(team.editor.telegramId, w.a.accountId));
    const offer = editorList.body.data.items.find(
      (t: { reason: string }) => t.reason === 'offer_changed',
    );
    const salesOnOffer = await request(srv())
      .post(`/publisher/products/${p.id}/review-tasks/${offer.id}/resolve`)
      .set(sales)
      .send({
        opKey: op(),
        status: 'resolved',
        resolution: 'Перевірено',
        expectedRevision: offer.revision,
      });
    expect(salesOnOffer.status).toBe(403);
    const ed = await request(srv())
      .post(`/publisher/products/${p.id}/review-tasks/${offer.id}/resolve`)
      .set(asMember(team.editor.telegramId, w.a.accountId))
      .send({
        opKey: op(),
        status: 'resolved',
        resolution: 'Текст не зачіпає ціну',
        expectedRevision: offer.revision,
      });
    expect(ed.status).toBe(200);
    expect(ed.body.data).toMatchObject({
      status: 'resolved',
      resolvedBy: `member:${team.editor.memberId}`,
    });
    const again = await request(srv())
      .post(`/publisher/products/${p.id}/review-tasks/${offer.id}/resolve`)
      .set(asMember(team.editor.telegramId, w.a.accountId))
      .send({
        opKey: op(),
        status: 'dismissed',
        resolution: 'Ще раз',
        expectedRevision: offer.revision + 1,
      });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PUB_TRANSITION_INVALID');
    const audit = await request(srv())
      .get(`/publisher/products/${p.id}/audit?objectType=review_task`)
      .set(owner());
    expect(audit.status).toBe(200);
    expect(
      audit.body.data.items.some(
        (e: { action: string }) => e.action === 'resolve',
      ),
    ).toBe(true);
  });

  it('аудит P3-14а: задачу назначают только участнику с правом её решать', async () => {
    const p = w.a.product!;
    const review = s.mod.get(
      (await import('./review-tasks.service')).ReviewTasksService,
    );
    const trig = `assign:${randomUUID()}`;
    await s.db.forAccount(p.accountId).$transaction((tx) =>
      review.open(tx, p, [
        {
          objectType: 'content',
          objectId: 'c-assign',
          reason: 'offer_changed',
          triggerRef: trig,
          severity: 'normal',
        },
      ]),
    );
    const task = await s.prisma.pubReviewTask.findFirstOrThrow({
      where: { productId: p.id, triggerRef: trig },
    });
    const assign = (memberId: string, rev: number) =>
      request(srv())
        .post(`/publisher/products/${p.id}/review-tasks/${task.id}/assign`)
        .set(owner())
        .send({
          opKey: op(),
          assigneeMemberId: memberId,
          expectedRevision: rev,
        });
    for (const [who, code] of [
      [team.noAccess.memberId, 'not_member'],
      [team.viewer.memberId, 'no_review_access'],
      [team.sales.memberId, 'no_review_access'],
      [w.b.owner.memberId, 'not_member'],
    ] as const) {
      const r = await assign(who, task.revision);
      expect({
        who,
        status: r.status,
        fields: r.body.error?.details?.fields,
      }).toEqual({
        who,
        status: 400,
        fields: [{ field: 'assigneeMemberId', code }],
      });
    }
    const ok = await assign(team.editor.memberId, task.revision);
    expect(ok.status).toBe(200);
    expect(ok.body.data.assigneeMemberId).toBe(team.editor.memberId);
  });

  it('решение assumption по маршруту (контракт P-A0): допущение для test той же версии', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'test',
    });
    const pr = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/proposals`)
      .set(owner())
      .send({ opKey: op(), value: { count: 50, windowSec: 3600 } });
    expect(pr.status).toBe(201);
    const cur = await s.prisma.pubParameter.findFirstOrThrow({
      where: { productId: p.id, key: 'form_limit' },
    });
    const d = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'assumption',
        proposalId: pr.body.data.proposalId,
        basis: 'Для тестового стенду',
        expectedRevision: cur.revision,
      });
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({
      version: 2,
      proposalStatus: 'accepted',
      parameter: {
        status: 'assumption',
        value: { count: 50, windowSec: 3600 },
      },
    });
    const bad = await request(srv())
      .post(`/publisher/products/${p.id}/parameters/form_limit/decision`)
      .set(owner())
      .send({
        opKey: op(),
        toStatus: 'archived',
        basis: 'Невідомий статус',
        expectedRevision: cur.revision + 1,
      });
    expect(bad.status).toBe(400);
  });

  it('сброс лимита формы: только тестовый продукт/режим, через порт P-D, с журналом', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'working',
    });
    const no = await request(srv())
      .post(`/publisher/products/${p.id}/test/rate-limit/reset`)
      .set(owner())
      .send({ opKey: op() });
    expect(no.status).toBe(400);
    const t = await seedProduct(s.prisma, {
      accountId: w.a.accountId,
      kind: 'test',
    });
    s.fakes.rateLimitReset.removed = 3;
    const ok = await request(srv())
      .post(`/publisher/products/${t.id}/test/rate-limit/reset`)
      .set(owner())
      .send({ opKey: op() });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ removed: 3 });
    expect(
      await s.prisma.pubAuditEvent.count({
        where: { productId: t.id, action: 'reset' },
      }),
    ).toBe(1);
  });
});
