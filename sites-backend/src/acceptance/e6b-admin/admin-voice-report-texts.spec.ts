/**
 * Приёмка аудита Э6-бис (б) (1) (заход 9): отчёт мастера «Админки» — для
 * людей, не кодами. Сервер отдаёт кабинету TMA пункты с ЧИСЛАМИ (тексты на
 * каждый код — словарь TMA), фрагмент разметки для разработчика админки
 * (отмеченные «заборонити», опасные кнопки, списки с ПД), сухой прогон с
 * числом «вірно» по шагам (iframe отмечает каждый шаг, сервер считает
 * только исполнимые и не больше их числа). Плюс Р-З9-23 в мастере на
 * рабочем хосте: «Зберегти» там — только подсветка, в API план не уходит.
 */
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { ADMIN_VC_RISKS_VERSION } from '../../modules/assist-admin-voice/admin-voice-rules';
import { ShopApi } from '../e8/e8-stack';
import {
  AdminVoiceStack,
  data,
  describeE6bAdmin,
  employeeSession,
  orderPage,
  readySite,
  type Ready,
} from './admin-voice-stack';

jest.setTimeout(180_000);

const TEST_HEADER = 'X-Assist-Admin-Voice-Test';

describeE6bAdmin(
  'аудит Э6-бис (б) (1) — отчёт мастера «Админки» для людей',
  () => {
    const st = new AdminVoiceStack();
    const shop = new ShopApi();
    let W: Ready;
    let n = 0;

    beforeAll(async () => {
      await st.init();
      st.text.planner = () => [];
      W = await readySite(st, shop);
      const site = await st.prisma.site.findFirstOrThrow({
        where: { id: W.S.siteId },
      });
      await request(st.srv())
        .patch(vc())
        .set(st.as(W.S.ownerTg))
        .send({ risksVersion: ADMIN_VC_RISKS_VERSION, siteName: site.name })
        .expect(200);
    });
    afterAll(() => st.close());

    function vc() {
      return `/assist/sites/${W.S.siteId}/admin-mode/voice-control`;
    }

    /** Мастер на рабочем хосте: ссылка → обмен → маршруты с id теста. */
    async function wizard() {
      const t = data(
        await request(st.srv())
          .post(`${vc()}/test-token`)
          .set(st.as(W.S.ownerTg))
          .send({ path: '/admin/orders' })
          .expect(200),
      );
      const sess = await employeeSession(st, W, `emp-rt-${++n}`);
      const ex = data(
        await request(st.srv())
          .post('/assist-admin/v1/voice-test/session')
          .set(ADMIN_SESSION_HEADER, sess)
          .send({ token: new URL(t.url).searchParams.get('v4c_voicetest') })
          .expect(200),
      );
      const tid = ex.testId as string;
      const post = (path: string, body: Record<string, unknown>) =>
        request(st.srv())
          .post(path)
          .set(ADMIN_SESSION_HEADER, sess)
          .set(TEST_HEADER, tid)
          .send(body);
      return {
        tid,
        plan: (body: Record<string, unknown>) =>
          post('/assist-admin/v1/ui-plan', {
            source: 'typed',
            testId: tid,
            ...body,
          }),
        report: (body: Record<string, unknown>) =>
          post(`/assist-admin/v1/voice-test/${tid}/report`, body),
        confirm: (id: string, body: Record<string, unknown>) =>
          post(`/assist-admin/v1/ui-plan/${id}/confirm`, body),
        step: (id: string, body: Record<string, unknown>) =>
          post(`/assist-admin/v1/ui-plan/${id}/step`, body),
      };
    }

    const reportBody = (
      dry: Array<{ planId: string; ok: number }>,
      extra: Record<string, unknown> = {},
    ) => ({
      snapshot: orderPage(W.S.adminHost),
      lang: 'uk',
      env: { widget: true, chunks: true, csp: 2, tt: 0, micPolicy: 'allowed' },
      mic: 'denied_user',
      markup: { total: 15, withId: 1 },
      suspicious: [],
      reviewed: {},
      dry,
      submitsBlocked: 0,
      ...extra,
    });

    it('пункты — с числами для текста; фрагмент разметки: «заборонити» владельца и опасные кнопки страницы; кабинет TMA отдаёт их владельцу', async () => {
      const W1 = await wizard();
      st.text.uiModel = () => ({
        steps: [
          { kind: 'fill', target: 'e4', value: 'тест' },
          { kind: 'click', target: 'e6' },
        ],
      });
      // Сухой прогон: «поле + Зберегти» на рабочем хосте — исполнимый 1 шаг
      // (Зберегти — «натисніть самі»); iframe прислал «вірно» 2 — сервер
      // засчитывает не больше исполнимых.
      const d = data(
        await W1.plan({
          text: 'заповни коментар тест і збережи',
          dryRun: true,
          snapshot: orderPage(W.S.adminHost),
        }).expect(200),
      );
      expect(d.kind).toBe('plan');
      const rep = data(
        await W1.report(
          reportBody([{ planId: d.planId, ok: 2 }], {
            suspicious: [
              {
                key: 'k1',
                why: 'icon_trash',
                tag: 'button',
                label: 'Архів',
                selector: 'form#order > button.archive',
              },
              {
                key: 'k2',
                why: 'class_danger',
                tag: 'a',
                label: 'Деталі',
                selector: 'a.more',
              },
            ],
            reviewed: { k1: 'deny', k2: 'safe' },
          }),
        ).expect(200),
      );
      expect(rep.report.dry).toEqual([
        expect.objectContaining({ planId: d.planId, steps: 1, ok: 1 }),
      ]);
      const items = rep.report.items as Array<{
        step: number;
        code: string;
        data?: Record<string, unknown>;
      }>;
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: 1,
            code: 'csp_violations',
            data: { n: 2 },
          }),
          expect.objectContaining({
            step: 2,
            code: 'mic_owner_problem',
            data: { status: 'denied_user' },
          }),
          expect.objectContaining({
            step: 4,
            code: 'dry_low',
            data: { ok: 1, need: 3 },
          }),
        ]),
      );
      const f = rep.report.fragment as string;
      expect(f).toContain(
        '<!-- form#order > button.archive --> <button data-assist="never">',
      );
      expect(f).not.toContain('a.more');
      expect(f).toContain('Видалити замовлення');
      expect(f).toContain('data-assist="never">…</div>');
      // Кабинет TMA (владелец): тот же отчёт с фрагментом и числами пунктов.
      const tma = data(
        await request(st.srv())
          .get(`${vc()}/tests/${W1.tid}`)
          .set(st.as(W.S.ownerTg))
          .expect(200),
      );
      expect(tma.report.fragment).toBe(f);
      expect(
        tma.report.items.find((x: { code: string }) => x.code === 'dry_low'),
      ).toMatchObject({ data: { ok: 1, need: 3 } });
    });

    it('Р-З9-23 в мастере на рабочем хосте: «вибери статус … і збережи» — не в API (там «Зберегти» только подсветка), план с «натисніть самі»', async () => {
      const W2 = await wizard();
      st.text.uiModel = () => ({
        steps: [
          { kind: 'select', target: 'e5', value: 'Відправлено', risk: 'auto' },
          { kind: 'click', target: 'e6', risk: 'auto' },
        ],
      });
      const r = data(
        await W2.plan({
          text: 'вибери статус Відправлено і збережи',
          snapshot: orderPage(W.S.adminHost),
        }).expect(200),
      );
      expect(r.kind).toBe('plan');
      expect(r.steps.map((s: { risk: string }) => s.risk)).toEqual([
        'auto',
        'manual',
      ]);
    });

    it('аудит пакета F (P2-2): мастер на ТЕСТОВОМ хосте — «Статус + Зберегти» кликами с «Так» (не карточкой боевого API), в отчёте save.done', async () => {
      await request(st.srv())
        .patch(vc())
        .set(st.as(W.S.ownerTg))
        .send({ testHostIds: [W.S.adminHostId] })
        .expect(200);
      try {
        const W3 = await wizard();
        st.text.uiModel = () => ({
          steps: [
            {
              kind: 'select',
              target: 'e5',
              value: 'Відправлено',
              risk: 'auto',
            },
            { kind: 'click', target: 'e6', risk: 'auto' },
          ],
        });
        const before = await st.prisma.assistAdminActionProposal.count({
          where: { siteId: W.S.siteId },
        });
        // Глагол изменения («зміни статус…») в мастере — тоже не в API.
        const verb = data(
          await W3.plan({
            text: 'зміни статус на Відправлено і збережи',
            snapshot: orderPage(W.S.adminHost),
          }).expect(200),
        );
        // Не карточка API (в мастере «зміни…» — не команда кликов).
        expect(verb.kind).not.toBe('api');
        const r = data(
          await W3.plan({
            text: 'вибери статус Відправлено і збережи',
            snapshot: orderPage(W.S.adminHost),
          }).expect(200),
        );
        expect(r).toMatchObject({ kind: 'plan', status: 'proposed', pnr: 1 });
        await W3.confirm(r.planId, {
          stepsHash: r.stepsHash,
          by: 'button',
        }).expect(200);
        for (const i of [0, 1]) {
          await W3.step(r.planId, { index: i, result: 'dispatched' }).expect(
            200,
          );
          await W3.step(r.planId, { index: i, result: 'done' }).expect(200);
        }
        const rep = data(await W3.report(reportBody([])).expect(200));
        expect(rep.report.save).toEqual({
          planId: r.planId,
          done: true,
          fields: 1,
        });
        expect(
          await st.prisma.assistAdminActionProposal.count({
            where: { siteId: W.S.siteId },
          }),
        ).toBe(before);
      } finally {
        await request(st.srv())
          .patch(vc())
          .set(st.as(W.S.ownerTg))
          .send({ testHostIds: [] })
          .expect(200);
      }
    });
  },
);
