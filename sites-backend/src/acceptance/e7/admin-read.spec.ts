/**
 * Приёмка Э7 «Админка: чтение» по HTTP на НАСТОЯЩЕМ Postgres (план,
 * «Приёмка Э7»; ТЗ §5, §4-бис.10 п.8, §4-тер.15 п.15):
 *  1. JWT с чужой подписью / истёкший / с `aud` другого сайта — отказ;
 *  2. `read` к хосту вне `allowedHosts` — отказ (без сети);
 *  3. секрет коннектора не встречается ни в журнале, ни в логах, ни в
 *     промпте, ни в ответах API кабинета (маркерная строка-секрет; API
 *     заказчика ещё и возвращает его эхом);
 *  4. API заказчика 5xx — честный ответ без выдуманных данных;
 *  5. смена сотрудника (sub A → sub B) — ни одного сообщения A у B;
 *  6. права «Админки» на всех маршрутах (`assistAdmin`), 7a в TMA,
 *     импорт/классификация OpenAPI, тариф, хост, журнал только
 *     дописывается, очередь обучения публикует только owner, обход за
 *     логином — задание ждёт воркер Ш3.
 */
import * as request from 'supertest';
import { signEmployeeJwt } from '../../modules/assist-admin-mode/identity-jwt';
import {
  ADMIN_SESSION_HEADER,
  WIDGET_ADMIN_ORIGIN_DEFAULT,
  WIDGET_ORIGIN_DEFAULT,
  WIDGET_PK_LIVE_PREFIX,
} from '../../brand';
import { describeE7, E7Stack, shopSpec, type E7Site } from './e7-stack';

jest.setTimeout(120_000);

const MARKER = 'MARKER-SECRET-e7-9f1c2a7b5d';

describeE7('Э7 «Админка: чтение» — приёмка по HTTP', () => {
  const st = new E7Stack();
  let S: E7Site;
  let identitySecret = '';
  let connectorId = '';
  const hits = () => st.net.hits;

  const jwt = (over: Record<string, unknown> = {}, secret = identitySecret) => {
    const t = Math.floor(Date.now() / 1000);
    return signEmployeeJwt(
      {
        sub: 'emp-A',
        role: 'manager',
        name: 'Оля',
        aud: S.siteId,
        iat: t,
        exp: t + 600,
        ...over,
      },
      secret,
    );
  };
  async function session(over: Record<string, unknown> = {}): Promise<string> {
    const r = await request(st.srv())
      .post('/assist-admin/v1/session')
      .send({ pk: S.pk, jwt: jwt(over) })
      .expect(200);
    return r.body.data?.session ?? r.body.session;
  }
  const body = (r: request.Response) => r.body.data ?? r.body;

  beforeAll(async () => {
    await st.init();
    S = await st.site();
    st.net.site(S.apiHost, {
      '/openapi.json': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: shopSpec(S.apiHost),
      },
      '/v1/orders/1042': (req) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: '1042',
          status: 'shipped',
          total: 1290,
          ttn: '20450012345678',
          // API эхом возвращает ключ — модель его увидеть не должна.
          debugAuth: req.headers.authorization,
        }),
      }),
      '/v1/orders/777': { status: 503, body: 'upstream down' },
    });
    await st.adminDocument(S, {
      ref: 'regl-returns',
      title: 'Регламент повернень',
      paragraphs: [
        'Повернення оформлює менеджер у розділі Замовлення → Повернення протягом 14 днів.',
        'Внутрішня знижка для оптових клієнтів становить 37 відсотків, погоджує керівник.',
      ],
    });
  });

  afterAll(() => st.close());

  it('права: менеджер/оператор «Сайта» и сотрудник «Админки» — 403 на кабинет «Админки»', async () => {
    const manager = await st.member(S, 'manager', { assist: 'manager' });
    const employee = await st.member(S, 'operator', {
      assistAdmin: 'employee',
    });
    for (const [method, path] of [
      ['get', `/assist/sites/${S.siteId}/admin-mode`],
      ['get', `/assist/sites/${S.siteId}/connectors`],
      ['get', `/assist/sites/${S.siteId}/action-log`],
      ['get', `/assist/sites/${S.siteId}/admin-mode/stats`],
      ['get', `/assist/sites/${S.siteId}/learning/admin/queue`],
      ['get', `/assist/sites/${S.siteId}/admin-mode/private-crawl`],
    ] as const) {
      for (const who of [manager, employee]) {
        await request(st.srv())[method](path).set(st.as(who)).expect(403);
      }
    }
    // Менеджер «Сайта» не открывает и чат сотрудника (TMA).
    await request(st.srv())
      .get(`/assist/sites/${S.siteId}/admin-chat/state`)
      .set(st.as(manager))
      .expect(403);
  });

  it('тариф без «Админки» — 402; включение с хостом админки и способом both', async () => {
    const T = await st.site({ plan: 'start' });
    await request(st.srv())
      .patch(`/assist/sites/${T.siteId}/admin-mode`)
      .set(st.as(T.ownerTg))
      .send({ enabled: true })
      .expect(402);
    const r = await request(st.srv())
      .patch(`/assist/sites/${S.siteId}/admin-mode`)
      .set(st.as(S.ownerTg))
      .send({
        enabled: true,
        access: 'both',
        adminHostIds: [S.adminHostId],
        roleMap: { manager: 'orders' },
        instructions: 'Відповідай коротко.',
      })
      .expect(200);
    expect(body(r)).toMatchObject({
      enabled: true,
      access: 'both',
      roleMap: { manager: 'orders' },
    });
    expect(body(r).snippet.tag).toContain('data-mode="admin"');
    expect(body(r).snippet.tag).toContain(
      'https://wa.e7.example.com/v1/loader.js',
    );
    // Чужой (не этого сайта) хост — отказ.
    await request(st.srv())
      .patch(`/assist/sites/${S.siteId}/admin-mode`)
      .set(st.as(S.ownerTg))
      .send({ adminHostIds: [T.adminHostId] })
      .expect(400);
  });

  it('секрет подписи JWT: показан один раз, в базе — шифротекст', async () => {
    const r = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
      .set(st.as(S.ownerTg))
      .expect(200);
    identitySecret = body(r).secret;
    expect(identitySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const view = await request(st.srv())
      .get(`/assist/sites/${S.siteId}/admin-mode`)
      .set(st.as(S.ownerTg))
      .expect(200);
    expect(JSON.stringify(view.body)).not.toContain(identitySecret);
    expect(body(view).identitySecret.set).toBe(true);
    const row = await st.prisma.assistAdminSettings.findFirstOrThrow({
      where: { siteId: S.siteId },
    });
    expect(row.identitySecretEnc).toMatch(/^as1\.v1\./);
    expect(row.identitySecretEnc).not.toContain(identitySecret);
  });

  it('приёмка 1: JWT с чужой подписью / истёкший / с aud другого сайта / alg none — 401', async () => {
    const t = Math.floor(Date.now() / 1000);
    const bad = [
      signEmployeeJwt(
        { sub: 'x', aud: S.siteId, iat: t, exp: t + 600 },
        'чужой-секрет',
      ),
      jwt({ iat: t - 1800, exp: t - 900 }),
      jwt({ aud: 'other-site-id' }),
      jwt({ exp: t + 3600 }),
      signEmployeeJwt(
        { sub: 'x', aud: S.siteId, iat: t, exp: t + 600 },
        identitySecret,
        { alg: 'none' },
      ),
    ];
    for (const token of bad) {
      const r = await request(st.srv())
        .post('/assist-admin/v1/session')
        .send({ pk: S.pk, jwt: token })
        .expect(401);
      expect(JSON.stringify(r.body)).toMatch(/ADMIN_IDENTITY_REJECTED/);
      expect(JSON.stringify(r.body)).not.toContain(token.slice(0, 30));
    }
    // Правильный — сессия.
    expect(await session()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Сессия без заголовка / мусорная — 401.
    await request(st.srv()).get('/assist-admin/v1/state').expect(401);
    await request(st.srv())
      .get('/assist-admin/v1/state')
      .set(ADMIN_SESSION_HEADER, 'x'.repeat(43))
      .expect(401);
  });

  it('CORS: POST из iframe «Админки» (Origin wa.) не отвергается; origin публичного виджета — без CORS', async () => {
    const r = await request(st.srv())
      .post('/assist-admin/v1/session')
      .set('Origin', WIDGET_ADMIN_ORIGIN_DEFAULT)
      .send({ pk: S.pk, jwt: jwt() })
      .expect(200);
    expect(r.headers['access-control-allow-origin']).toBe(
      WIDGET_ADMIN_ORIGIN_DEFAULT,
    );
    const pub = await request(st.srv())
      .post('/assist-admin/v1/session')
      .set('Origin', WIDGET_ORIGIN_DEFAULT)
      .send({ pk: S.pk, jwt: jwt() });
    expect(pub.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('коннектор: импорт OpenAPI по URL, автоклассификация, класс не опускается, write без «Админка: действия» (Pro) не включается', async () => {
    const r = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/connectors`)
      .set(st.as(S.ownerTg))
      .send({ name: 'shop', specUrl: `https://${S.apiHost}/openapi.json` })
      .expect(201);
    const c = body(r);
    connectorId = c.id;
    expect(c.allowedHosts).toEqual([S.apiHost]);
    expect(c.hostVerified).toBe(true);
    const kinds = Object.fromEntries(
      c.operations.map((o: { operationId: string; autoKind: string }) => [
        o.operationId,
        o.autoKind,
      ]),
    );
    expect(kinds).toEqual({
      listOrders: 'read',
      createOrder: 'write',
      getOrder: 'read',
      deleteOrder: 'danger',
      refundOrder: 'danger',
    });
    expect(c.operations.every((o: { enabled: boolean }) => !o.enabled)).toBe(
      true,
    );
    const base = `/assist/sites/${S.siteId}/connectors/${connectorId}/operations`;
    await request(st.srv())
      .patch(`${base}/createOrder`)
      .set(st.as(S.ownerTg))
      .send({ kind: 'read' })
      .expect(409);
    // Э8: write/danger включаются только в тарифе с «Админка: действия»
    // (Pro); на Business — 402 (было 409 «следующий этап» в Э7).
    const pro = await request(st.srv())
      .patch(`${base}/createOrder`)
      .set(st.as(S.ownerTg))
      .send({ enabled: true })
      .expect(402);
    expect(JSON.stringify(pro.body)).toMatch(/ADMIN_ACTIONS_PLAN/);
    await request(st.srv())
      .patch(`${base}/listOrders`)
      .set(st.as(S.ownerTg))
      .send({ kind: 'write' })
      .expect(200);
    const ok = await request(st.srv())
      .patch(`${base}/getOrder`)
      .set(st.as(S.ownerTg))
      .send({ enabled: true, roles: ['orders'], dailyLimit: 100 })
      .expect(200);
    expect(body(ok)).toMatchObject({
      enabled: true,
      kind: 'read',
      roles: ['orders'],
    });
    // Хост API не подтверждён и нет отметки SaaS — отказ.
    st.net.site('saas.polygon.example', {
      '/openapi.json': { status: 200, body: shopSpec('saas.polygon.example') },
    });
    await request(st.srv())
      .post(`/assist/sites/${S.siteId}/connectors`)
      .set(st.as(S.ownerTg))
      .send({
        name: 'saas',
        specUrl: 'https://saas.polygon.example/openapi.json',
      })
      .expect(409);
  });

  it('приёмка 3: секрет — только «••••хвост»; нет в ответах, журнале, логах, промпте', async () => {
    const r = await request(st.srv())
      .put(`/assist/sites/${S.siteId}/connectors/${connectorId}/secret`)
      .set(st.as(S.ownerTg))
      .send({ authKind: 'bearer', secret: MARKER })
      .expect(200);
    expect(JSON.stringify(r.body)).not.toContain(MARKER);
    expect(body(r).secret).toMatchObject({ set: true, tail: MARKER.slice(-4) });
    const row = await st.prisma.assistAdminConnector.findUniqueOrThrow({
      where: { id: connectorId },
    });
    expect(row.secretEnc).not.toContain(MARKER);

    const sess = await session();
    const ans = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({
        text: 'Який статус замовлення 1042?',
        clientRequestId: 'req-00000001',
      })
      .expect(200);
    const a = body(ans).answer;
    expect(a.answerPath).toBe('tool');
    expect(a.text).toContain('shipped');
    expect(a.tools).toEqual([
      { operation: 'shop.getOrder', outcome: 'ok', httpStatus: 200 },
    ]);
    // API получил секрет в заголовке (вызов был настоящим)…
    expect(hits()).toContain(`${S.apiHost}/v1/orders/1042`);
    // …но маркера нет нигде на нашей стороне.
    expect(JSON.stringify(ans.body)).not.toContain(MARKER);
    for (const c of st.text.calls) {
      expect(c.system + c.user).not.toContain(MARKER);
    }
    expect(st.text.calls.some((c) => c.user.includes('shipped'))).toBe(true);
    const log = await st.prisma.assistAdminActionLog.findMany({
      where: { siteId: S.siteId },
    });
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(log)).not.toContain(MARKER);
    expect(log[0]).toMatchObject({
      actor: 'jwt:emp-A',
      outcome: 'ok',
      operation: 'shop.getOrder',
      httpStatus: 200,
    });
    const msgs = await st.prisma.assistAdminMessage.findMany({
      where: { siteId: S.siteId },
    });
    expect(JSON.stringify(msgs)).not.toContain(MARKER);
    expect(st.logs.lines.join('\n')).not.toContain(MARKER);
    // Журнал в кабинете — без секрета.
    const lr = await request(st.srv())
      .get(`/assist/sites/${S.siteId}/action-log`)
      .set(st.as(S.ownerTg))
      .expect(200);
    expect(JSON.stringify(lr.body)).not.toContain(MARKER);
    // Повтор того же clientRequestId — тот же ответ без модели.
    const calls = st.text.calls.length;
    const again = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({
        text: 'Який статус замовлення 1042?',
        clientRequestId: 'req-00000001',
      })
      .expect(200);
    expect(body(again).answer.id).toBe(a.id);
    expect(st.text.calls.length).toBe(calls);
  });

  it('приёмка 4: API заказчика 5xx — честный ответ, без выдуманных данных, без модели ответа', async () => {
    const sess = await session();
    const before = hits().filter(
      (h) => h === `${S.apiHost}/v1/orders/777`,
    ).length;
    const calls = st.text.calls.length;
    const r = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text: 'Що з замовленням 777?' })
      .expect(200);
    const a = body(r).answer;
    expect(a.answerPath).toBe('error');
    expect(a.text).toMatch(/не відповідає|не отвечает/);
    // Ни одной цифры, кроме номера из вопроса.
    expect(
      (a.text.match(/\d+/g) ?? []).filter((n: string) => n !== '777'),
    ).toEqual([]);
    expect(
      hits().filter((h) => h === `${S.apiHost}/v1/orders/777`).length - before,
    ).toBe(2);
    // После сбоя модель ответа не вызывалась (только план).
    expect(
      st.text.calls.slice(calls).every((c) => /планувальник/.test(c.system)),
    ).toBe(true);
    const item = await st.prisma.assistAdminLearningItem.findFirst({
      where: { siteId: S.siteId, kind: 'tool_failure' },
    });
    expect(item).not.toBeNull();
  });

  it('приёмка 2: read к хосту вне allowedHosts — отказ без сети', async () => {
    await st.prisma.assistAdminConnector.update({
      where: { id: connectorId },
      data: { baseUrl: 'https://evil.ssrf.example/v1' },
    });
    st.net.site('evil.ssrf.example', {
      '/v1/orders/1042': { status: 200, body: '{}' },
    });
    const sess = await session();
    const r = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text: 'Статус замовлення 1042' })
      .expect(200);
    expect(body(r).answer.answerPath).toBe('error');
    expect(hits()).not.toContain('evil.ssrf.example/v1/orders/1042');
    const last = await st.prisma.assistAdminActionLog.findFirst({
      where: { siteId: S.siteId },
      orderBy: { at: 'desc' },
    });
    expect(last).toMatchObject({
      outcome: 'blocked',
      error: 'host_not_allowed',
    });
    await st.prisma.assistAdminConnector.update({
      where: { id: connectorId },
      data: { baseUrl: `https://${S.apiHost}/v1` },
    });
  });

  it('роль без карты — только знания; знания «Админки» отвечают сотруднику', async () => {
    const t = Math.floor(Date.now() / 1000);
    const r0 = await request(st.srv())
      .post('/assist-admin/v1/session')
      .send({
        pk: S.pk,
        jwt: jwt({ sub: 'emp-K', role: 'courier', iat: t, exp: t + 600 }),
      })
      .expect(200);
    const sess = body(r0).session;
    const before = hits().length;
    const r = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text: 'Як оформити повернення? Замовлення 1042' })
      .expect(200);
    expect(body(r).answer.answerPath).toBe('knowledge');
    expect(body(r).answer.text).toMatch(/Повернення/);
    expect(hits().length).toBe(before);
  });

  it('§4-бис.10 п.8: смена сотрудника A → B — ни одного сообщения A у B', async () => {
    const a = await session({ sub: 'emp-A' });
    const stateA = body(
      await request(st.srv())
        .get('/assist-admin/v1/state')
        .set(ADMIN_SESSION_HEADER, a)
        .expect(200),
    );
    expect(stateA.messages.length).toBeGreaterThan(0);
    const b = await session({ sub: 'emp-B' });
    const stateB = body(
      await request(st.srv())
        .get('/assist-admin/v1/state')
        .set(ADMIN_SESSION_HEADER, b)
        .expect(200),
    );
    expect(stateB.messages).toEqual([]);
    const idsA = new Set(stateA.messages.map((m: { id: string }) => m.id));
    // Оценить чужое сообщение нельзя.
    const foreign = [...idsA][1] as string;
    await request(st.srv())
      .post(`/assist-admin/v1/messages/${foreign}/feedback`)
      .set(ADMIN_SESSION_HEADER, b)
      .send({ rating: -1 })
      .expect(404);
  });

  it('очередь обучения (контур (г)): 👎 + «правильно так» сотрудника → кандидат; публикует только owner', async () => {
    const sess = await session({ sub: 'emp-C' });
    const r = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text: 'Хто погоджує знижку для оптових клієнтів?' })
      .expect(200);
    const mid = body(r).answer.id;
    await request(st.srv())
      .post(`/assist-admin/v1/messages/${mid}/feedback`)
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ rating: -1, correction: 'Знижку погоджує комерційний директор.' })
      .expect(200);
    const q = await request(st.srv())
      .get(`/assist/sites/${S.siteId}/learning/admin/queue`)
      .set(st.as(S.ownerTg))
      .expect(200);
    const fix = body(q).find(
      (x: { kind: string }) => x.kind === 'employee_fix',
    );
    expect(fix).toMatchObject({
      proposedAnswer: 'Знижку погоджує комерційний директор.',
    });
    const employee = await st.member(S, 'operator', {
      assistAdmin: 'employee',
    });
    await request(st.srv())
      .post(`/assist/sites/${S.siteId}/learning/admin/queue/${fix.id}/accept`)
      .set(st.as(employee))
      .send({ answer: 'x' })
      .expect(403);
    const acc = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/learning/admin/queue/${fix.id}/accept`)
      .set(st.as(S.ownerTg))
      .send({ answer: fix.proposedAnswer })
      .expect(200);
    const faq = await st.prisma.assistAdminFaq.findUniqueOrThrow({
      where: { id: body(acc).faqId },
    });
    expect(faq.origin).toBe('golden');
  });

  it('7a: участник с assistAdmin: employee — чат в TMA (только знания без роли); тариф/режим проверяются', async () => {
    const employee = await st.member(S, 'operator', {
      assistAdmin: 'employee',
    });
    const before = hits().length;
    const r = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/admin-chat`)
      .set(st.as(employee))
      .send({ text: 'Статус замовлення 1042?' })
      .expect(200);
    expect(['knowledge', 'refused']).toContain(body(r).answer.answerPath);
    expect(hits().length).toBe(before);
    const owner = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/admin-chat`)
      .set(st.as(S.ownerTg))
      .send({ text: 'Статус замовлення 1042?' })
      .expect(200);
    expect(body(owner).answer.answerPath).toBe('tool');
    const log = await st.prisma.assistAdminActionLog.findFirst({
      where: { siteId: S.siteId, channel: 'tma' },
    });
    expect(log?.actor).toBe(`tg:${S.ownerTg}`);
  });

  it('iframe «Админки»: frame-ancestors — только хосты админки; чужой pk — none', async () => {
    const r = await request(st.srv())
      .get(`/wa/v1/frame?pk=${S.pk}`)
      .expect(200);
    const csp = r.headers['content-security-policy'];
    expect(csp).toContain(`frame-ancestors https://${S.adminHost}`);
    expect(csp).not.toContain(S.host);
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(r.text).toContain('/v1/admin-chat.js');
    const n = await request(st.srv())
      .get(`/wa/v1/frame?pk=${WIDGET_PK_LIVE_PREFIX}nope0000000000`)
      .expect(200);
    expect(n.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
  });

  it('журнал вызовов только дописывается; цепочка хешей цела', async () => {
    await expect(
      st.prisma.$executeRawUnsafe(
        `UPDATE "sites"."assist_admin_action_log" SET "outcome" = 'ok' WHERE "siteId" = $1`,
        S.siteId,
      ),
    ).rejects.toThrow(/только дописывается|42501/);
    await expect(
      st.prisma.$executeRawUnsafe(
        `DELETE FROM "sites"."assist_admin_action_log" WHERE "siteId" = $1`,
        S.siteId,
      ),
    ).rejects.toThrow(/только дописывается|42501/);
    const { AdminActionLogService } =
      await import('../../modules/assist-admin-mode/action-log.service');
    expect(
      await st.app
        .get(AdminActionLogService)
        .verifyChain(S.accountId, S.siteId),
    ).toBe(-1);
  });

  it('401 от API — коннектор на паузу (auth_failed), новый секрет снимает', async () => {
    st.net.site(S.apiHost, { '/v1/orders/401': { status: 401, body: '{}' } });
    const sess = await session({ sub: 'emp-D' });
    const r = await request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text: 'Статус замовлення 401' })
      .expect(200);
    expect(body(r).answer.text).toMatch(/ключ API/);
    const c = await st.prisma.assistAdminConnector.findUniqueOrThrow({
      where: { id: connectorId },
    });
    expect(c.status).toBe('auth_failed');
    await request(st.srv())
      .put(`/assist/sites/${S.siteId}/connectors/${connectorId}/secret`)
      .set(st.as(S.ownerTg))
      .send({ authKind: 'bearer', secret: `${MARKER}-v2` })
      .expect(200);
    const c2 = await st.prisma.assistAdminConnector.findUniqueOrThrow({
      where: { id: connectorId },
    });
    expect(c2.status).toBe('active');
  });

  it('статистика (сотрудники): агрегаты по ролям, без разреза по сотруднику по умолчанию', async () => {
    const r = await request(st.srv())
      .get(`/assist/sites/${S.siteId}/admin-mode/stats?days=7`)
      .set(st.as(S.ownerTg))
      .expect(200);
    const v = body(r);
    expect(v.questions).toBeGreaterThan(0);
    expect(v.byEmployee).toBeNull();
    expect(
      v.tools.find(
        (t: { operation: string }) => t.operation === 'shop.getOrder',
      ).ok,
    ).toBeGreaterThan(0);
  });

  it('обход за логином: только verified-хост и учётка реестра Ш2; задание ждёт воркер Ш3', async () => {
    const acc = await st.prisma.siteTestAccount.create({
      data: {
        accountId: S.accountId,
        siteId: S.siteId,
        label: 'Тестовий менеджер',
        loginMethod: 'password',
        hostIds: [S.adminHostId],
        products: ['qa'],
        createdBy: 'tma',
        confirmedTestAccountAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    await request(st.srv())
      .put(`/assist/sites/${S.siteId}/admin-mode/private-crawl`)
      .set(st.as(S.ownerTg))
      .send({ enabled: true, hostId: S.siteHostId, testAccountId: acc.id })
      .expect(409);
    const r = await request(st.srv())
      .put(`/assist/sites/${S.siteId}/admin-mode/private-crawl`)
      .set(st.as(S.ownerTg))
      .send({
        enabled: true,
        hostId: S.adminHostId,
        testAccountId: acc.id,
        startPath: '/admin',
      })
      .expect(200);
    expect(body(r)).toMatchObject({ enabled: true, worker: 'waiting_sh3' });
    const run = await request(st.srv())
      .post(`/assist/sites/${S.siteId}/admin-mode/private-crawl/run`)
      .set(st.as(S.ownerTg))
      .expect(200);
    expect(body(run)).toMatchObject({
      status: 'waiting_worker',
      worker: 'waiting_sh3',
    });
    // Никакой сети к хосту админки: браузер на сервере не запускается.
    expect(hits().some((h) => h.startsWith(S.adminHost))).toBe(false);
  });

  it('аудит Э7: TRUNCATE журнала — отказ; класс не опустить даже прямым UPDATE (Э8: write включается — исполняет только «Да»)', async () => {
    await expect(
      st.prisma.$executeRawUnsafe(`TRUNCATE "sites"."assist_admin_action_log"`),
    ).rejects.toThrow(/только дописывается|42501/);
    expect(
      await st.prisma.assistAdminActionLog.count({
        where: { siteId: S.siteId },
      }),
    ).toBeGreaterThan(0);
    const op = await st.prisma.assistAdminOperation.findFirstOrThrow({
      where: { connectorId, operationId: 'createOrder' },
    });
    await expect(
      st.prisma.$executeRawUnsafe(
        `UPDATE "sites"."assist_admin_operations" SET "kind" = 'read' WHERE "id" = $1`,
        op.id,
      ),
    ).rejects.toThrow(/класс нельзя опустить/);
    // Э8 (миграция …_assist_admin_actions) сняла «включается только read»:
    // включённая write исполняется только предложением и «Да» (acceptance/e8).
    await expect(
      st.prisma.$executeRawUnsafe(
        `UPDATE "sites"."assist_admin_operations" SET "enabled" = true WHERE "id" = $1`,
        op.id,
      ),
    ).resolves.toBe(1);
    await st.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_admin_operations" SET "enabled" = false WHERE "id" = $1`,
      op.id,
    );
  });

  it('аудит Э7: служебное имя заголовка ключа, CR/LF в ключе, «//хост» в пути обхода — 400', async () => {
    const sec = `/assist/sites/${S.siteId}/connectors/${connectorId}/secret`;
    for (const headerName of [
      'Host',
      'Content-Length',
      'Proxy-Authorization',
    ]) {
      await request(st.srv())
        .put(sec)
        .set(st.as(S.ownerTg))
        .send({ authKind: 'header', headerName, secret: `${MARKER}-h` })
        .expect(400);
    }
    await request(st.srv())
      .put(sec)
      .set(st.as(S.ownerTg))
      .send({ authKind: 'bearer', secret: `${MARKER}\r\nX-Evil: 1` })
      .expect(400);
    for (const startPath of ['//evil.example/', '/\\evil.example/']) {
      await request(st.srv())
        .put(`/assist/sites/${S.siteId}/admin-mode/private-crawl`)
        .set(st.as(S.ownerTg))
        .send({ enabled: false, startPath })
        .expect(400);
    }
  });

  it('аудит Э7: суточный денежный потолок «Админки» — 429 до модели', async () => {
    const conv = await st.prisma.assistAdminConversation.create({
      data: {
        accountId: S.accountId,
        siteId: S.siteId,
        employeeRef: 'jwt:budget-probe',
        channel: 'embed',
        lastActivityAt: new Date(),
      },
    });
    await st.prisma.assistAdminMessage.create({
      data: {
        accountId: S.accountId,
        siteId: S.siteId,
        conversationId: conv.id,
        role: 'assistant',
        text: 'дорогий хід',
        flags: [],
        costMicroUsd: 2_000_000_000,
      },
    });
    try {
      const sess = await session({ sub: 'emp-budget' });
      const calls = st.text.calls.length;
      const r = await request(st.srv())
        .post('/assist-admin/v1/chat')
        .set(ADMIN_SESSION_HEADER, sess)
        .send({ text: 'Статус замовлення 1042' })
        .expect(429);
      expect(JSON.stringify(r.body)).toContain('ADMIN_DAILY_BUDGET');
      expect(st.text.calls.length).toBe(calls);
    } finally {
      await st.prisma.assistAdminConversation.delete({
        where: { id: conv.id },
      });
    }
  });

  it('выключили режим — сессии и чат отвечают 403; секрет перевыпущен — старые сессии гаснут', async () => {
    const sess = await session({ sub: 'emp-E' });
    await request(st.srv())
      .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
      .set(st.as(S.ownerTg))
      .expect(200);
    await request(st.srv())
      .get('/assist-admin/v1/state')
      .set(ADMIN_SESSION_HEADER, sess)
      .expect(401);
    await request(st.srv())
      .patch(`/assist/sites/${S.siteId}/admin-mode`)
      .set(st.as(S.ownerTg))
      .send({ enabled: false })
      .expect(200);
    await request(st.srv())
      .post('/assist-admin/v1/session')
      .send({ pk: S.pk, jwt: jwt() })
      .expect(403);
  });
});
