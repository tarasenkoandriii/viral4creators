/**
 * Э3 H — кабинет передачи по HTTP (§6 контракта Э3: лента диалогов с
 * фильтрами и курсором, диалог, take/reply/draft/close, настройки передачи,
 * операторы, крон) на НАСТОЯЩЕМ Postgres с настоящими гвардами (initData →
 * участник кабинета). Права §5-тер.13: оператор — только диалоги с
 * передачей (своей или ждущей), без trace и без «всех»; настройки —
 * manager; чужой сайт — 404.
 */
import * as request from 'supertest';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  HandoffStack,
  type HandoffSite,
} from '../../modules/assist-site-handoff/testing/handoff-stack.testing';
import { HandoffHttp } from '../../modules/assist-site-handoff/testing/handoff-http.testing';

jest.setTimeout(60_000);

describeDb('Э3 H — кабинет передачи по HTTP (handoff-cabinet)', () => {
  const st = new HandoffStack();
  const http = new HandoffHttp();
  beforeAll(async () => {
    await st.init();
    await http.init(st);
  });
  afterAll(async () => {
    await http.close();
    await st.close();
  });

  const get = (s: string, tg: bigint) =>
    request(http.server()).get(s).set(http.as(tg));
  const post = (s: string, tg: bigint, body: object = {}) =>
    request(http.server()).post(s).set(http.as(tg)).send(body);

  /** Сайт: 3 диалога без передачи + 1 с ждущей передачей. */
  async function seeded(): Promise<{
    s: HandoffSite;
    plain: string[];
    withHandoff: string;
    handoffId: string;
  }> {
    const s = await st.handoffSite({ operators: 2 });
    const plain: string[] = [];
    for (let i = 0; i < 3; i++) {
      plain.push(
        (await st.visitorWithDialog(s, `Питання ${i} про доставку?`))
          .conversationId,
      );
    }
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    return { s, plain, withHandoff: v.conversationId, handoffId: r.handoff.id };
  }

  it('лента: manager — все (курсор), оператор — только с передачей; view=all оператору — 403', async () => {
    const { s, withHandoff } = await seeded();
    const owner = s.members[0].telegramId;
    const op = s.operators[0].telegramId;
    const base = `/assist/sites/${s.siteId}/conversations`;
    const all = await get(`${base}?limit=2`, owner).expect(200);
    expect(all.body.data.items).toHaveLength(2);
    expect(all.body.data.nextCursor).toEqual(expect.any(String));
    const page2 = await get(
      `${base}?limit=2&cursor=${all.body.data.nextCursor}`,
      owner,
    ).expect(200);
    const ids = [...all.body.data.items, ...page2.body.data.items].map(
      (x: { id: string }) => x.id,
    );
    expect(new Set(ids).size).toBe(4);
    expect(page2.body.data.nextCursor).toBeNull();
    const first = all.body.data.items[0];
    expect(first).toMatchObject({
      preview: expect.any(String),
      messages: expect.any(Number),
      hasLead: false,
    });

    const opList = await get(base, op).expect(200);
    expect(opList.body.data.items.map((x: { id: string }) => x.id)).toEqual([
      withHandoff,
    ]);
    expect(opList.body.data.items[0].handoff).toMatchObject({
      state: 'waiting',
      assignedToMe: false,
    });
    // Взял другой оператор — у первого диалог пропадает из ленты.
    await post(`${base}/${withHandoff}/take`, s.operators[1].telegramId).expect(
      200,
    );
    expect((await get(base, op).expect(200)).body.data.items).toEqual([]);
    expect(
      (await get(base, s.operators[1].telegramId).expect(200)).body.data.items,
    ).toHaveLength(1);
    const forbidden = await get(`${base}?view=all`, op).expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    // Фильтры и неверные параметры.
    expect(
      (await get(`${base}?outcome=handoff`, owner).expect(200)).body.data.items,
    ).toHaveLength(1);
    expect(
      (await get(`${base}?view=bogus`, owner).expect(400)).body.error.code,
    ).toBe('BAD_REQUEST');
    await get(`${base}?limit=1000`, owner).expect(400);
    await get(`${base}?cursor=@@@`, owner).expect(400);
  });

  it('диалог: оператор видит диалог с передачей (без trace), чужой без передачи — 404; чужой сайт — 404', async () => {
    const { s, plain, withHandoff } = await seeded();
    const op = s.operators[0].telegramId;
    const owner = s.members[0].telegramId;
    const base = `/assist/sites/${s.siteId}/conversations`;
    const v = await get(`${base}/${withHandoff}`, op).expect(200);
    expect(v.body.data.handoff).toMatchObject({
      state: 'waiting',
      summary: { source: 'model' },
      identity: { present: false, verified: null },
    });
    expect(
      v.body.data.messages.every((m: { trace: unknown }) => m.trace === null),
    ).toBe(true);
    const vm = await get(`${base}/${withHandoff}`, owner).expect(200);
    expect(
      vm.body.data.messages.some((m: { trace: unknown }) => m.trace !== null),
    ).toBe(true);
    await get(`${base}/${plain[0]}`, op).expect(404);
    const other = await st.handoffSite({ operators: 0 });
    await get(`/assist/sites/${other.siteId}/conversations`, owner).expect(404);
    await get(
      `/assist/sites/${other.siteId}/conversations/${withHandoff}`,
      owner,
    ).expect(404);
  });

  it('take/reply/draft/close по HTTP: гонка двух — один taken; чужой ответ — 403 HANDOFF_NOT_ASSIGNED; лишнее поле — 400', async () => {
    const { s, withHandoff } = await seeded();
    const [a, b] = s.operators.map((o) => o.telegramId);
    const base = `/assist/sites/${s.siteId}/conversations/${withHandoff}`;
    const [ra, rb] = await Promise.all([
      post(`${base}/take`, a),
      post(`${base}/take`, b),
    ]);
    const results = [ra.body.data.result, rb.body.data.result].sort();
    expect(results).toEqual(['already_taken', 'taken']);
    const winner = ra.body.data.result === 'taken' ? a : b;
    const loser = winner === a ? b : a;
    const denied = await post(`${base}/reply`, loser, { text: 'я' }).expect(
      403,
    );
    expect(denied.body.error.code).toBe('HANDOFF_NOT_ASSIGNED');
    expect(
      (await post(`${base}/close`, loser).expect(403)).body.error.code,
    ).toBe('HANDOFF_NOT_ASSIGNED');
    const bad = await post(`${base}/reply`, winner, {
      text: 'x',
      html: true,
    }).expect(400);
    expect(bad.body.error.code).toBe('REPLY_INVALID');
    const ok = await post(`${base}/reply`, winner, {
      text: 'Добрий день!',
      noTranslate: true,
    }).expect(200);
    expect(ok.body.data).toMatchObject({
      messageId: expect.any(String),
      sentText: 'Добрий день!',
      translated: false,
    });
    const view = await get(base, winner).expect(200);
    const mine = view.body.data.messages.find(
      (m: { role: string }) => m.role === 'operator',
    );
    expect(mine).toMatchObject({ authorIsMe: true, text: 'Добрий день!' });
    const draft = await post(`${base}/draft`, winner).expect(200);
    expect(draft.body.data).toBeNull();
    await post(`${base}/close`, winner).expect(200);
    const closed = await post(`${base}/reply`, winner, { text: 'ще' }).expect(
      409,
    );
    expect(closed.body.error.code).toBe('HANDOFF_CLOSED');
  });

  it('take в диалоге без передачи — 404 HANDOFF_NOT_FOUND (manager видит сам диалог)', async () => {
    const { s, plain } = await seeded();
    const owner = s.members[0].telegramId;
    const res = await post(
      `/assist/sites/${s.siteId}/conversations/${plain[0]}/take`,
      owner,
    ).expect(404);
    expect(res.body.error.code).toBe('HANDOFF_NOT_FOUND');
  });

  it('настройки передачи: manager читает и меняет (строгий разбор → HANDOFF_CONFIG_INVALID с errors); оператор — 403', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const owner = s.members[0].telegramId;
    const op = s.operators[0].telegramId;
    const url = `/assist/sites/${s.siteId}/handoff-settings`;
    const v = await get(url, owner).expect(200);
    expect(v.body.data).toMatchObject({
      config: { enabled: true, operatorLang: 'uk' },
      availableNow: true,
      unavailableReason: null,
      etaMinutes: null,
    });
    expect(v.body.data.operators).toHaveLength(2);
    expect(v.body.data.operators[0]).toMatchObject({
      role: 'owner',
      assist: 'manager',
      botStarted: true,
      botBlocked: false,
      isMe: true,
    });
    expect((await get(url, op).expect(403)).body.error.code).toBe(
      'PRODUCT_ROLE_REQUIRED',
    );
    const bad = await request(http.server())
      .patch(url)
      .set(http.as(owner))
      .send({
        config: {
          enabled: 'yes',
          hours: { mon: [{ from: '18:00', to: '09:00' }] },
          x: 1,
        },
      })
      .expect(400);
    expect(bad.body.error.code).toBe('HANDOFF_CONFIG_INVALID');
    expect(bad.body.error.details.errors).toEqual(
      expect.arrayContaining([
        { path: 'x', code: 'unknown' },
        { path: 'enabled', code: 'type' },
        { path: 'hours.mon.0', code: 'order' },
      ]),
    );
    const ok = await request(http.server())
      .patch(url)
      .set(http.as(owner))
      .send({ config: { enabled: false, waitMinutes: 10 } })
      .expect(200);
    expect(ok.body.data).toMatchObject({
      config: { enabled: false, waitMinutes: 10 },
      availableNow: false,
      unavailableReason: 'disabled',
    });
    await request(http.server())
      .patch(url)
      .set(http.as(owner))
      .send({ conf: {} })
      .expect(400);
    // Операторы кабинета — manager.
    const ops = await get('/assist/account/operators', owner).expect(200);
    expect(
      ops.body.data.map((o: { telegramId: string }) => o.telegramId),
    ).toEqual(s.members.map((m) => m.telegramId.toString()));
    await get('/assist/account/operators', op).expect(403);
  });

  it('initData бота QA — 403 на маршрутах помощника; крон без секрета — отказ', async () => {
    const s = await st.handoffSite({ operators: 0 });
    await request(http.server())
      .get(`/assist/sites/${s.siteId}/conversations`)
      .set(http.as(s.members[0].telegramId, 'qa'))
      .expect(403);
    const cron = await request(http.server()).get('/cron/assist-handoff-tick');
    expect([401, 403, 503]).toContain(cron.status);
  });
});
