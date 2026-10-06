/**
 * Приёмка Э6-бис (б): мемо «Админки» АМ-N с шагами на странице (ТЗ
 * §5-бис.17 п.10, п.15 п.11, п.17; Р-Э8-8 → Р-Э6б-10):
 *  - шаги кликами — только `none/nav/local` (ссылка, вкладка, поле до
 *    «Сохранить»); кнопка «Зберегти» кликом — 422, как и раньше;
 *  - запуск из чата без страницы — честный стоп (шаг на странице нельзя);
 *  - запуск голосовым управлением: отрезок на странице — план кликов с
 *    проверками кода, затем шаг `api` — отдельное предложение с «Да»;
 *  - права сотрудника — на каждую операцию до первого шага.
 */
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { ShopApi } from '../e8/e8-stack';
import {
  AdminVoiceStack,
  api,
  data,
  describeE6bAdmin,
  dryRunMemo,
  employeeSession,
  forceOn,
  orderPage,
  readySite,
  type Ready,
} from './admin-voice-stack';

jest.setTimeout(180_000);

describeE6bAdmin('Э6-бис (б) — мемо «Админки» с шагами на странице', () => {
  const st = new AdminVoiceStack();
  const shop = new ShopApi();
  let M: Ready;
  const memos = () => `/assist/sites/${M.S.siteId}/admin-mode/memos`;

  const memoDraft = () => ({
    names: { uk: 'Клієнти і відвантаження' },
    triggers: { uk: ['клієнти і відвантаження'] },
    goal: { text: { uk: 'Відкрито клієнтів, замовлення відвантажено' } },
    slots: [{ name: 'order', kind: 'number' }],
    steps: [
      {
        action: 'ui',
        kind: 'navigate',
        target: { text: 'Клієнти', role: 'link' },
      },
      {
        action: 'api',
        op: M.ops.updateOrderStatus,
        args: { id: { slot: 'order' }, status: { const: 'shipped' } },
      },
    ],
  });

  beforeAll(async () => {
    await st.init();
    st.text.planner = () => [];
    M = await readySite(st, shop);
    await forceOn(st, M);
  });
  afterAll(() => st.close());

  it('шаг-клик по кнопке («Зберегти», и нейтральной) в мемо — 422; «Видалити» по ссылке — тоже', async () => {
    for (const target of [
      { text: 'Зберегти', role: 'button' },
      // Кнопка без «опасных» слов — тоже нет: серверный эффект кнопки
      // неизвестен (кликом — только ссылка, вкладка, пункт меню).
      { text: 'Показати ще', role: 'button' },
      { text: 'Видалити замовлення', role: 'link' },
    ]) {
      const r = await request(st.srv())
        .post(memos())
        .set(st.as(M.S.ownerTg))
        .send({
          draft: {
            ...memoDraft(),
            steps: [{ action: 'ui', kind: 'click', target }],
          },
        });
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).toMatch(/Шаг-клик/);
    }
  });

  it('мемо с шагом на странице: ворота pass (kinds ui → write), публикация', async () => {
    const created = data(
      await request(st.srv())
        .post(memos())
        .set(st.as(M.S.ownerTg))
        .send({ draft: memoDraft() })
        .expect(201),
    );
    expect(created.number).toBe(1);
    const v = data(
      await request(st.srv())
        .post(`${memos()}/1/versions`)
        .set(st.as(M.S.ownerTg))
        .expect(200),
    );
    expect(v).toMatchObject({ status: 'checking' });
    expect(v.gateReport.kinds).toEqual(['ui', 'write']);
    // Аудит 06.10: публикация — только после сухого прогона в админке.
    const check = await dryRunMemo(
      st,
      M.S,
      1,
      await employeeSession(st, M, 'owner-memo-check'),
      [orderPage(M.S.adminHost)],
    );
    expect(check.result).toBe('pass');
    await request(st.srv())
      .post(`${memos()}/1/versions/1/publish`)
      .set(st.as(M.S.ownerTg))
      .expect(200);
  });

  it('из чата (без страницы) — честный стоп, 0 изменений', async () => {
    const a = await employeeSession(st, M, 'emp-memo-chat');
    const before = shop.applied.length;
    const r = data(await api(st, a).chat('виконай АМ-1 1042').expect(200));
    expect(r.answer.text).toMatch(
      /кроки на сторінці|шаги на странице|steps on the admin page/,
    );
    expect(r.answer.proposal).toBeNull();
    expect(shop.applied.length).toBe(before);
  });

  it('голосовое управление: «виконай АМ-1 1042» — клик по ссылке (проверки кода), затем предложение API с «Да»', async () => {
    const a = await employeeSession(st, M, 'emp-memo-page');
    const p = api(st, a);
    const r = data(
      await p
        .plan({ text: 'виконай АМ-1 1042', snapshot: orderPage(M.S.adminHost) })
        .expect(200),
    );
    // Мемо по номеру: цели не названы в команде — одна карточка «Да» с
    // предпросмотром (цель ↔ команда засчитывает только видимый текст).
    expect(r).toMatchObject({ kind: 'plan', status: 'proposed' });
    expect(r.memo).toMatchObject({ number: 1 });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({
      kind: 'click',
      risk: 'confirm',
      undo: 'nav',
      target: { text: 'Клієнти' },
    });
    await p
      .confirm(r.planId, { stepsHash: r.stepsHash, by: 'button' })
      .expect(200);
    await p.step(r.planId, { index: 0, result: 'dispatched' }).expect(200);
    const done = data(
      await p
        .step(r.planId, {
          index: 0,
          result: 'done',
          url: `https://${M.S.adminHost}/admin/customers`,
        })
        .expect(200),
    );
    expect(done.status).toBe('done');
    expect(done.memo.proposalId).toBeTruthy();
    expect(shop.orders.get('1042')!.status).toBe('paid');
    const st8 = data(await p.state().expect(200));
    const prop = st8.proposals.find(
      (x: { id: string }) => x.id === done.memo.proposalId,
    );
    expect(prop).toMatchObject({ status: 'pending', kind: 'write' });
    const c = data(
      await request(st.srv())
        .post(`/assist-admin/v1/proposals/${prop.id}/confirm`)
        .set(ADMIN_SESSION_HEADER, a)
        .send({ paramsHash: prop.paramsHash })
        .expect(200),
    );
    expect(c.text).toMatch(/АМ-1 виконано|АМ-1 выполнено/);
    expect(shop.orders.get('1042')!.status).toBe('shipped');
    const run = await st.prisma.assistAdminMemoRun.findFirstOrThrow({
      where: { siteId: M.S.siteId, actor: 'jwt:emp-memo-page' },
    });
    expect(run).toMatchObject({ status: 'done', goalStatus: 'reached' });
  });

  it('сотрудник без прав на операцию мемо — отказ до первого шага, плана кликов нет', async () => {
    const intern = await employeeSession(st, M, 'emp-memo-intern', 'intern');
    const before = await st.prisma.assistAdminUiPlan.count({
      where: { siteId: M.S.siteId },
    });
    const r = data(
      await api(st, intern)
        .plan({ text: 'виконай АМ-1 1043', snapshot: orderPage(M.S.adminHost) })
        .expect(200),
    );
    expect(r.kind).toBe('memo');
    expect(r.memo.text).toMatch(/немає прав|нет прав/);
    expect(
      await st.prisma.assistAdminUiPlan.count({
        where: { siteId: M.S.siteId },
      }),
    ).toBe(before);
  });

  it('цель шага не нашлась на странице — план без кликов, запуск мемо остановлен', async () => {
    const a = await employeeSession(st, M, 'emp-memo-miss');
    const page = orderPage(M.S.adminHost) as {
      elements: Array<{ text: string }>;
    };
    page.elements = page.elements.filter((e) => e.text !== 'Клієнти');
    const r = data(
      await api(st, a)
        .plan({ text: 'виконай АМ-1 1043', snapshot: page })
        .expect(200),
    );
    expect(r.steps).toHaveLength(0);
    const run = await st.prisma.assistAdminMemoRun.findFirstOrThrow({
      where: { siteId: M.S.siteId, actor: 'jwt:emp-memo-miss' },
    });
    expect(run.status).toBe('failed');
    // Аудит 06.10: монитор видит, на каком шаге и почему (`pin_mismatch` —
    // цель на странице не сошлась с сохранённой).
    expect(run.step).toBe(0);
    expect(run.progress).toEqual([
      { i: 0, operation: 'ui', outcome: 'pin_mismatch' },
    ]);
    expect(shop.orders.get('1043')!.status).toBe('paid');
  });
  it('аудит: под подписью ссылки мемо на странице — кнопка; пункт меню с эффектом — шаг не исполняется', async () => {
    const a = await employeeSession(st, M, 'emp-memo-role');
    const page = orderPage(M.S.adminHost) as {
      elements: Array<Record<string, unknown>>;
    };
    // «Клієнти» на этой странице — КНОПКА (серверный эффект неизвестен).
    page.elements = page.elements.map((e) =>
      e.text === 'Клієнти'
        ? {
            ref: e.ref,
            role: 'button',
            tag: 'button',
            text: 'Клієнти',
            inView: true,
          }
        : e,
    );
    const r = data(
      await api(st, a)
        .plan({ text: 'виконай АМ-1 1043', snapshot: page })
        .expect(200),
    );
    expect(r.steps).toHaveLength(0);
    // Мемо с пунктом меню: на странице он без адреса (действие, не переход).
    await request(st.srv())
      .post(memos())
      .set(st.as(M.S.ownerTg))
      .send({
        draft: {
          ...memoDraft(),
          names: { uk: 'Архів і відвантаження' },
          triggers: { uk: ['архів і відвантаження'] },
          steps: [
            {
              action: 'ui',
              kind: 'click',
              target: { text: 'В архів', role: 'menuitem' },
            },
            memoDraft().steps[1],
          ],
        },
      })
      .expect(201);
    await request(st.srv())
      .post(`${memos()}/2/versions`)
      .set(st.as(M.S.ownerTg))
      .expect(200);
    const menu = orderPage(M.S.adminHost) as {
      elements: Array<Record<string, unknown>>;
    };
    menu.elements.push({
      ref: 'e16',
      role: 'menuitem',
      tag: 'other',
      text: 'В архів',
      inView: true,
    });
    // Аудит 06.10: сухой прогон ловит это ДО публикации (пункт меню без
    // адреса — действие, `irrev`) — версия `held`, публикации нет.
    const owner = await employeeSession(st, M, 'owner-memo-check2');
    expect((await dryRunMemo(st, M.S, 2, owner, [menu])).result).toBe('fail');
    await request(st.srv())
      .post(`${memos()}/2/versions/1/publish`)
      .set(st.as(M.S.ownerTg))
      .expect(409);
    // В образце пункт меню был переходом (с адресом) — прогон прошёл, а в
    // бою страница другая: проверки кода в плане — последний рубеж.
    await request(st.srv())
      .post(`${memos()}/2/versions`)
      .set(st.as(M.S.ownerTg))
      .expect(200);
    const asLink = orderPage(M.S.adminHost) as {
      elements: Array<Record<string, unknown>>;
    };
    asLink.elements.push({
      ref: 'e16',
      role: 'menuitem',
      tag: 'a',
      text: 'В архів',
      href: `https://${M.S.adminHost}/admin/archive`,
      inView: true,
    });
    expect((await dryRunMemo(st, M.S, 2, owner, [asLink])).result).toBe('pass');
    await request(st.srv())
      .post(`${memos()}/2/versions/2/publish`)
      .set(st.as(M.S.ownerTg))
      .expect(200);
    const b = await employeeSession(st, M, 'emp-memo-menu');
    const m = data(
      await api(st, b)
        .plan({ text: 'виконай АМ-2 1043', snapshot: menu })
        .expect(200),
    );
    expect(m.steps).toHaveLength(0);
    expect(m.notes.map((n: { code: string }) => n.code)).toContain('bad_kind');
    expect(shop.orders.get('1043')!.status).toBe('paid');
  });
});
