/**
 * Приёмка аудита 06.10.2026 — мемо «Админки» АМ-N: сухой прогон перед
 * публикацией и «требует проверки» (ТЗ §5-бис.17 п.7, п.8, п.10, п.13):
 *  - публикация без успешного прогона ТЕКУЩЕЙ версии — 409
 *    `MEMO_CHECK_REQUIRED`; `fail` прогона — версия `held`;
 *  - прогон — в браузере владельца по ссылке мастера (`admin-vc`): шаги на
 *    странице проверяются по снимку кодом (ядро прогона «Сайта»), шаги
 *    `api` (чтение и write) НЕ исполняются — 0 запросов к API, 0
 *    предложений, 0 запусков; права роли проверяющего — на каждую операцию;
 *  - ссылка прогона — не тестовая сессия голосового управления (план,
 *    разбор, отчёт мастера ею не открываются; в отчётах мастера её нет);
 *  - монитор: сбои/`pinMismatch` у ≥ 3 разных сотрудников за 7 дней или
 *    цель < 60% на ≥ 10 запусках → `needs_review` с причиной; в бою мемо не
 *    исполняется; статистика — в ответе API для TMA.
 */
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER, WIDGET_VOICE_TEST_PARAM } from '../../brand';
import { AdminMemoMonitorService } from '../../modules/assist-admin-actions/admin-memo-monitor.service';
import { AdminActionsNotifier } from '../../modules/assist-admin-actions/action-notifier';
import { AssistAdminRetentionController } from '../../modules/assist-admin-chat/cron/assist-admin-retention.controller';
import { serializeDbTests } from '../../prisma/serial-lock.testing';
import {
  AdminVoiceStack,
  api,
  data,
  dryRunMemo,
  employeeSession,
  orderPage,
  readySite,
  type Ready,
} from '../e6b-admin/admin-voice-stack';
import { ShopApi, describeE8 } from './e8-stack';

jest.setTimeout(180_000);

describeE8('аудит 06.10 — мемо «Админки»: прогон и «требует проверки»', () => {
  serializeDbTests('admin-memo-monitor');
  const st = new AdminVoiceStack();
  const shop = new ShopApi();
  let M: Ready;
  const memos = () => `/assist/sites/${M.S.siteId}/admin-mode/memos`;
  const owner = () => st.as(M.S.ownerTg);
  const apiCalls = () =>
    st.net.requests.filter((q) => q.key.startsWith(M.S.apiHost)).length;

  const uiMemo = (name = 'Клієнти і відвантаження') => ({
    names: { uk: name },
    triggers: { uk: [name.toLowerCase()] },
    goal: { text: { uk: 'Відкрито клієнтів, замовлення відвантажено' } },
    slots: [{ name: 'order', kind: 'number' }],
    steps: [
      {
        action: 'ui',
        kind: 'navigate',
        target: { text: 'Клієнти', role: 'link' },
      },
      { action: 'api', op: M.ops.getOrder, args: { id: { slot: 'order' } } },
      {
        action: 'api',
        op: M.ops.updateOrderStatus,
        args: { id: { slot: 'order' }, status: { const: 'shipped' } },
      },
    ],
  });
  const readMemo = (name: string) => ({
    names: { uk: name },
    triggers: { uk: [name.toLowerCase()] },
    goal: { text: { uk: 'Замовлення прочитано' } },
    slots: [{ name: 'order', kind: 'number' }],
    steps: [
      { action: 'api', op: M.ops.getOrder, args: { id: { slot: 'order' } } },
    ],
  });

  async function create(draft: Record<string, unknown>): Promise<number> {
    const r = data(
      await request(st.srv())
        .post(memos())
        .set(owner())
        .send({ draft })
        .expect(201),
    );
    return r.number as number;
  }
  async function build(n: number): Promise<Record<string, unknown>> {
    return data(
      await request(st.srv())
        .post(`${memos()}/${n}/versions`)
        .set(owner())
        .expect(200),
    );
  }
  const publish = (n: number, v: number) =>
    request(st.srv())
      .post(`${memos()}/${n}/versions/${v}/publish`)
      .set(owner());
  const checkToken = (n: number) =>
    request(st.srv())
      .post(`${memos()}/${n}/check-token`)
      .set(owner())
      .send({ path: '/admin/orders/1042' });
  const exchange = (sess: string, url: string) =>
    request(st.srv())
      .post('/assist-admin/v1/voice-test/session')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({
        token: new URL(url).searchParams.get(WIDGET_VOICE_TEST_PARAM),
        lang: 'uk',
      });

  beforeAll(async () => {
    await st.init();
    st.text.planner = () => [];
    M = await readySite(st, shop);
    st.app.get(AdminMemoMonitorService).onlyAccountIds = [M.S.accountId];
  });
  afterAll(() => st.close());

  let uiN = 0;
  it('публикация без прогона текущей версии — 409 MEMO_CHECK_REQUIRED', async () => {
    uiN = await create(uiMemo());
    const v = await build(uiN);
    expect(v).toMatchObject({
      version: 1,
      status: 'checking',
      checkRequired: true,
    });
    const r = await publish(uiN, 1).expect(409);
    expect(r.body.error.code).toBe('MEMO_CHECK_REQUIRED');
    const view = data(
      await request(st.srv()).get(`${memos()}/${uiN}`).set(owner()).expect(200),
    );
    expect(view.status).toBe('checking');
    expect(view.versions[0].checkReport).toBeNull();
  });

  it('ссылка «Прогнать»: только владелец, verified https-хост админки, путь; обмен — карточка мемо', async () => {
    const t = data(await checkToken(uiN).expect(200));
    expect(t.url).toMatch(
      new RegExp(
        `^https://${M.S.adminHost.replace(/\./g, '\\.')}/admin/orders/1042\\?${WIDGET_VOICE_TEST_PARAM}=`,
      ),
    );
    expect(t.version).toBe(1);
    // Сотрудник-«менеджер» TMA и чужой — нет (гвард assistAdmin: owner).
    await request(st.srv())
      .post(`${memos()}/${uiN}/check-token`)
      .set(st.as(BigInt(999_999_001)))
      .send({})
      .expect((r) => expect([401, 403, 404]).toContain(r.status));
    await request(st.srv())
      .post(`${memos()}/${uiN}/check-token`)
      .set(owner())
      .send({ path: '//evil.example/x' })
      .expect(400);
    const sess = await employeeSession(st, M, 'owner-in-admin');
    const ex = data(await exchange(sess, t.url).expect(200));
    expect(ex.memo).toMatchObject({
      number: uiN,
      version: 1,
      pageSteps: true,
      name: 'Клієнти і відвантаження',
    });
    expect(ex.memo.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'navigate',
      'api',
      'api',
    ]);
    // Ссылка одноразовая.
    await exchange(sess, t.url).expect(404);
    // Не тестовая сессия голосового управления: разбор/отчёт мастера — 404,
    // план с её заголовком — как обычная сессия (режим выключен — 409).
    const snap = orderPage(M.S.adminHost);
    await request(st.srv())
      .post(`/assist-admin/v1/voice-test/${ex.testId}/analyze`)
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ snapshot: snap })
      .expect(404);
    await request(st.srv())
      .post(`/assist-admin/v1/voice-test/${ex.testId}/report`)
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ snapshot: snap })
      .expect(404);
    const plan = await request(st.srv())
      .post('/assist-admin/v1/ui-plan')
      .set(ADMIN_SESSION_HEADER, sess)
      .set('X-Assist-Admin-Voice-Test', ex.testId)
      .send({
        source: 'typed',
        text: 'відкрий клієнтів',
        snapshot: snap,
        testId: ex.testId,
      });
    expect(plan.status).toBe(409);
    expect(plan.body.error.code).toBe('ADMIN_VC_OFF');
    // Чужая сессия — страницу прогона не сдаст.
    const other = await employeeSession(st, M, 'someone-else');
    await request(st.srv())
      .post(`/assist-admin/v1/voice-test/${ex.testId}/memo-page`)
      .set(ADMIN_SESSION_HEADER, other)
      .send({ snapshot: snap })
      .expect(404);
  });

  it('прогон: шаг на странице — по снимку кодом; шаги api НЕ исполняются (0 запросов, 0 предложений, 0 запусков)', async () => {
    const sess = await employeeSession(st, M, 'owner-in-admin-2');
    const before = {
      api: apiCalls(),
      proposals: await st.prisma.assistAdminActionProposal.count({
        where: { siteId: M.S.siteId },
      }),
      runs: await st.prisma.assistAdminMemoRun.count({
        where: { siteId: M.S.siteId },
      }),
      plans: await st.prisma.assistAdminUiPlan.count({
        where: { siteId: M.S.siteId },
      }),
    };
    // Страница без ссылки «Клієнти» — отрезок не найден, страницу не
    // засчитывают; отчёт без проверенной страницы — fail.
    const bare = orderPage(M.S.adminHost) as {
      elements: Array<{ text: string }>;
    };
    bare.elements = bare.elements.filter((e) => e.text !== 'Клієнти');
    const r1 = await dryRunMemo(st, M.S, uiN, sess, [bare]);
    expect(r1.result).toBe('fail');
    expect(r1.report.steps).toEqual([
      { i: 0, page: null, ok: false, problem: 'unchecked' },
      { i: 1, page: null, ok: true, problem: null },
      { i: 2, page: null, ok: true, problem: null },
    ]);
    expect(apiCalls()).toBe(before.api);
    expect(
      await st.prisma.assistAdminActionProposal.count({
        where: { siteId: M.S.siteId },
      }),
    ).toBe(before.proposals);
    expect(
      await st.prisma.assistAdminMemoRun.count({
        where: { siteId: M.S.siteId },
      }),
    ).toBe(before.runs);
    expect(
      await st.prisma.assistAdminUiPlan.count({
        where: { siteId: M.S.siteId },
      }),
    ).toBe(before.plans);
    // fail — версия held, публикация — нет.
    const view = data(
      await request(st.srv()).get(`${memos()}/${uiN}`).set(owner()).expect(200),
    );
    expect(view.versions[0]).toMatchObject({
      status: 'held',
      checkReport: { kind: 'memo-check', result: 'fail', version: 1 },
    });
    expect(view.status).toBe('held');
    expect((await publish(uiN, 1).expect(409)).body.error.code).toBe(
      'MEMO_INVALID',
    );
    // Новая версия, прогон на нужной странице — pass; снова 0 вызовов API.
    expect(await build(uiN)).toMatchObject({ version: 2, status: 'checking' });
    await checkToken(uiN).expect(200); // ссылки множатся — каждая на свою версию
    const r2 = await dryRunMemo(st, M.S, uiN, sess, [orderPage(M.S.adminHost)]);
    expect(r2.result).toBe('pass');
    expect(r2.report).toMatchObject({
      kind: 'memo-check',
      version: 2,
      goal: 'ok',
      pages: ['/admin/orders/1042'],
      by: 'jwt:owner-in-admin-2',
    });
    expect(apiCalls()).toBe(before.api);
    expect(
      await st.prisma.assistAdminActionProposal.count({
        where: { siteId: M.S.siteId },
      }),
    ).toBe(before.proposals);
    // Журнал: запись memo `check:pass` от проверяющего.
    const log = await st.prisma.assistAdminActionLog.findMany({
      where: { siteId: M.S.siteId, kind: 'memo' },
      select: { outcome: true, actor: true },
    });
    expect(log).toEqual(
      expect.arrayContaining([
        { outcome: 'check:fail', actor: 'jwt:owner-in-admin-2' },
        { outcome: 'check:pass', actor: 'jwt:owner-in-admin-2' },
      ]),
    );
    // Отчёт сдаётся один раз: ссылка закрыта.
    const t = await st.prisma.assistAdminVoiceTest.findFirstOrThrow({
      where: { siteId: M.S.siteId, actor: 'jwt:owner-in-admin-2' },
      orderBy: { createdAt: 'desc' },
    });
    expect(t.reportedAt).toBeNull();
    await request(st.srv())
      .post(`/assist-admin/v1/voice-test/${t.id}/memo-report`)
      .set(ADMIN_SESSION_HEADER, sess)
      .expect(404);
    await publish(uiN, 2).expect(200);
    // Прогон мемо — не отчёт мастера голосового управления: в списке
    // отчётов его нет, «годного отчёта» для `on` он не даёт.
    const tests = data(
      await request(st.srv())
        .get(`/assist/sites/${M.S.siteId}/admin-mode/voice-control/tests`)
        .set(owner())
        .expect(200),
    );
    expect(tests.items).toEqual([]);
    const vc = data(
      await request(st.srv())
        .get(`/assist/sites/${M.S.siteId}/admin-mode/voice-control`)
        .set(owner())
        .expect(200),
    );
    expect(vc.report).toBeNull();
  });

  it('права: роль проверяющего без операции — forbidden → fail; выключенная операция — fail', async () => {
    const n = await create(readMemo('Прочитати замовлення'));
    await build(n);
    const intern = await employeeSession(st, M, 'intern-check', 'intern');
    // readers видят getOrder — pass.
    expect((await dryRunMemo(st, M.S, n, intern)).result).toBe('pass');
    const n2 = await create({
      ...uiMemo('Відвантажити від стажера'),
      steps: [uiMemo().steps[2]],
    });
    await build(n2);
    const r = await dryRunMemo(st, M.S, n2, intern);
    expect(r.result).toBe('fail');
    expect(r.report.steps).toEqual([
      { i: 0, page: null, ok: false, problem: 'forbidden' },
    ]);
    // Операцию выключили — прогон (у менеджера) — fail.
    await request(st.srv())
      .patch(
        `/assist/sites/${M.S.siteId}/connectors/${M.connectorId}/operations/updateOrderStatus`,
      )
      .set(owner())
      .send({ enabled: false });
    await build(n2);
    const mgr = await employeeSession(st, M, 'mgr-check');
    const r2 = await dryRunMemo(st, M.S, n2, mgr);
    expect(r2.report.steps).toEqual([
      { i: 0, page: null, ok: false, problem: 'operation_disabled' },
    ]);
    await request(st.srv())
      .patch(
        `/assist/sites/${M.S.siteId}/connectors/${M.connectorId}/operations/updateOrderStatus`,
      )
      .set(owner())
      .send({ enabled: true })
      .expect(200);
  });

  it('правка только имени — отчёт опубликованной версии переносится; шаги изменились — нужен новый прогон', async () => {
    const view = data(
      await request(st.srv()).get(`${memos()}/${uiN}`).set(owner()).expect(200),
    );
    await request(st.srv())
      .patch(`${memos()}/${uiN}/draft`)
      .set(owner())
      .send({
        expectedRevision: view.draftRevision,
        draft: {
          ...uiMemo(),
          names: { uk: 'Клієнти і відвантаження (нове ім’я)' },
        },
      })
      .expect(200);
    const v3 = await build(uiN);
    expect(v3).toMatchObject({ version: 3, checkRequired: false });
    await publish(uiN, 3).expect(200);
    const v = data(
      await request(st.srv()).get(`${memos()}/${uiN}`).set(owner()).expect(200),
    );
    expect(v.versions[0].checkReport).toMatchObject({
      result: 'pass',
      version: 3,
      inherited: 2,
    });
    await request(st.srv())
      .patch(`${memos()}/${uiN}/draft`)
      .set(owner())
      .send({
        expectedRevision: v.draftRevision,
        draft: { ...uiMemo(), steps: uiMemo().steps.slice(0, 2) },
      })
      .expect(200);
    expect(await build(uiN)).toMatchObject({ version: 4, checkRequired: true });
    expect((await publish(uiN, 4).expect(409)).body.error.code).toBe(
      'MEMO_CHECK_REQUIRED',
    );
  });

  // ── монитор «требует проверки» ─────────────────────────────────────────

  async function publishedRead(
    name: string,
  ): Promise<{ n: number; id: string }> {
    const n = await create(readMemo(name));
    await build(n);
    const sess = await employeeSession(st, M, `chk-${n}`);
    expect((await dryRunMemo(st, M.S, n, sess)).result).toBe('pass');
    await publish(n, 1).expect(200);
    const row = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { siteId: M.S.siteId, number: n },
    });
    return { n, id: row.id };
  }
  async function seedRun(
    memo: { n: number; id: string },
    actor: string,
    p: {
      status: string;
      step?: number;
      goal?: string | null;
      outcome?: string;
      version?: number;
      daysAgo?: number;
    },
  ) {
    const step = p.step ?? 0;
    await st.prisma.assistAdminMemoRun.create({
      data: {
        accountId: M.S.accountId,
        siteId: M.S.siteId,
        memoId: memo.id,
        memoNumber: memo.n,
        memoVersion: p.version ?? 1,
        actor,
        channel: 'embed',
        status: p.status,
        step,
        goalStatus: p.goal === undefined ? null : p.goal,
        progress: p.outcome
          ? [{ i: step, operation: 'x', outcome: p.outcome }]
          : [],
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - (p.daysAgo ?? 0) * 86_400_000),
      },
    });
  }
  const monitor = () => st.app.get(AdminMemoMonitorService);
  const status = async (id: string) =>
    (await st.prisma.assistAdminMemo.findFirstOrThrow({ where: { id } }))
      .status;

  it('сбои на шаге у ≥ 3 РАЗНЫХ сотрудников → needs_review (2 разных, 3 одного, старая версия, «нет страницы», 8 дней назад — нет)', async () => {
    const m = await publishedRead('Монітор збоїв');
    const fail = { status: 'failed', goal: 'not_reached', outcome: 'failed' };
    await seedRun(m, 'jwt:a', fail);
    await seedRun(m, 'jwt:b', fail);
    await seedRun(m, 'jwt:b', fail);
    await seedRun(m, 'jwt:b', fail);
    await seedRun(m, 'jwt:c', { ...fail, outcome: 'needs_page' });
    await seedRun(m, 'jwt:d', { ...fail, version: 0 });
    await seedRun(m, 'jwt:e', { ...fail, daysAgo: 8 });
    await seedRun(m, 'jwt:f', { status: 'stopped', goal: 'not_reached' });
    expect((await monitor().run()).reviews).toBe(0);
    expect(await status(m.id)).toBe('published');
    await seedRun(m, 'jwt:g', fail);
    const cron = await st.app.get(AssistAdminRetentionController).runOnce();
    expect(cron.memoReviews).toBe(1);
    const row = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { id: m.id },
    });
    expect(row.status).toBe('needs_review');
    expect(row.reviewReason).toMatchObject({
      code: 'failures',
      step: 1,
      version: 1,
      employees: 3,
    });
    expect(st.app.get(AdminActionsNotifier).sent.map((x) => x.text)).toContain(
      `memo:${m.n}:failures`,
    );
    // В бою не исполняется: по номеру — «не найдено или выключено».
    const a = await employeeSession(st, M, 'emp-after-review');
    const r = data(await api(st, a).chat(`АМ-${m.n} 1042`).expect(200));
    expect(r.answer.text).toMatch(
      new RegExp(`АМ-${m.n}.*(не знайдено|не найдено)`),
    );
    // Выключить/включить — «требует проверки» остаётся.
    await request(st.srv())
      .post(`${memos()}/${m.n}/disable`)
      .set(owner())
      .expect(200);
    await request(st.srv())
      .post(`${memos()}/${m.n}/enable`)
      .set(owner())
      .expect(200);
    expect(await status(m.id)).toBe('needs_review');
    // TMA: причина и статистика в ответе API.
    const list = data(
      await request(st.srv()).get(memos()).set(owner()).expect(200),
    );
    const item = list.memos.find((x: { number: number }) => x.number === m.n);
    expect(item.reviewReason).toMatchObject({ code: 'failures', step: 1 });
    expect(item.stats).toMatchObject({
      days: 30,
      runs: 9,
      failed: 7,
      stopped: 1,
    });
    const st7 = data(
      await request(st.srv())
        .get(`${memos()}/${m.n}/stats`)
        .set(owner())
        .expect(200),
    );
    expect(st7.stats7).toMatchObject({ days: 7, failed: 5 });
    expect(st7.stats7.failures).toEqual([
      { step: 1, n: 5, employees: 3, pin: false },
    ]);
    // Выход — новая версия, прогон, публикация (отчёт прежней версии не
    // переносится: «требует проверки» выходит только новым прогоном).
    expect(await build(m.n)).toMatchObject({ checkRequired: true });
    const s2 = await employeeSession(st, M, 'chk-again');
    expect((await dryRunMemo(st, M.S, m.n, s2)).result).toBe('pass');
    await publish(m.n, 2).expect(200);
    const back = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { id: m.id },
    });
    expect(back).toMatchObject({ status: 'published', reviewReason: null });
    // Сбои версии 1 новую версию не возвращают в «требует проверки».
    expect(await monitor().reviewMemo(M.S.accountId, m.id)).toBe(false);
  });

  it('pinMismatch у 3 сотрудников → причина pin_mismatch', async () => {
    const m = await publishedRead('Монітор відбитка');
    for (const a of ['jwt:p1', 'jwt:p2', 'jwt:p3'])
      await seedRun(m, a, {
        status: 'failed',
        step: 0,
        goal: 'not_reached',
        outcome: 'pin_mismatch',
      });
    expect(await monitor().reviewMemo(M.S.accountId, m.id)).toBe(true);
    const row = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { id: m.id },
    });
    expect(row.reviewReason).toMatchObject({ code: 'pin_mismatch', step: 1 });
  });

  it('цель < 60% на ≥ 10 запусках → goal_low; 9 запусков или ровно 60% — нет', async () => {
    const m = await publishedRead('Монітор мети');
    // 9 запусков, 0 дошли — мало запусков.
    for (let i = 0; i < 9; i++)
      await seedRun(m, 'jwt:same', { status: 'stopped', goal: 'not_reached' });
    expect(await monitor().reviewMemo(M.S.accountId, m.id)).toBe(false);
    // + 6 дошли: 15 запусков, 40% — goal_low.
    const m2 = await publishedRead('Монітор мети 60');
    for (let i = 0; i < 6; i++)
      await seedRun(m2, 'jwt:same', { status: 'done', goal: 'reached' });
    for (let i = 0; i < 4; i++)
      await seedRun(m2, 'jwt:same', { status: 'stopped', goal: 'not_reached' });
    expect(await monitor().reviewMemo(M.S.accountId, m2.id)).toBe(false);
    await seedRun(m2, 'jwt:same', { status: 'stopped', goal: 'not_reached' });
    // 6 из 11 = 54.5% < 60%.
    expect(await monitor().reviewMemo(M.S.accountId, m2.id)).toBe(true);
    const row = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { id: m2.id },
    });
    expect(row.reviewReason).toMatchObject({
      code: 'goal_low',
      runs: 11,
      reached: 6,
    });
    for (let i = 0; i < 1; i++)
      await seedRun(m, 'jwt:same', { status: 'stopped', goal: 'not_reached' });
    expect(await monitor().reviewMemo(M.S.accountId, m.id)).toBe(true);
  });

  it('в бою: сбой чтения у 3 разных сотрудников — мемо сразу needs_review (на конце запуска, без крона)', async () => {
    const m = await publishedRead('Бойовий монітор');
    for (const sub of ['live-1', 'live-2', 'live-3']) {
      const s = await employeeSession(st, M, sub);
      const r = data(await api(st, s).chat(`АМ-${m.n} 9999`).expect(200));
      expect(r.answer.text).toMatch(/зупинено|остановлено/);
    }
    const row = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { id: m.id },
    });
    expect(row.status).toBe('needs_review');
    expect(row.reviewReason).toMatchObject({
      code: 'failures',
      step: 1,
      employees: 3,
    });
    const log = await st.prisma.assistAdminActionLog.findFirst({
      where: { siteId: M.S.siteId, kind: 'memo', outcome: 'needs_review' },
      orderBy: { at: 'desc' },
    });
    expect(log?.actor).toBe('system:monitor');
  });
});
