/**
 * Приёмка Р-З9-23 (аудит Э6-бис (б) (9)): «предпочтение API» — не только по
 * глаголу команды, но и по ЦЕЛЯМ плана. «вибери статус Відправлено і
 * збережи» (глагола изменения нет) — план «поле Статус + Зберегти», а у
 * роли включена write-операция `updateOrderStatus` с параметром `status` —
 * карточка API (чат Э8, «было → станет», «Да»), а не клики. Поле, которого
 * нет в параметрах операции, роль без операции, сухой прогон мастера —
 * клики как раньше. Настоящий Postgres, гварды, сессии employee-JWT.
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
  forceOn,
  orderPage,
  readySite,
  type Ready,
} from './admin-voice-stack';

jest.setTimeout(180_000);

describeE6bAdmin('Р-З9-23 — предпочтение API по целям плана «Админки»', () => {
  const st = new AdminVoiceStack();
  const shop = new ShopApi();
  let R: Ready;
  let n = 0;

  beforeAll(async () => {
    await st.init();
    st.text.planner = () => [];
    R = await readySite(st, shop);
    await forceOn(st, R);
  });
  afterAll(() => st.close());

  const session = (role = 'manager') =>
    employeeSession(st, R, `emp-api-${++n}`, role);
  const plans = () =>
    st.prisma.assistAdminUiPlan.count({ where: { siteId: R.S.siteId } });
  /** «Модель»: Статус ← значение + «Зберегти» (и, если надо, Коментар). */
  const statusPlan =
    (withComment = false) =>
    () => ({
      steps: [
        ...(withComment
          ? [{ kind: 'fill', target: 'e4', value: 'терміново', risk: 'auto' }]
          : []),
        { kind: 'select', target: 'e5', value: 'Відправлено', risk: 'auto' },
        { kind: 'click', target: 'e6', risk: 'auto' },
      ],
    });

  it('«вибери статус Відправлено і збережи» — карточка API `updateOrderStatus` вместо кликов: 0 планов, вопрос в чат с номером со страницы, журнал `api` by=targets', async () => {
    st.text.uiModel = statusPlan();
    const a = await session();
    const before = await plans();
    const r = data(
      await api(st, a)
        .plan({
          text: 'вибери статус Відправлено і збережи',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(r).toMatchObject({
      kind: 'api',
      planId: null,
      steps: [],
      api: {
        key: 'shop.updateOrderStatus',
        ask: 'вибери статус Відправлено і збережи (№ 1042)',
      },
    });
    expect(await plans()).toBe(before);
    const log = await st.prisma.assistAdminActionLog.findMany({
      where: { siteId: R.S.siteId, kind: 'ui-plan', outcome: 'api' },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    expect(log[0].requestMasked).toMatchObject({
      api: 'shop.updateOrderStatus',
      by: 'targets',
    });
    // Дальше — обычный путь Э8: вопрос iframe в чат → карточка «Да» с
    // «было → станет»; на странице и в магазине — ничего до «Да».
    st.text.proposer = (u) =>
      /№ 1042/.test(u) && /<action name="shop.updateOrderStatus"/.test(u)
        ? {
            operation: 'shop.updateOrderStatus',
            args: { id: '1042', status: 'shipped' },
          }
        : null;
    const ans = data(
      await request(st.srv())
        .post('/assist-admin/v1/chat')
        .set(ADMIN_SESSION_HEADER, a)
        .send({ text: r.api.ask })
        .expect(200),
    );
    expect(ans.answer.proposal).toMatchObject({
      status: 'pending',
      kind: 'write',
      operation: 'shop.updateOrderStatus',
    });
    expect(ans.answer.proposal.fields).toEqual(
      expect.arrayContaining([
        { name: 'status', in: 'body', before: 'paid', after: 'shipped' },
      ]),
    );
    expect(shop.orders.get('1042')!.status).toBe('paid');
    st.text.proposer = () => null;
  });

  it('номер назван в команде — в вопросе не повторяется', async () => {
    st.text.uiModel = statusPlan();
    const r = data(
      await api(st, await session())
        .plan({
          text: 'вибери статус Відправлено для 1042 і збережи',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(r.kind).toBe('api');
    expect(r.api.ask).toBe('вибери статус Відправлено для 1042 і збережи');
  });

  it('поле, которого нет в параметрах операции (Коментар + Статус), — клики с карточкой и перечнем полей, как раньше', async () => {
    st.text.uiModel = statusPlan(true);
    const r = data(
      await api(st, await session())
        .plan({
          text: 'заповни коментар терміново, вибери статус Відправлено і збережи',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(r).toMatchObject({ kind: 'plan', status: 'proposed', pnr: 2 });
    expect(r.fields.map((f: { label: string }) => f.label)).toEqual([
      'Коментар',
      'Статус',
    ]);
  });

  it('роль без write-операции (стажёр, только чтение) — клики; операция выключена владельцем — тоже клики', async () => {
    st.text.uiModel = statusPlan();
    const intern = data(
      await api(st, await session('intern'))
        .plan({
          text: 'вибери статус Відправлено і збережи',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(intern.kind).toBe('plan');
    expect(intern.apiMissing).toBeFalsy();
    await request(st.srv())
      .patch(
        `/assist/sites/${R.S.siteId}/connectors/${R.connectorId}/operations/updateOrderStatus`,
      )
      .set(st.as(R.S.ownerTg))
      .send({ enabled: false })
      .expect(200);
    try {
      const r = data(
        await api(st, await session())
          .plan({
            text: 'вибери статус Відправлено і збережи',
            snapshot: orderPage(R.S.adminHost),
          })
          .expect(200),
      );
      expect(r.kind).toBe('plan');
      expect(r.steps.map((s: { kind: string }) => s.kind)).toEqual([
        'select',
        'click',
      ]);
    } finally {
      await request(st.srv())
        .patch(
          `/assist/sites/${R.S.siteId}/connectors/${R.connectorId}/operations/updateOrderStatus`,
        )
        .set(st.as(R.S.ownerTg))
        .send({ enabled: true, roles: ['orders'] })
        .expect(200);
    }
  });

  it('только поле без «Зберегти» и только «Зберегти» без поля — не по целям (клики/обычный план)', async () => {
    st.text.uiModel = () => ({
      steps: [
        { kind: 'select', target: 'e5', value: 'Відправлено', risk: 'auto' },
      ],
    });
    const onlyField = data(
      await api(st, await session())
        .plan({
          text: 'вибери статус Відправлено',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(onlyField.kind).toBe('plan');
    st.text.uiModel = () => ({
      steps: [{ kind: 'click', target: 'e6', risk: 'auto' }],
    });
    const onlySave = data(
      await api(st, await session())
        .plan({ text: 'натисни зберегти', snapshot: orderPage(R.S.adminHost) })
        .expect(200),
    );
    expect(onlySave.kind).toBe('plan');
  });
});
