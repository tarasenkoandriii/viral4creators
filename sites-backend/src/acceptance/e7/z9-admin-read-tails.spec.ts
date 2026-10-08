/**
 * Заход 9 — хвосты Э7 «Админка: чтение» по HTTP на НАСТОЯЩЕМ Postgres:
 *  - Ш3-хвост (6): страницы обхода за логином → база знаний «Админки»
 *    (свои чанки и эмбеддинги; канарейка `CANARY-ADM` не уходит в «Сайт»);
 *  - аудит Э7 (г), Р-З9-17: сессия по `pk_test` — только знания, без
 *    коннекторов (боевой API со стенда разработчика не вызывается);
 *  - аудит Э7 (д), Р-З9-18: два одновременных перевыпуска секрета подписи
 *    (JWT и коннектора) — действует ровно один, второй — 409;
 *  - хвост (7), Р-З9-15: резерв хода «сайт + платформа» до модели —
 *    параллельные ходы не превышают суточный потолок; потолок платформы
 *    покрывает «Админку».
 */
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER, WIDGET_PK_TEST_PREFIX } from '../../brand';
import { AdminChatService } from '../../modules/assist-admin-chat/admin-chat.service';
import { AdminKnowledgeService } from '../../modules/assist-admin-knowledge/admin-knowledge.service';
import {
  ADMIN_BUDGET_SCOPE,
  adminBudgetRowMicroUsd,
  adminSpentToday,
  reserveAdminTurn,
  settleAdminTurn,
} from '../../modules/assist-admin-mode/admin-budget';
import { SitesDb } from '../../prisma/sites-db.service';
import { signEmployeeJwt } from '../../modules/assist-admin-mode/identity-jwt';
import { siteDailyCapFromPlan } from '../../modules/assist-billing/plans';
import { BrowserJobHandlers } from '../../modules/browser-jobs/job-handlers';
import type { HandlerJob } from '../../modules/browser-jobs/job-handlers';
import type {
  GenerateRequest,
  GenerateResult,
} from '../../modules/site-ai/text-model';
import { describeE7, E7Stack, shopSpec, type E7Site } from './e7-stack';

jest.setTimeout(180_000);

describeE7('заход 9 — хвосты Э7 «Админка: чтение»', () => {
  const st = new E7Stack();
  let S: E7Site;
  let identitySecret = '';
  let connectorId = '';
  let testPk = '';
  const body = (r: request.Response) => r.body.data ?? r.body;
  const apiHits = () =>
    st.net.requests.filter((q) => q.key.startsWith(S.apiHost)).length;

  const jwt = (sub: string, secret = identitySecret) => {
    const t = Math.floor(Date.now() / 1000);
    return signEmployeeJwt(
      {
        sub,
        role: 'manager',
        name: sub,
        aud: S.siteId,
        iat: t,
        exp: t + 600,
      },
      secret,
    );
  };
  const exchange = (pk: string, sub: string, secret = identitySecret) =>
    request(st.srv())
      .post('/assist-admin/v1/session')
      .send({ pk, jwt: jwt(sub, secret) });
  const ask = (sess: string, text: string) =>
    request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text });

  beforeAll(async () => {
    await st.init();
    S = await st.site();
    st.net.site(S.apiHost, {
      '/openapi.json': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: shopSpec(S.apiHost),
      },
      '/v1/orders/1042': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '1042', status: 'shipped', total: 1290 }),
      },
      '/v1/orders/5555': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: '5555',
          status: 'paid',
          email: 'olena.client@example.com',
          phone: '+380671234567',
        }),
      },
    });
    testPk = `${WIDGET_PK_TEST_PREFIX}${randomBytes(16).toString('hex')}`;
    await st.prisma.assistSite.updateMany({
      where: { siteId: S.siteId },
      data: { testKey: testPk },
    });
    await request(st.srv())
      .patch(`/assist/sites/${S.siteId}/admin-mode`)
      .set(st.as(S.ownerTg))
      .send({
        enabled: true,
        access: 'both',
        adminHostIds: [S.adminHostId],
        roleMap: { manager: 'orders' },
      })
      .expect(200);
    identitySecret = body(
      await request(st.srv())
        .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
        .set(st.as(S.ownerTg))
        .expect(200),
    ).secret;
    const c = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/connectors`)
      .set(st.as(S.ownerTg))
      .send({ name: 'shop', specUrl: `https://${S.apiHost}/openapi.json` })
      .expect(201);
    connectorId = body(c).id;
    await request(st.srv())
      .patch(
        `/assist/sites/${S.siteId}/connectors/${connectorId}/operations/getOrder`,
      )
      .set(st.as(S.ownerTg))
      .send({ enabled: true, roles: ['orders'] })
      .expect(200);
    await st.adminDocument(S, {
      ref: 'regl-z9',
      title: 'Регламент замовлень',
      paragraphs: ['Статус замовлення менеджер дивиться в розділі Замовлення.'],
    });
  });

  afterAll(() => st.close());

  it('Р-З9-17: сессия по pk_test — только знания: каталог пуст, API заказчика не вызывается; pk_live — инструменты есть', async () => {
    const t = await exchange(testPk, 'emp-test').expect(200);
    expect(body(t).testKey).toBe(true);
    expect(body(t).session).toMatch(/^t-[A-Za-z0-9_-]{41}$/);
    const tSess: string = body(t).session;
    const st1 = await request(st.srv())
      .get('/assist-admin/v1/state')
      .set(ADMIN_SESSION_HEADER, tSess)
      .expect(200);
    expect(body(st1).employee.tools).toBe(false);
    const before = apiHits();
    const calls = st.text.calls.length;
    const a = body(
      await ask(tSess, 'Який статус замовлення 1042?').expect(200),
    ).answer;
    expect(a.answerPath).not.toBe('tool');
    expect(a.tools).toEqual([]);
    expect(apiHits()).toBe(before);
    // План с каталогом инструментов модели даже не показывали.
    for (const c of st.text.calls.slice(calls)) {
      expect(c.user).not.toContain('shop.getOrder');
    }
    // Тот же сотрудник по боевому ключу — инструменты есть, API вызван.
    const l = await exchange(S.pk, 'emp-live').expect(200);
    expect(body(l).testKey).toBe(false);
    expect(body(l).session).not.toMatch(/^t-/);
    const live = body(
      await ask(body(l).session, 'Який статус замовлення 1042?').expect(200),
    ).answer;
    expect(live.answerPath).toBe('tool');
    expect(apiHits()).toBe(before + 1);
    // Подделать метку нельзя: в базе — хеш токена, чужой токен — 401.
    await request(st.srv())
      .get('/assist-admin/v1/state')
      .set(ADMIN_SESSION_HEADER, `t-${body(l).session.slice(2)}`)
      .expect(401);
  });

  it('Р-З9-17, флаг: владелец включил «тестовый ключ ходит в API» — pk_test получает инструменты; выключил — снова только знания', async () => {
    const patch = (v: boolean) =>
      request(st.srv())
        .patch(`/assist/sites/${S.siteId}/admin-mode`)
        .set(st.as(S.ownerTg))
        .send({ testKeyConnectors: v })
        .expect(200);
    expect(body(await patch(true)).testKeyConnectors).toBe(true);
    try {
      const t = body(await exchange(testPk, 'emp-test-on').expect(200));
      expect(t.testKey).toBe(true);
      const before = apiHits();
      const a = body(
        await ask(t.session, 'Який статус замовлення 1042?').expect(200),
      ).answer;
      expect(a.answerPath).toBe('tool');
      expect(apiHits()).toBe(before + 1);
      // Флаг читается на каждом запросе: выключили — та же сессия без API.
      await patch(false);
      const b = body(
        await ask(t.session, 'Який статус замовлення 1042?').expect(200),
      ).answer;
      expect(b.answerPath).not.toBe('tool');
      expect(apiHits()).toBe(before + 1);
    } finally {
      await patch(false);
    }
    // Умолчание — выкл (новый сайт).
    const v = body(
      await request(st.srv())
        .get(`/assist/sites/${S.siteId}/admin-mode`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    expect(v.testKeyConnectors).toBe(false);
  });

  it('Р-З9-14: maskPd коннектора — e-mail и телефон из данных API модель не видит; выкл (умолчание) — видит', async () => {
    const sess = body(await exchange(S.pk, 'emp-mask').expect(200)).session;
    const dataBlock = async () => {
      const calls = st.text.calls.length;
      const a = body(
        await ask(sess, 'Хто клієнт замовлення 5555?').expect(200),
      ).answer;
      expect(a.answerPath).toBe('tool');
      const ans = st.text.calls
        .slice(calls)
        .find((c) => /<data id="D1"/.test(c.user));
      expect(ans).toBeDefined();
      return ans!.user;
    };
    expect(
      body(
        await request(st.srv())
          .get(`/assist/sites/${S.siteId}/connectors/${connectorId}`)
          .set(st.as(S.ownerTg))
          .expect(200),
      ).maskPd,
    ).toBe(false);
    const open = await dataBlock();
    expect(open).toContain('olena.client@example.com');
    const on = await request(st.srv())
      .patch(`/assist/sites/${S.siteId}/connectors/${connectorId}`)
      .set(st.as(S.ownerTg))
      .send({ maskPd: true })
      .expect(200);
    expect(body(on).maskPd).toBe(true);
    try {
      const masked = await dataBlock();
      expect(masked).not.toContain('olena.client@example.com');
      expect(masked).not.toContain('671234567');
      expect(masked).toContain('5555');
    } finally {
      await request(st.srv())
        .patch(`/assist/sites/${S.siteId}/connectors/${connectorId}`)
        .set(st.as(S.ownerTg))
        .send({ maskPd: false })
        .expect(200);
    }
  });

  it('Р-З9-18: два одновременных перевыпуска секрета JWT с одним expectedSetAt — 200 и 409; действует показанный', async () => {
    const view = body(
      await request(st.srv())
        .get(`/assist/sites/${S.siteId}/admin-mode`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    const expectedSetAt = view.identitySecret.setAt;
    expect(expectedSetAt).toEqual(expect.any(String));
    const issue = (b: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
        .set(st.as(S.ownerTg))
        .send(b);
    const [r1, r2] = await Promise.all([
      issue({ expectedSetAt }),
      issue({ expectedSetAt }),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);
    const lost = r1.status === 409 ? r1 : r2;
    const won = r1.status === 200 ? r1 : r2;
    expect(JSON.stringify(lost.body)).toContain('ADMIN_SECRET_CHANGED');
    identitySecret = body(won).secret;
    // Показанный победителю секрет действует.
    await exchange(S.pk, 'emp-after-race').expect(200);
    // null «секрета не было» при выпущенном — тоже 409; старый setAt — 409.
    expect((await issue({ expectedSetAt: null })).status).toBe(409);
    expect((await issue({ expectedSetAt })).status).toBe(409);
    expect((await issue({ expectedSetAt: 'вчера' })).status).toBe(400);
    // Свежий setAt — 200 (обычный перевыпуск); без поля — как раньше.
    const ok = await issue({ expectedSetAt: body(won).setAt }).expect(200);
    const legacy = await issue({}).expect(200);
    expect(body(legacy).setAt > body(ok).setAt).toBe(true);
    identitySecret = body(legacy).secret;
  });

  it('Р-З9-18: секрет подписи коннектора — то же: первый выпуск (null) и гонка — ровно один', async () => {
    const path = `/assist/sites/${S.siteId}/connectors/${connectorId}/signing-secret`;
    const issue = (b: Record<string, unknown>) =>
      request(st.srv()).post(path).set(st.as(S.ownerTg)).send(b);
    const [a, b] = await Promise.all([
      issue({ expectedSetAt: null }),
      issue({ expectedSetAt: null }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? a : b;
    const row = await st.prisma.assistAdminConnector.findUniqueOrThrow({
      where: { id: connectorId },
    });
    expect(row.signSetAt?.toISOString()).toBe(body(won).setAt);
    expect((await issue({ expectedSetAt: body(won).setAt })).status).toBe(200);
  });

  it('Ш3-хвост (6): страницы обхода за логином → база «Админки» (поиск находит), в «Сайт» — ни строки', async () => {
    const job = await st.prisma.assistAdminCrawlJob.create({
      data: {
        accountId: S.accountId,
        siteId: S.siteId,
        hostId: S.adminHostId,
        testAccountId: 'ta-z9',
        status: 'running',
        requestedByTelegramId: S.ownerTg,
      },
    });
    const h = st.app.get(BrowserJobHandlers).get('assist-admin-crawl');
    expect(h?.onDone).toBeDefined();
    const hj: HandlerJob = {
      id: 'bj-z9',
      accountId: S.accountId,
      siteId: S.siteId,
      hostId: S.adminHostId,
      kind: 'admin-crawl',
      origin: 'assist-admin-crawl',
      refId: job.id,
      params: {} as HandlerJob['params'],
      testAccountId: 'ta-z9',
    };
    await h!.onDone!(hj, {
      loggedIn: true,
      pages: [
        {
          url: `https://${S.adminHost}/admin/returns`,
          title: 'Повернення CANARY-ADM',
          text: 'Кнопка: Оформити повернення CANARY-ADM\nколонка: Номер замовлення\nполе: Причина повернення',
        },
        {
          url: `https://${S.adminHost}/admin/orders`,
          title: 'Замовлення',
          text: 'колонка: Клієнт\nкнопка: Експорт',
        },
      ],
      refusedClicks: 0,
      skippedLinks: 0,
    });
    const crawlJob = await st.prisma.assistAdminCrawlJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(crawlJob.status).toBe('done');
    expect(crawlJob.note).toMatch(/^страниц: 2; в базе «Админки»: версия \d+/);
    const src = await st.prisma.assistAdminSource.findFirstOrThrow({
      where: { siteId: S.siteId, kind: 'crawl' },
    });
    expect(src.documentsCount).toBe(2);
    const chunks = await st.prisma.assistAdminChunk.findMany({
      where: { siteId: S.siteId, text: { contains: 'CANARY-ADM' } },
    });
    expect(chunks.length).toBeGreaterThan(0);
    const hits = await st.app.get(AdminKnowledgeService).search({
      siteId: S.siteId,
      query: 'Оформити повернення CANARY-ADM',
      limit: 6,
    });
    expect(hits.some((x) => x.text.includes('CANARY-ADM'))).toBe(true);
    // Канарейка «Админки» не уходит в знания «Сайта» (К-9).
    expect(
      await st.prisma.assistSiteChunk.count({
        where: { text: { contains: 'CANARY-ADM' } },
      }),
    ).toBe(0);
    // Повторный обход без страницы «Повернення» — она уходит и из базы.
    await h!.onDone!(hj, {
      loggedIn: true,
      pages: [
        {
          url: `https://${S.adminHost}/admin/orders`,
          title: 'Замовлення',
          text: 'колонка: Клієнт\nкнопка: Експорт',
        },
      ],
      refusedClicks: 0,
      skippedLinks: 0,
    });
    const live = await st.prisma.assistAdminDocument.findMany({
      where: { sourceId: src.id, status: 'active' },
      select: { ref: true },
    });
    expect(live.map((d) => d.ref)).toEqual([
      `https://${S.adminHost}/admin/orders`,
    ]);
  });

  describe('Р-З9-15: резерв хода до модели', () => {
    const chat = () => st.app.get(AdminChatService);
    let convId = '';
    const orig = st.text.generate.bind(st.text);

    afterEach(async () => {
      st.text.generate = orig;
      chat().env = process.env;
      if (convId) {
        await st.prisma.assistAdminConversation.deleteMany({
          where: { id: convId },
        });
        convId = '';
      }
    });

    it('параллельные ходы: при остатке на один ход второй — 429 до модели; резерв снят после хода', async () => {
      const est = 1_000_000;
      chat().turnEstimateMicroUsd = est;
      const cap = siteDailyCapFromPlan('business');
      // Факт дня: до потолка остаётся полтора хода.
      const conv = await st.prisma.assistAdminConversation.create({
        data: {
          accountId: S.accountId,
          siteId: S.siteId,
          employeeRef: 'jwt:budget-z9',
          channel: 'embed',
          lastActivityAt: new Date(),
        },
      });
      convId = conv.id;
      const spent =
        (await adminSpentToday(
          st.app.get(SitesDb).forAccount(S.accountId),
          S.siteId,
          new Date(),
        )) + (await adminBudgetRowMicroUsd(st.prisma, S.siteId, new Date()));
      await st.prisma.assistAdminMessage.create({
        data: {
          accountId: S.accountId,
          siteId: S.siteId,
          conversationId: conv.id,
          role: 'assistant',
          text: 'дорогий хід',
          flags: [],
          costMicroUsd: cap - spent - Math.round(est * 1.5),
        },
      });
      // Модель отвечает медленно — оба хода в полёте одновременно.
      st.text.generate = async (
        req: GenerateRequest,
      ): Promise<GenerateResult> => {
        await new Promise((r) => setTimeout(r, 400));
        return orig(req);
      };
      const s1 = body(await exchange(S.pk, 'emp-budget-1').expect(200)).session;
      const s2 = body(await exchange(S.pk, 'emp-budget-2').expect(200)).session;
      const [a, b] = await Promise.all([
        ask(s1, 'Як оформити повернення?'),
        ask(s2, 'Як оформити повернення?'),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 429]);
      expect(JSON.stringify((a.status === 429 ? a : b).body)).toContain(
        'ADMIN_DAILY_BUDGET',
      );
      const row = await st.prisma.assistBudgetDay.findUniqueOrThrow({
        where: {
          scope_key_day: {
            scope: ADMIN_BUDGET_SCOPE,
            key: S.siteId,
            day: new Date().toISOString().slice(0, 10),
          },
        },
      });
      expect(Number(row.reservedMicroUsd)).toBe(0);
    });

    it('аудит C (P3-1): сбой хода после начала — резерв не висит: оценка перенесена в spent строки «Админки»', async () => {
      const est = 777_000;
      chat().turnEstimateMicroUsd = est;
      const day = new Date().toISOString().slice(0, 10);
      const row = () =>
        st.prisma.assistBudgetDay.findUnique({
          where: {
            scope_key_day: { scope: ADMIN_BUDGET_SCOPE, key: S.siteId, day },
          },
        });
      const before = await row();
      st.text.generate = async () => {
        throw new Error('сеть оборвалась посреди хода');
      };
      const s = body(await exchange(S.pk, 'emp-crash').expect(200)).session;
      const r = await ask(s, 'Як оформити повернення?');
      expect(r.status).toBe(500);
      const after = await row();
      expect(Number(after!.reservedMicroUsd)).toBe(
        Number(before?.reservedMicroUsd ?? 0),
      );
      expect(Number(after!.spentMicroUsd)).toBe(
        Number(before?.spentMicroUsd ?? 0) + est,
      );
    });

    it('аудит C (P3-2): факт дня читается ВНУТРИ резерва (под блокировкой строки), а не до транзакции', async () => {
      const now = new Date();
      const est = 50_000;
      // Факт дня ненулевой: ответ сотрудника с ценой (в тот же день).
      const conv = await st.prisma.assistAdminConversation.create({
        data: {
          accountId: S.accountId,
          siteId: S.siteId,
          employeeRef: 'jwt:fact-z9',
          channel: 'embed',
          lastActivityAt: now,
        },
      });
      convId = conv.id;
      await st.prisma.assistAdminMessage.create({
        data: {
          accountId: S.accountId,
          siteId: S.siteId,
          conversationId: conv.id,
          role: 'assistant',
          text: 'хід із ціною',
          flags: [],
          costMicroUsd: 120_000,
        },
      });
      const fact = await adminSpentToday(
        st.app.get(SitesDb).forAccount(S.accountId),
        S.siteId,
        now,
      );
      const rowNow = await adminBudgetRowMicroUsd(st.prisma, S.siteId, now);
      expect(fact).toBeGreaterThanOrEqual(120_000);
      const base = fact + rowNow + est;
      const tight = await reserveAdminTurn(st.prisma, {
        siteId: S.siteId,
        siteCapMicroUsd: base - 1,
        platformCapMicroUsd: Number.MAX_SAFE_INTEGER,
        estMicroUsd: est,
        now,
      });
      expect(tight).toEqual({ ok: false, denied: 'site' });
      const ok = await reserveAdminTurn(st.prisma, {
        siteId: S.siteId,
        siteCapMicroUsd: base,
        platformCapMicroUsd: Number.MAX_SAFE_INTEGER,
        estMicroUsd: est,
        now,
      });
      expect(ok.ok).toBe(true);
      if (ok.ok) await settleAdminTurn(st.prisma, ok.reservation, 0);
      expect(await adminBudgetRowMicroUsd(st.prisma, S.siteId, now)).toBe(
        rowNow,
      );
    });

    it('потолок платформы покрывает «Админку»: 0 $ у платформы — 429 без вызова модели', async () => {
      chat().turnEstimateMicroUsd = 1_000;
      chat().env = {
        ...process.env,
        ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD: '0',
      };
      const s = body(await exchange(S.pk, 'emp-platform').expect(200)).session;
      const calls = st.text.calls.length;
      const r = await ask(s, 'Як оформити повернення?');
      expect(r.status).toBe(429);
      expect(st.text.calls.length).toBe(calls);
    });
  });
});
