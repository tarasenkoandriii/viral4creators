/**
 * Приёмка Э6-бис (б): мастер проверки «Админки» Т-2 (ТЗ помощника §5-бис.13
 * «Т-2 для Админки», §5-бис.10 п.15; решения владельца 03.10.2026 п.1 —
 * `on` только после мастера, Р-Э6б-8):
 *  - ссылку выдаёт только владелец, на verified-хост самой админки; обмен —
 *    один раз, в сессии сотрудника (`sub`);
 *  - на рабочем хосте — только сухой прогон и безопасная навигация, 0
 *    отправок форм; на «тестовом» (отметка владельца) — «Сохранить» с «Да»;
 *  - «запреты без звука» «Админки» — 100% заблокированы, у отмены есть путь
 *    через API; регистратор попыток — 0 (иначе `fail`);
 *  - отчёт — только в assist_admin_* и строкой `ui-test` в журнале действий;
 *    сданный отчёт неизменен; `on` — по годному отчёту.
 */
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { ShopApi } from '../e8/e8-stack';
import {
  AdminVoiceStack,
  api,
  data,
  describeE6bAdmin,
  employeeSession,
  orderPage,
  readySite,
  setState,
  type Ready,
} from './admin-voice-stack';
import { ADMIN_VC_RISKS_VERSION } from '../../modules/assist-admin-voice/admin-voice-rules';

jest.setTimeout(180_000);

const TEST_HEADER = 'X-Assist-Admin-Voice-Test';

describeE6bAdmin('Э6-бис (б) — мастер проверки «Админки» Т-2', () => {
  const st = new AdminVoiceStack();
  const shop = new ShopApi();
  let W: Ready;

  beforeAll(async () => {
    await st.init();
    st.text.planner = () => [];
    W = await readySite(st, shop);
  });
  afterAll(() => st.close());

  const vc = () => `/assist/sites/${W.S.siteId}/admin-mode/voice-control`;
  const token = (b: Record<string, unknown> = {}) =>
    request(st.srv())
      .post(`${vc()}/test-token`)
      .set(st.as(W.S.ownerTg))
      .send(b);
  const exchange = (sess: string, t: string) =>
    request(st.srv())
      .post('/assist-admin/v1/voice-test/session')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ token: t });
  const withTest = (sess: string, tid: string) => ({
    analyze: (body: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist-admin/v1/voice-test/${tid}/analyze`)
        .set(ADMIN_SESSION_HEADER, sess)
        .send(body),
    attempt: (body: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist-admin/v1/voice-test/${tid}/attempt`)
        .set(ADMIN_SESSION_HEADER, sess)
        .send(body),
    report: (body: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist-admin/v1/voice-test/${tid}/report`)
        .set(ADMIN_SESSION_HEADER, sess)
        .send(body),
    plan: (body: Record<string, unknown>) =>
      request(st.srv())
        .post('/assist-admin/v1/ui-plan')
        .set(ADMIN_SESSION_HEADER, sess)
        .set(TEST_HEADER, tid)
        .send({ source: 'typed', testId: tid, ...body }),
    step: (id: string, body: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist-admin/v1/ui-plan/${id}/step`)
        .set(ADMIN_SESSION_HEADER, sess)
        .set(TEST_HEADER, tid)
        .send(body),
    confirm: (id: string, body: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist-admin/v1/ui-plan/${id}/confirm`)
        .set(ADMIN_SESSION_HEADER, sess)
        .set(TEST_HEADER, tid)
        .send(body),
    resume: (id: string, body: Record<string, unknown>) =>
      request(st.srv())
        .post(`/assist-admin/v1/ui-plan/${id}/resume`)
        .set(ADMIN_SESSION_HEADER, sess)
        .set(TEST_HEADER, tid)
        .send(body),
  });
  const reportBody = (dry: Array<{ planId: string; ok: number }>) => ({
    snapshot: orderPage(W.S.adminHost),
    lang: 'uk',
    env: { widget: true, chunks: true, csp: 0, tt: 0, micPolicy: 'allowed' },
    mic: 'ok',
    markup: { total: 15, withId: 1 },
    suspicious: [],
    reviewed: {},
    dry,
    submitsBlocked: 0,
  });

  /** Полный мастер на рабочем хосте: 3 сухих, 2 безопасных, «Сохранить» — нет. */
  async function wizard(sub: string): Promise<{
    tid: string;
    sess: string;
    dry: Array<{ planId: string; ok: number }>;
  }> {
    const t = data(await token({ path: '/admin/orders' }).expect(200));
    const sess = await employeeSession(st, W, sub);
    const ex = data(
      await exchange(
        sess,
        new URL(t.url).searchParams.get('v4c_voicetest')!,
      ).expect(200),
    );
    const T = withTest(sess, ex.testId);
    const dry: Array<{ planId: string; ok: number }> = [];
    for (const text of [
      'відкрий Клієнти',
      'відкрий Замовлення',
      'відкрий Історія',
    ]) {
      const r = data(
        await T.plan({
          text,
          dryRun: true,
          snapshot: orderPage(W.S.adminHost),
        }).expect(200),
      );
      expect(r.status).toBe('done');
      dry.push({ planId: r.planId, ok: 1 });
    }
    for (let k = 0; k < 2; k++) {
      const r = data(
        await T.plan({
          text: 'відкрий Клієнти',
          snapshot: orderPage(W.S.adminHost),
        }).expect(200),
      );
      await T.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
      await T.step(r.planId, {
        index: 0,
        result: 'done',
        url: `https://${W.S.adminHost}/admin/customers`,
      }).expect(200);
    }
    return { tid: ex.testId, sess, dry };
  }

  it('ссылка — только владельцу, после экрана рисков; путь — от корня; обмен — один раз и только своей сессией', async () => {
    const early = await token();
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('ADMIN_VC_RISKS_REQUIRED');
    const site = await st.prisma.site.findFirstOrThrow({
      where: { id: W.S.siteId },
    });
    await request(st.srv())
      .patch(vc())
      .set(st.as(W.S.ownerTg))
      .send({ risksVersion: ADMIN_VC_RISKS_VERSION, siteName: site.name })
      .expect(200);
    expect((await token({ path: '//evil.example/x' })).status).toBe(400);
    const t = data(await token({ path: '/admin/orders' }).expect(200));
    expect(t.url).toMatch(
      new RegExp(`^https://${W.S.adminHost}/admin/orders\\?v4c_voicetest=`),
    );
    expect(t.testHost).toBe(false);
    const tok = new URL(t.url).searchParams.get('v4c_voicetest')!;
    const sess = await employeeSession(st, W, 'emp-wiz-1');
    const ex = data(await exchange(sess, tok).expect(200));
    expect(ex).toMatchObject({ testId: t.testId, testHost: false });
    expect((await exchange(sess, tok)).status).toBe(404);
    // Чужая сессия с id теста — обычный сотрудник: режим выключен.
    const other = await employeeSession(st, W, 'emp-wiz-2');
    const r = await withTest(other, t.testId).plan({
      text: 'відкрий Клієнти',
      snapshot: orderPage(W.S.adminHost),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ADMIN_VC_OFF');
  });

  it('рабочий хост: «Сохранить» не исполняется (0 отправок), запреты 100%, у отмены — путь через API', async () => {
    const { tid, sess } = await wizard('emp-wiz-3');
    const T = withTest(sess, tid);
    st.text.uiModel = () => ({
      steps: [
        { kind: 'fill', target: 'e4', value: 'тест' },
        { kind: 'click', target: 'e6' },
      ],
    });
    const save = data(
      await T.plan({
        text: 'заповни коментар тест і збережи',
        snapshot: orderPage(W.S.adminHost),
      }).expect(200),
    );
    expect(
      save.steps.filter(
        (s: { undo: string; risk: string }) =>
          s.undo === 'irrev' && (s.risk === 'auto' || s.risk === 'confirm'),
      ),
    ).toHaveLength(0);
    const an = data(
      await T.analyze({
        snapshot: orderPage(W.S.adminHost),
        lang: 'uk',
      }).expect(200),
    );
    expect(an.forbidden.every((f: { blocked: boolean }) => f.blocked)).toBe(
      true,
    );
    const byKind = Object.fromEntries(
      an.forbidden.map(
        (f: { kind: string; candidates: number; api: string | null }) => [
          f.kind,
          f,
        ],
      ),
    );
    expect(byKind.delete.candidates).toBeGreaterThan(0);
    expect(byKind.cancel.candidates).toBeGreaterThan(0);
    expect(byKind.cancel.api).not.toBeNull();
    expect(an.dangerButtons.map((b: { text: string }) => b.text)).toEqual(
      expect.arrayContaining(['Видалити замовлення', 'Скасувати замовлення']),
    );
  });

  it('отчёт pass → только assist_admin_* и `ui-test` в журнале; сданный — неизменен; `on` по нему', async () => {
    const { tid, sess, dry } = await wizard('emp-wiz-4');
    const T = withTest(sess, tid);
    const rep = data(await T.report(reportBody(dry)).expect(200));
    expect(rep.result).toBe('pass');
    expect(rep.report).toMatchObject({
      attempts: 0,
      testHost: false,
      save: null,
    });
    // Сданный отчёт — тест закрыт: повтор не находит живого теста.
    expect((await T.report(reportBody(dry))).status).toBe(404);
    const log = await st.prisma.assistAdminActionLog.findMany({
      where: { siteId: W.S.siteId, kind: 'ui-test' },
    });
    expect(log.some((l) => l.outcome === 'pass')).toBe(true);
    expect(
      await st.prisma.assistSiteVoiceTest.count({
        where: { siteId: W.S.siteId },
      }),
    ).toBe(0);
    await expect(
      st.prisma.assistAdminVoiceTest.update({
        where: { id: tid },
        data: { result: 'fail' },
      }),
    ).rejects.toThrow(/неизменен/);
    const on = await setState(st, W, 'on');
    expect(on.status).toBe(200);
    expect(data(on)).toMatchObject({ state: 'on', onProblem: null });
    const s = await st.prisma.assistAdminSettings.findFirstOrThrow({
      where: { siteId: W.S.siteId },
    });
    expect(s.voiceControlAdminTestId).toBe(tid);
    const cfg = data(await api(st, sess).config().expect(200));
    expect(cfg.mode).toBe('on');
  });

  it('регистратор: попытка исполнить шаг на цели «никогда» — отчёт `fail`, `on` по нему нельзя', async () => {
    const { tid, sess, dry } = await wizard('emp-wiz-5');
    const T = withTest(sess, tid);
    const a = data(
      await T.attempt({
        kind: 'never',
        n: 1,
        text: 'Видалити замовлення',
      }).expect(200),
    );
    expect(a.attempts).toBe(1);
    const rep = data(await T.report(reportBody(dry)).expect(200));
    expect(rep.result).toBe('fail');
    expect(rep.report.attempts).toBe(1);
    const tests = data(
      await request(st.srv())
        .get(`${vc()}/tests`)
        .set(st.as(W.S.ownerTg))
        .expect(200),
    );
    expect(tests.items[0]).toMatchObject({
      id: tid,
      result: 'fail',
      problem: 'failed',
    });
  });

  it('тестовый хост (отметка владельца): «Сохранить» — с «Да» и перечнем полей, в отчёте save.done', async () => {
    await request(st.srv())
      .patch(vc())
      .set(st.as(W.S.ownerTg))
      .send({ testHostIds: [W.S.adminHostId] })
      .expect(200);
    const bad = await request(st.srv())
      .patch(vc())
      .set(st.as(W.S.ownerTg))
      .send({ testHostIds: [W.S.siteHostId] });
    expect(bad.status).toBe(400);
    const t = data(await token().expect(200));
    expect(t.testHost).toBe(true);
    const sess = await employeeSession(st, W, 'emp-wiz-6');
    const ex = data(
      await exchange(
        sess,
        new URL(t.url).searchParams.get('v4c_voicetest')!,
      ).expect(200),
    );
    const T = withTest(sess, ex.testId);
    st.text.uiModel = () => ({
      steps: [
        { kind: 'fill', target: 'e4', value: 'перевірка' },
        { kind: 'click', target: 'e6' },
      ],
    });
    const r = data(
      await T.plan({
        text: 'заповни коментар перевірка і збережи',
        snapshot: orderPage(W.S.adminHost),
      }).expect(200),
    );
    expect(r).toMatchObject({ status: 'proposed', pnr: 1 });
    expect(r.fields).toEqual([{ i: 0, label: 'Коментар', value: 'перевірка' }]);
    await T.confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' }).expect(
      200,
    );
    for (const i of [0, 1]) {
      await T.step(r.planId, { index: i, result: 'dispatched' }).expect(200);
      await T.step(r.planId, { index: i, result: 'done' }).expect(200);
    }
    const rep = data(await T.report(reportBody([])).expect(200));
    expect(rep.report.save).toEqual({
      planId: r.planId,
      done: true,
      fields: 1,
    });
  });
  // ── аудит Э6-бис (б) ──────────────────────────────────────────────────

  it('аудит: рабочий хост — и после перехода поле «на месте» (сохраняется сразу) только подсветкой', async () => {
    await request(st.srv())
      .patch(vc())
      .set(st.as(W.S.ownerTg))
      .send({ testHostIds: [] })
      .expect(200);
    const { tid, sess } = await wizard('emp-wiz-7');
    const T = withTest(sess, tid);
    st.text.uiModel = () => ({
      steps: [
        { kind: 'click', target: 'e2' },
        {
          kind: 'fill',
          target: { text: 'Примітка', role: 'textbox' },
          value: 'тест',
        },
      ],
    });
    const r = data(
      await T.plan({
        text: 'відкрий клієнти і заповни примітка тест',
        snapshot: orderPage(W.S.adminHost),
      }).expect(200),
    );
    expect(r.steps).toHaveLength(2);
    if (r.status === 'proposed')
      await T.confirm(r.planId, {
        stepsHash: r.stepsHash,
        by: 'button',
      }).expect(200);
    await T.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
    await T.step(r.planId, {
      index: 0,
      result: 'done',
      url: `https://${W.S.adminHost}/admin/customers`,
    }).expect(200);
    const customers = {
      url: `https://${W.S.adminHost}/admin/customers`,
      title: 'Клієнти',
      elements: [
        {
          ref: 'e1',
          role: 'textbox',
          tag: 'input',
          text: 'Примітка',
          inputType: 'text',
          inView: true,
        },
      ],
    };
    const z = data(
      await T.resume(r.planId, { snapshot: customers }).expect(200),
    );
    expect(z.steps[1]).toMatchObject({ risk: 'manual', reason: 'degraded' });
  });

  it('аудит: ссылка мастера привязана к своему хосту — снимок с другого хоста админки отвергается', async () => {
    const stg = await st.prisma.siteHost.create({
      data: {
        accountId: W.S.accountId,
        siteId: W.S.siteId,
        host: `stg-${W.S.adminHost}`,
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await request(st.srv())
      .patch(`/assist/sites/${W.S.siteId}/admin-mode`)
      .set(st.as(W.S.ownerTg))
      .send({ adminHostIds: [W.S.adminHostId, stg.id] })
      .expect(200);
    await request(st.srv())
      .patch(vc())
      .set(st.as(W.S.ownerTg))
      .send({ testHostIds: [stg.id] })
      .expect(200);
    const t = data(await token({ hostId: stg.id }).expect(200));
    expect(t.testHost).toBe(true);
    const sess = await employeeSession(st, W, 'emp-wiz-8');
    const ex = data(
      await exchange(
        sess,
        new URL(t.url).searchParams.get('v4c_voicetest')!,
      ).expect(200),
    );
    const T = withTest(sess, ex.testId);
    st.text.uiModel = () => ({
      steps: [
        { kind: 'fill', target: 'e4', value: 'перевірка' },
        { kind: 'click', target: 'e6' },
      ],
    });
    // Токен «тестового» хоста, перенесённый на РАБОЧИЙ: «Зберегти» не будет.
    const work = await T.plan({
      text: 'заповни коментар перевірка і збережи',
      snapshot: orderPage(W.S.adminHost),
    });
    expect(work.status).toBe(400);
    expect(
      (await T.analyze({ snapshot: orderPage(W.S.adminHost), lang: 'uk' }))
        .status,
    ).toBe(400);
    const ok = data(
      await T.plan({
        text: 'заповни коментар перевірка і збережи',
        snapshot: orderPage(stg.host),
      }).expect(200),
    );
    expect(ok).toMatchObject({ status: 'proposed', pnr: 1 });
  });

  it('аудит: БД — `on` только со сданным годным отчётом ЭТОГО сайта; готовый отчёт вставкой — нет', async () => {
    const seed = {
      accountId: W.S.accountId,
      siteId: W.S.siteId,
      hostId: W.S.adminHostId,
      host: W.S.adminHost,
      origin: `https://${W.S.adminHost}`,
      startedBy: `tg:${W.S.ownerTg}`,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    };
    await expect(
      st.prisma.assistAdminVoiceTest.create({
        data: {
          ...seed,
          tokenHash: `audit-fake-${Date.now()}`,
          result: 'pass',
          reportedAt: new Date(),
          validUntil: new Date(Date.now() + 86_400_000),
        },
      }),
    ).rejects.toThrow(/без отчёта/);
    const fresh = await st.prisma.assistAdminVoiceTest.create({
      data: { ...seed, tokenHash: `audit-fresh-${Date.now()}` },
    });
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: W.S.siteId },
      data: {
        voiceControlAdminState: 'test',
        voiceControlAdminTestId: null,
      },
    });
    for (const id of [fresh.id, 'no-such-test']) {
      await expect(
        st.prisma.assistAdminSettings.updateMany({
          where: { siteId: W.S.siteId },
          data: { voiceControlAdminState: 'on', voiceControlAdminTestId: id },
        }),
      ).rejects.toThrow(/годным отчётом/);
    }
    // Сданный, но `fail` — тоже нет.
    await st.prisma.assistAdminVoiceTest.update({
      where: { id: fresh.id },
      data: {
        result: 'fail',
        reportedAt: new Date(),
        validUntil: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(
      st.prisma.assistAdminSettings.updateMany({
        where: { siteId: W.S.siteId },
        data: {
          voiceControlAdminState: 'on',
          voiceControlAdminTestId: fresh.id,
        },
      }),
    ).rejects.toThrow(/годным отчётом/);
  });
});
