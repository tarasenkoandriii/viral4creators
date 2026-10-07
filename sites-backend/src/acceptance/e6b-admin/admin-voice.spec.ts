/**
 * Приёмка Э6-бис (б) «Голосовое управление — режим Админка» (ТЗ помощника
 * §5-бис.2, §5-бис.5 «Админка», §5-бис.6, §5-бис.9, §5-бис.10 п.6, 10–12,
 * 14, §5-бис.14 «Админка», §5-бис.15 п.13 п.11–12, §4.3-бис слой 3; решения
 * Р-Э6б-1…12). Настоящий Postgres, гварды, сессии employee-JWT, коннекторы
 * и предложения «Да» Э8; фейк-модель плана предлагает что угодно — решает код.
 */
import { Client } from 'pg';
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { AdminActionLogService } from '../../modules/assist-admin-mode/action-log.service';
import { issueAdminVoiceTicket } from '../../modules/assist-admin-voice/admin-stt';
import { voiceTicketKey } from '../../config/voice-env';
import { TextModelError } from '../../modules/site-ai/text-model';
import { estimateCost } from '../../shared/ai-pricing';
import { ShopApi } from '../e8/e8-stack';
import {
  AdminVoiceStack,
  api,
  data,
  describeE6bAdmin,
  employeeSession,
  forceOn,
  orderPage,
  readySite,
  setState,
  type Ready,
} from './admin-voice-stack';

jest.setTimeout(180_000);

describeE6bAdmin('Э6-бис (б) — голосовое управление «Админкой»', () => {
  const st = new AdminVoiceStack();
  const shop = new ShopApi();
  let R: Ready;

  beforeAll(async () => {
    await st.init();
    st.text.planner = () => [];
    R = await readySite(st, shop);
  });
  afterAll(() => st.close());

  const vc = () => `/assist/sites/${R.S.siteId}/admin-mode/voice-control`;
  const settings = () =>
    st.prisma.assistAdminSettings.findFirstOrThrow({
      where: { siteId: R.S.siteId },
    });
  const journal = (kind?: string) =>
    st.prisma.assistAdminActionLog.findMany({
      where: { siteId: R.S.siteId, ...(kind ? { kind } : {}) },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });

  // ── кабинет: только владелец, риски + название сайта, `on` — с отчётом ──

  describe('кабинет (§5-бис.2, §5-бис.10 п.6, п.14)', () => {
    it('менеджер/оператор «Сайта» и сотрудник «Админки» — 403; владелец видит выключено', async () => {
      const manager = await st.member(R.S, 'manager', { assist: 'manager' });
      const employee = await st.member(R.S, 'operator', {
        assistAdmin: 'employee',
      });
      for (const tg of [manager, employee]) {
        await request(st.srv()).get(vc()).set(st.as(tg)).expect(403);
        await request(st.srv())
          .patch(vc())
          .set(st.as(tg))
          .send({ state: 'test' })
          .expect(403);
        await request(st.srv())
          .post(`${vc()}/test-token`)
          .set(st.as(tg))
          .send({})
          .expect(403);
      }
      const v = data(
        await request(st.srv()).get(vc()).set(st.as(R.S.ownerTg)).expect(200),
      );
      expect(v).toMatchObject({
        state: 'off',
        risksAccepted: false,
        planAllows: true,
        adminModeOk: true,
        voiceAvailable: true,
      });
      expect(v.rules.maxSteps).toBe(10);
    });

    it('включение — только с текстом рисков И названием сайта; запись в журнале с версией рисков', async () => {
      const noRisks = await request(st.srv())
        .patch(vc())
        .set(st.as(R.S.ownerTg))
        .send({ state: 'test' });
      expect(noRisks.status).toBe(400);
      expect(noRisks.body.error.code).toBe('ADMIN_VC_RISKS_REQUIRED');
      const wrongName = await setState(st, R, 'test', { siteName: 'Інший' });
      expect(wrongName.status).toBe(400);
      expect(wrongName.body.error.code).toBe('ADMIN_VC_SITE_NAME');
      const ok = await setState(st, R, 'test');
      expect(ok.status).toBe(200);
      expect(data(ok)).toMatchObject({ state: 'test', risksAccepted: true });
      const rows = await journal('voice-control');
      const last = rows[rows.length - 1];
      expect(last).toMatchObject({
        outcome: 'off->test',
        actor: `tg:${R.S.ownerTg}`,
        actorRole: 'owner',
      });
      expect(last.requestMasked).toMatchObject({
        risksVersion: 'admin-risks-1',
      });
    });

    it('`on` без отчёта мастера — 409 ADMIN_VC_TEST_REQUIRED; прямой UPDATE в обход — отвергает БД', async () => {
      const r = await setState(st, R, 'on');
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ADMIN_VC_TEST_REQUIRED');
      await expect(
        st.prisma.assistAdminSettings.updateMany({
          where: { siteId: R.S.siteId },
          data: { voiceControlAdminState: 'on', voiceControlAdminTestId: null },
        }),
      ).rejects.toThrow(/отчётом мастера/);
      await expect(
        st.prisma.$executeRawUnsafe(
          `UPDATE "sites"."assist_admin_settings" SET "voiceControlAdminState" = 'maybe' WHERE "siteId" = $1`,
          R.S.siteId,
        ),
      ).rejects.toThrow(/неизвестное состояние/);
      expect((await settings()).voiceControlAdminState).toBe('test');
    });

    it('тариф Business — 402; `off` — всегда', async () => {
      const biz = await readySite(st, shop, {
        plan: 'business',
        enableOps: false,
      });
      const r = await setState(st, biz, 'test');
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe('ADMIN_VC_PLAN_REQUIRED');
      await request(st.srv())
        .patch(`/assist/sites/${biz.S.siteId}/admin-mode/voice-control`)
        .set(st.as(biz.S.ownerTg))
        .send({ state: 'off' })
        .expect(200);
    });
  });

  // ── состояния и источник команды ───────────────────────────────────────

  describe('состояния и источник (§5-бис.6 п.1, §5-бис.10 п.14)', () => {
    it('`test` — обычной сессии сотрудника режим выключен (409), конфиг без режима', async () => {
      const a = await employeeSession(st, R, 'emp-test');
      const c = data(await api(st, a).config().expect(200));
      expect(c).toMatchObject({ mode: null, state: 'test' });
      const r = await api(st, a).plan({
        text: 'відкрий Клієнти',
        snapshot: orderPage(R.S.adminHost),
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ADMIN_VC_OFF');
    });

    it('`on`: голос без билета — 400; снимок с публичного хоста сайта (не админки) — 400', async () => {
      await forceOn(st, R);
      const a = await employeeSession(st, R, 'emp-src');
      const p = api(st, a);
      expect(
        (
          await p.plan({
            text: 'відкрий Клієнти',
            source: 'voice',
            voiceTicket: 'a1.9999999999.forged',
            snapshot: orderPage(R.S.adminHost),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await p.plan({
            text: 'відкрий Клієнти',
            snapshot: orderPage(R.S.host),
          })
        ).status,
      ).toBe(400);
      const c = data(await p.config().expect(200));
      expect(c).toMatchObject({ mode: 'on', maxSteps: 10, voice: true });
    });

    it('голос: запись → текст и билет (Soniox убран в finally) → план с источником voice', async () => {
      const a = await employeeSession(st, R, 'emp-voice');
      st.soniox.reset();
      st.soniox.transcript = 'відкрий Клієнти';
      const audio = Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.alloc(3000, 7),
      ]);
      const v = data(
        await request(st.srv())
          .post('/assist-admin/v1/voice')
          .set(ADMIN_SESSION_HEADER, a)
          .set('content-type', 'audio/webm')
          .send(audio)
          .expect(200),
      );
      expect(v.text).toBe('відкрий Клієнти');
      expect(v.voiceTicket).toMatch(/^a1\./);
      expect(st.soniox.count('DELETE', '/files/')).toBe(1);
      expect(st.soniox.count('DELETE', '/transcriptions/')).toBe(1);
      const r = data(
        await api(st, a)
          .plan({
            text: v.text,
            source: 'voice',
            voiceTicket: v.voiceTicket,
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(r.kind).toBe('plan');
      const row = await st.prisma.assistAdminUiPlan.findFirstOrThrow({
        where: { id: r.planId },
      });
      expect(row.source).toBe('voice');
      // Билет другого сотрудника на тот же текст — не годится.
      const key = voiceTicketKey(process.env)!;
      const other = issueAdminVoiceTicket(key, {
        siteId: R.S.siteId,
        actor: 'jwt:someone-else',
        text: 'відкрий Клієнти',
        now: new Date(),
      });
      expect(
        (
          await api(st, a).plan({
            text: 'відкрий Клієнти',
            source: 'voice',
            voiceTicket: other,
            snapshot: orderPage(R.S.adminHost),
          })
        ).status,
      ).toBe(400);
    });
  });

  // ── план «Админки»: правила строже «Сайта» ─────────────────────────────

  describe('план и исполнение (§5-бис.5 «Админка», §5-бис.15 п.3 п.3)', () => {
    let a = '';
    let sub = '';
    let n = 0;
    beforeAll(() => forceOn(st, R));
    // Своя сессия на тест: потолок планов сотрудника — 8 в минуту.
    beforeEach(async () => {
      sub = `emp-plan-${++n}`;
      a = await employeeSession(st, R, sub);
    });

    it('навигация прямым путём без модели: сразу, `dispatched` → `done`, журнал ui-plan/ui-step/chain', async () => {
      const calls = st.text.uiCalls.length;
      const p = api(st, a);
      const r = data(
        await p
          .plan({ text: 'відкрий Клієнти', snapshot: orderPage(R.S.adminHost) })
          .expect(200),
      );
      expect(st.text.uiCalls.length).toBe(calls);
      expect(r).toMatchObject({
        kind: 'plan',
        status: 'confirmed',
        needsConfirm: false,
      });
      expect(r.steps[0]).toMatchObject({
        kind: 'click',
        risk: 'auto',
        undo: 'nav',
      });
      await p.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
      const done = data(
        await p
          .step(r.planId, {
            index: 0,
            result: 'done',
            url: `https://${R.S.adminHost}/admin/customers`,
          })
          .expect(200),
      );
      expect(done).toMatchObject({ status: 'done', chainStatus: 'committed' });
      const kinds = (await journal())
        .filter((l) => (l.requestMasked as { plan?: string }).plan === r.planId)
        .map((l) => `${l.kind}:${l.outcome}`);
      expect(kinds).toEqual([
        'ui-plan:confirmed',
        'ui-step:dispatched',
        'ui-step:done',
        'chain:committed',
      ]);
    });

    it('форма: «Сохранить» — с подтверждением и ПЕРЕЧНЕМ полей; одно «Да», ТН, итог в журнале', async () => {
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'терміново', risk: 'auto' },
          { kind: 'click', target: 'e6', risk: 'auto' },
        ],
      });
      const p = api(st, a);
      const r = data(
        await p
          .plan({
            text: 'заповни коментар терміново і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(r).toMatchObject({
        status: 'proposed',
        needsConfirm: true,
        pnr: 1,
      });
      expect(r.fields).toEqual([
        { i: 0, label: 'Коментар', value: 'терміново' },
      ]);
      expect(
        r.steps.map(
          (s: { undo: string; risk: string }) => `${s.undo}/${s.risk}`,
        ),
      ).toEqual(['local/auto', 'irrev/confirm']);
      // Без «Да» шаг не исполняется.
      expect(
        (await p.step(r.planId, { index: 0, result: 'dispatched' })).status,
      ).toBe(409);
      // «Да» к другим шагам (подмена) — 409 «изменился».
      expect(
        (await p.confirm(r.planId, { stepsHash: 'x'.repeat(22), by: 'button' }))
          .status,
      ).toBe(409);
      await p
        .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
        .expect(200);
      for (const i of [0, 1]) {
        await p.step(r.planId, { index: i, result: 'dispatched' }).expect(200);
        await p.step(r.planId, { index: i, result: 'done' }).expect(200);
      }
      const row = await st.prisma.assistAdminUiPlan.findFirstOrThrow({
        where: { id: r.planId },
      });
      expect(row).toMatchObject({
        status: 'done',
        chainStatus: 'committed',
        confirmedBy: 'button',
        liveUtterance: null,
      });
      const log = await journal();
      expect(
        log.some(
          (l) =>
            l.kind === 'ui-plan' &&
            l.outcome === 'confirm:button' &&
            (l.requestMasked as { fields?: number }).fields === 1,
        ),
      ).toBe(true);
    });

    it('оплаченный сбой модели плана (truncated/empty со spent) — 502 как раньше, строка расхода assist-admin-ui-plan фактом (её видит суточный потолок); timeout — без расхода', async () => {
      const prev = st.text.uiModel;
      const spent = (outputTokens: number) => ({
        model: 'gemini-3.6-flash',
        inputTokens: 1_250,
        cachedInputTokens: 0,
        outputTokens,
      });
      const rows = () =>
        st.prisma.siteAiUsage.findMany({
          where: {
            siteId: R.S.siteId,
            operation: 'assist-admin-ui-plan',
            inputTokens: 1_250,
          },
          orderBy: { outputTokens: 'asc' },
        });
      const before = (await rows()).length;
      const plan = async (err: Error) => {
        st.text.uiModel = () => {
          throw err;
        };
        const r = await api(st, a)
          .plan({
            text: 'заповни коментар терміново і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(502);
        expect(r.body.error?.code ?? r.body.code).toBe('ADMIN_VC_UPSTREAM');
      };
      try {
        await plan(new TextModelError('truncated', spent(1371)));
        await plan(new TextModelError('empty', spent(1372)));
        await plan(new TextModelError('timeout'));
      } finally {
        st.text.uiModel = prev;
      }
      const got = (await rows()).slice(before);
      expect(got.map((r) => [r.outputTokens, r.costMicroUsd])).toEqual([
        [1371, estimateCost('gemini-3.6-flash', spent(1371)).costMicroUsd],
        [1372, estimateCost('gemini-3.6-flash', spent(1372)).costMicroUsd],
      ]);
      expect(got.every((r) => r.costMicroUsd > 0)).toBe(true);
    });

    it('значение не из сказанного — вычеркнуто кодом; второе «Сохранить» — отдельной командой', async () => {
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'Hacker', risk: 'auto' },
          { kind: 'click', target: 'e6', risk: 'auto' },
          // После «Сохранить» (переход) — ещё одно «Сохранить»: вторая ТН.
          {
            kind: 'click',
            target: { text: 'Зберегти', role: 'button' },
            risk: 'auto',
          },
        ],
      });
      const r = data(
        await api(st, a)
          .plan({
            text: 'заповни коментар і збережи, потім статус відправлено',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      const codes = r.notes.map((n: { code: string }) => n.code);
      expect(codes).toEqual(
        expect.arrayContaining(['value_not_said', 'second_pnr']),
      );
      expect(
        r.steps.filter((s: { undo: string }) => s.undo === 'irrev'),
      ).toHaveLength(1);
    });

    it('обратимое («В кошик») в «Админке» — с подтверждением; поле без «Сохранить» (на месте) — irrev', async () => {
      const p = api(st, a);
      const cart = data(
        await p
          .plan({ text: 'натисни В кошик', snapshot: orderPage(R.S.adminHost) })
          .expect(200),
      );
      expect(cart.steps[0]).toMatchObject({ risk: 'confirm', undo: 'irrev' });
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e12', value: '59000123', risk: 'auto' },
        ],
      });
      const inline = data(
        await p
          .plan({
            text: 'заповни трек-номер 59000123',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(inline.steps[0]).toMatchObject({ risk: 'confirm', undo: 'irrev' });
      expect(inline.fields).toEqual([
        { i: 0, label: 'Трек-номер', value: '59000123' },
      ]);
    });

    it('удаление/отмена/возврат кликами — никогда: без операции API — «натисніть самі» с пометкой; с операцией — в предложение API, 0 планов кликов', async () => {
      const intern = await employeeSession(st, R, 'emp-intern', 'intern');
      st.text.uiModel = () => ({
        steps: [{ kind: 'click', target: 'e7', risk: 'auto' }],
      });
      const del = data(
        await api(st, intern)
          .plan({
            text: 'видали замовлення 1042',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(del.apiMissing).toBe(true);
      expect(del.steps[0]).toMatchObject({ risk: 'never', reason: 'danger' });
      for (const [text, target] of [
        ['скасуй замовлення 1042', 'e8'],
        ['оформи повернення коштів по 1042', 'e9'],
        ['вибери все і видали', 'e10'],
      ]) {
        st.text.uiModel = () => ({ steps: [{ kind: 'click', target }] });
        const r = data(
          await api(st, intern)
            .plan({ text, snapshot: orderPage(R.S.adminHost) })
            .expect(200),
        );
        expect(
          r.steps.filter(
            (s: { risk: string }) => s.risk === 'auto' || s.risk === 'confirm',
          ),
        ).toHaveLength(0);
      }
      const before = await st.prisma.assistAdminUiPlan.count({
        where: { siteId: R.S.siteId },
      });
      const cancel = data(
        await api(st, a)
          .plan({
            text: 'скасуй замовлення 1042',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(cancel.kind).toBe('api');
      const change = data(
        await api(st, a)
          .plan({
            text: 'зміни статус замовлення 1042 на відправлено',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(change).toMatchObject({
        kind: 'api',
        api: { key: 'shop.updateOrderStatus' },
      });
      expect(
        await st.prisma.assistAdminUiPlan.count({
          where: { siteId: R.S.siteId },
        }),
      ).toBe(before);
      // Модель сама сказала «через API» — тоже без кликов.
      st.text.uiModel = () => ({ api: 'updateOrderStatus' });
      const viaModel = data(
        await api(st, a)
          .plan({
            text: 'постав відправлено',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(viaModel.kind).toBe('api');
    });

    it('`degraded` — только подсветка: 0 исполнимых шагов', async () => {
      await st.prisma.assistAdminSettings.updateMany({
        where: { siteId: R.S.siteId },
        data: {
          voiceControlAdminState: 'degraded',
          voiceControlAdminTestId: null,
        },
      });
      const r = data(
        await api(st, a)
          .plan({ text: 'відкрий Клієнти', snapshot: orderPage(R.S.adminHost) })
          .expect(200),
      );
      expect(r.steps[0]).toMatchObject({ risk: 'manual', reason: 'degraded' });
      await forceOn(st, R);
    });

    it('ПД: значение телефона — в карточке, после конца — маской; в журнале — только маска', async () => {
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e11', value: '+380501234567' },
          { kind: 'click', target: 'e6' },
        ],
      });
      const p = api(st, a);
      const r = data(
        await p
          .plan({
            text: 'заповни телефон клієнта +380501234567 і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(r.fields[0].value).toBe('+380501234567');
      await p
        .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
        .expect(200);
      for (const i of [0, 1]) {
        await p.step(r.planId, { index: i, result: 'dispatched' }).expect(200);
        await p.step(r.planId, { index: i, result: 'done' }).expect(200);
      }
      const row = await st.prisma.assistAdminUiPlan.findFirstOrThrow({
        where: { id: r.planId },
      });
      expect(JSON.stringify(row.steps)).not.toContain('501234567');
      expect(row.utteranceMasked).not.toContain('501234567');
      expect(row.liveUtterance).toBeNull();
      const log = JSON.stringify(await journal());
      expect(log).not.toContain('501234567');
      const msgs = await st.prisma.assistAdminMessage.findMany({
        where: { siteId: R.S.siteId },
      });
      expect(JSON.stringify(msgs)).not.toContain('501234567');
    });

    it('«верни як було» — только поля до «Сохранить»; статус цепочки — НОВОЙ записью; UPDATE журнала отвергает БД', async () => {
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'перевірити' },
          { kind: 'click', target: 'e6' },
        ],
      });
      const p = api(st, a);
      const r = data(
        await p
          .plan({
            text: 'заповни коментар перевірити і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      await p
        .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
        .expect(200);
      await p.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
      await p.step(r.planId, { index: 0, result: 'done' }).expect(200);
      const stopped = data(
        await p.stop(r.planId, { by: 'button' }).expect(200),
      );
      expect(stopped.chainStatus).toBe('kept');
      const u = data(await p.undo(r.planId, { by: 'command' }).expect(200));
      expect(u).toMatchObject({
        refused: null,
        fields: [{ i: 0, text: 'Коментар' }],
      });
      const rep = data(
        await p
          .undoReport(r.planId, { results: [{ i: 0, result: 'done' }] })
          .expect(200),
      );
      expect(rep.chainStatus).toBe('compensated');
      const chain = (await journal('chain')).filter(
        (l) => (l.requestMasked as { plan?: string }).plan === r.planId,
      );
      expect(chain.map((l) => l.outcome)).toEqual(
        expect.arrayContaining(['kept', 'proposed', 'compensated']),
      );
      await expect(
        st.prisma.$executeRawUnsafe(
          `UPDATE "sites"."assist_admin_action_log" SET "outcome" = 'x' WHERE "id" = $1`,
          chain[0].id,
        ),
      ).rejects.toThrow();
      expect(
        await st.app
          .get(AdminActionLogService)
          .verifyChain(R.S.accountId, R.S.siteId),
      ).toBe(-1);
      // После «Сохранить» вернуть нельзя — только API или вручную.
      const r2 = data(
        await p
          .plan({
            text: 'заповни коментар перевірити і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      await p
        .confirm(r2.planId, { stepsHash: r2.stepsHash, by: 'button' })
        .expect(200);
      for (const i of [0, 1]) {
        await p.step(r2.planId, { index: i, result: 'dispatched' }).expect(200);
        await p.step(r2.planId, { index: i, result: 'done' }).expect(200);
      }
      expect(data(await p.undo(r2.planId, {}).expect(200)).refused).toBe(
        'after_pnr',
      );
    });

    it('чужой сотрудник/чужой сайт — план не найден (404)', async () => {
      const p = api(st, a);
      const r = data(
        await p
          .plan({ text: 'відкрий Клієнти', snapshot: orderPage(R.S.adminHost) })
          .expect(200),
      );
      const b = await employeeSession(st, R, 'emp-other');
      expect(
        (await api(st, b).step(r.planId, { index: 0, result: 'dispatched' }))
          .status,
      ).toBe(404);
      const R2 = await readySite(st, shop, { enableOps: false });
      await forceOn(st, R2);
      const c = await employeeSession(st, R2, sub);
      expect((await api(st, c).stop(r.planId)).status).toBe(404);
    });
  });

  // ── нарушение запрета и монитор «Админки» ──────────────────────────────

  describe('нарушение запрета и монитор (§5-бис.14 «Админка»)', () => {
    it('шаг на цели «никогда» (подмена после плана) — режим `off` СРАЗУ, журнал violation, владельцу — уведомление', async () => {
      await forceOn(st, R);
      const a = await employeeSession(st, R, 'emp-viol');
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'ок' },
          { kind: 'click', target: 'e6' },
        ],
      });
      const p = api(st, a);
      const r = data(
        await p
          .plan({
            text: 'заповни коментар ок і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      await p
        .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
        .expect(200);
      await p.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
      await p.step(r.planId, { index: 0, result: 'done' }).expect(200);
      const row = await st.prisma.assistAdminUiPlan.findFirstOrThrow({
        where: { id: r.planId },
      });
      const steps = row.steps as Array<{ target: { text: string } }>;
      steps[1].target.text = 'Видалити замовлення';
      await st.prisma.assistAdminUiPlan.update({
        where: { id: r.planId },
        data: { steps: steps as never },
      });
      const sent = st.notifier().sent.length;
      const v = await p.step(r.planId, { index: 1, result: 'dispatched' });
      expect(v.status).toBe(409);
      expect(v.body.error.code).toBe('ADMIN_VC_OFF');
      const s = await settings();
      expect(s).toMatchObject({
        voiceControlAdminState: 'off',
        voiceControlAdminStateBy: 'violation',
      });
      const log = await journal();
      expect(
        log.some((l) => l.kind === 'ui-step' && l.outcome === 'violation'),
      ).toBe(true);
      expect(
        log.some((l) => l.kind === 'voice-control' && l.outcome === 'auto:off'),
      ).toBe(true);
      expect(
        st
          .notifier()
          .sent.slice(sent)
          .filter((x) => /ВИМКНЕНО/.test(x.text)),
      ).toHaveLength(1);
    });

    it('аудит: подмена на голый глагол «Скасувати» (строже «Сайта») — тоже нарушение, `off` сразу', async () => {
      await forceOn(st, R);
      const a = await employeeSession(st, R, 'emp-viol-2');
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'ок' },
          { kind: 'click', target: 'e6' },
        ],
      });
      const p = api(st, a);
      const r = data(
        await p
          .plan({
            text: 'заповни коментар ок і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      await p
        .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
        .expect(200);
      await p.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
      await p.step(r.planId, { index: 0, result: 'done' }).expect(200);
      const row = await st.prisma.assistAdminUiPlan.findFirstOrThrow({
        where: { id: r.planId },
      });
      const steps = row.steps as Array<{ target: { text: string } }>;
      steps[1].target.text = 'Скасувати';
      await st.prisma.assistAdminUiPlan.update({
        where: { id: r.planId },
        data: { steps: steps as never },
      });
      const v = await p.step(r.planId, { index: 1, result: 'dispatched' });
      expect(v.status).toBe(409);
      expect(v.body.error.code).toBe('ADMIN_VC_OFF');
      expect(await settings()).toMatchObject({
        voiceControlAdminState: 'off',
        voiceControlAdminStateBy: 'violation',
      });
    });

    it('3 подтверждённых «Сохранить» с несошедшимся expect за сутки → `degraded`; `on` прежним отчётом — нельзя', async () => {
      await forceOn(st, R);
      const a = await employeeSession(st, R, 'emp-miss');
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'раз' },
          { kind: 'click', target: 'e6' },
        ],
      });
      const p = api(st, a);
      for (let k = 0; k < 3; k++) {
        const r = data(
          await p
            .plan({
              text: 'заповни коментар раз і збережи',
              snapshot: orderPage(R.S.adminHost),
            })
            .expect(200),
        );
        await p
          .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
          .expect(200);
        await p.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
        await p.step(r.planId, { index: 0, result: 'done' }).expect(200);
        await p.step(r.planId, { index: 1, result: 'dispatched' }).expect(200);
        await p
          .step(r.planId, { index: 1, result: 'failed', reason: 'expect' })
          .expect(200);
      }
      expect((await settings()).voiceControlAdminState).toBe('degraded');
      expect(st.notifier().sent.at(-1)!.text).toMatch(/режим підказки/);
      const on = await setState(st, R, 'on');
      expect(on.status).toBe(409);
      expect(on.body.error.details.errors[0].code).toBe('older_than_state');
    });
  });

  // ── изоляция режимов (§5-бис.10 п.12, §4.3-бис слой 3) ─────────────────

  it('SELECT под assist_public из assist_admin_ui_plans / voice_tests / settings — отказ', async () => {
    const url = process.env.ASSIST_PUBLIC_DATABASE_URL;
    if (!url) return;
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      for (const t of [
        'assist_admin_ui_plans',
        'assist_admin_voice_tests',
        'assist_admin_settings',
      ]) {
        await expect(
          client.query(`SELECT 1 FROM "sites"."${t}" LIMIT 1`),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.end();
    }
  });
});
