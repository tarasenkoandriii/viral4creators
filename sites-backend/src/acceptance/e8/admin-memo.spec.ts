/**
 * Приёмка Э8 п.7 — мемо «Админки» АМ-N (ТЗ §5-бис.17 п.10, п.15 п.17;
 * Р-61, Р-68, Р-69):
 *  - шаг-клик («Сохранить») в мемо «Админки» не сохраняется (422);
 *  - две write в мемо — два «Да» (каждое изменение — своё предложение);
 *  - сотрудник без прав на операцию — отказ при вызове «АМ-N»;
 *  - `SELECT` под `assist_public` из `assist_admin_memo*` — отказ;
 * плюс: номер не переиспользуется, фраза — одна сущность (409), ключ
 * неизменен после публикации, ревизия черновика (409), журнал `memo`.
 */
import { Client } from 'pg';
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER } from '../../brand';
import { signEmployeeJwt } from '../../modules/assist-admin-mode/identity-jwt';
import type { E7Site } from '../e7/e7-stack';
import { AdminVoiceStack, dryRunMemo } from '../e6b-admin/admin-voice-stack';
import { AdminMemoService } from '../../modules/assist-admin-actions/admin-memo.service';
import { ShopApi, actionsSpec, describeE8 } from './e8-stack';

jest.setTimeout(120_000);

describeE8('Э8 п.7 — мемо «Админки» АМ-N', () => {
  // Аудит 06.10: стенд с голосовым модулем «Админки» — в нём сухой прогон
  // мемо (публикация без прогона — 409 MEMO_CHECK_REQUIRED).
  const st = new AdminVoiceStack();
  const shop = new ShopApi();
  let S: E7Site;
  let identitySecret = '';
  const ops: Record<string, string> = {};
  const body = (r: request.Response) => r.body.data ?? r.body;
  const mutations = () =>
    st.net.requests.filter(
      (q) => q.key.startsWith(S.apiHost) && q.method !== 'GET',
    );
  const memos = () => `/assist/sites/${S.siteId}/admin-mode/memos`;

  async function session(sub: string, role = 'manager'): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    const jwt = signEmployeeJwt(
      { sub, role, name: sub, aud: S.siteId, iat: t, exp: t + 600 },
      identitySecret,
    );
    const r = await request(st.srv())
      .post('/assist-admin/v1/session')
      .send({ pk: S.pk, jwt })
      .expect(200);
    return body(r).session;
  }
  const ask = (sess: string, text: string) =>
    request(st.srv())
      .post('/assist-admin/v1/chat')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ text })
      .expect(200)
      .then((r) => body(r));
  const confirm = (sess: string, p: { id: string; paramsHash: string }) =>
    request(st.srv())
      .post(`/assist-admin/v1/proposals/${p.id}/confirm`)
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ paramsHash: p.paramsHash });

  const shipMemo = (trigger = 'відвантаж замовлення') => ({
    names: { uk: 'Відвантажити замовлення' },
    triggers: { uk: [trigger] },
    goal: { text: { uk: 'Замовлення відвантажено, нотатку додано' } },
    slots: [{ name: 'order', kind: 'number' }],
    steps: [
      { action: 'api', op: ops.getOrder, args: { id: { slot: 'order' } } },
      {
        action: 'api',
        op: ops.updateOrderStatus,
        args: { id: { slot: 'order' }, status: { const: 'shipped' } },
      },
      {
        action: 'api',
        op: ops.addNote,
        args: { id: { slot: 'order' }, text: { const: 'Відвантажено' } },
      },
    ],
  });

  beforeAll(async () => {
    await st.init();
    st.text.planner = () => [];
    S = await st.site({ plan: 'pro' });
    st.net.site(S.apiHost, {
      '/openapi.json': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: actionsSpec(S.apiHost),
      },
      ...shop.routes(),
    });
    await request(st.srv())
      .patch(`/assist/sites/${S.siteId}/admin-mode`)
      .set(st.as(S.ownerTg))
      .send({
        enabled: true,
        access: 'both',
        adminHostIds: [S.adminHostId],
        roleMap: { manager: 'orders', intern: 'readers' },
      })
      .expect(200);
    identitySecret = body(
      await request(st.srv())
        .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
        .set(st.as(S.ownerTg))
        .expect(200),
    ).secret;
    const c = body(
      await request(st.srv())
        .post(`/assist/sites/${S.siteId}/connectors`)
        .set(st.as(S.ownerTg))
        .send({ name: 'shop', specUrl: `https://${S.apiHost}/openapi.json` })
        .expect(201),
    );
    for (const o of c.operations) ops[o.operationId] = o.id;
    const patch = (op: string, b: Record<string, unknown>) =>
      request(st.srv())
        .patch(`/assist/sites/${S.siteId}/connectors/${c.id}/operations/${op}`)
        .set(st.as(S.ownerTg))
        .send(b)
        .expect(200);
    await patch('getOrder', { enabled: true, roles: ['orders', 'readers'] });
    await patch('updateOrderStatus', { enabled: true, roles: ['orders'] });
    await patch('addNote', { enabled: true, roles: ['orders'] });
  });

  afterAll(() => st.close());

  it('шаг-клик «Сохранить» в мемо «Админки» не сохраняется — 422', async () => {
    const r = await request(st.srv())
      .post(memos())
      .set(st.as(S.ownerTg))
      .send({
        draft: {
          names: { uk: 'Зберегти картку' },
          steps: [
            {
              action: 'click',
              page: '/admin/orders/*',
              target: { pin: { role: 'button', text: 'Зберегти' } },
            },
          ],
        },
      });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/Шаг-клик/);
  });

  let memoN = 0;
  it('мемо: номер АМ-N, ворота, публикация подтверждением владельца; журнал memo', async () => {
    const created = body(
      await request(st.srv())
        .post(memos())
        .set(st.as(S.ownerTg))
        .send({ draft: shipMemo() })
        .expect(201),
    );
    memoN = created.number;
    expect(memoN).toBe(1);
    expect(created.key).toMatch(/^[a-z0-9-]+$/);
    // Ревизия черновика: устаревшая — 409.
    await request(st.srv())
      .patch(`${memos()}/${memoN}/draft`)
      .set(st.as(S.ownerTg))
      .send({ expectedRevision: 5, draft: shipMemo() })
      .expect(409);
    const v = body(
      await request(st.srv())
        .post(`${memos()}/${memoN}/versions`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    expect(v).toMatchObject({ version: 1, status: 'checking' });
    expect(v.gateReport.kinds).toEqual(['read', 'write', 'write']);
    // Шаги `api` в прогоне не исполняются — только каталог и права.
    const before = st.net.requests.length;
    const check = await dryRunMemo(st, S, memoN, await session('owner-check'));
    expect(check.result).toBe('pass');
    expect(st.net.requests.length).toBe(before);
    await request(st.srv())
      .post(`${memos()}/${memoN}/versions/1/publish`)
      .set(st.as(S.ownerTg))
      .expect(200);
    // Ключ после публикации не меняется.
    await request(st.srv())
      .patch(`${memos()}/${memoN}/draft`)
      .set(st.as(S.ownerTg))
      .send({ expectedRevision: 0, draft: shipMemo(), key: 'other-key' })
      .expect(422);
    const log = await st.prisma.assistAdminActionLog.findMany({
      where: { siteId: S.siteId, kind: 'memo' },
    });
    expect(log.map((l) => l.outcome)).toEqual(
      expect.arrayContaining(['create', 'build', 'publish']),
    );
  });

  it('две write в мемо — два «Да»: вызов «АМ-1» → 0 изменений; каждое «Да» — ровно одно', async () => {
    const a = await session('emp-M');
    const before = mutations().length;
    const r = await ask(a, 'виконай АМ-1 1042');
    const p1 = r.answer.proposal;
    expect(p1).toMatchObject({
      status: 'pending',
      kind: 'write',
      unrequested: false,
    });
    expect(p1.memo).toMatchObject({ step: 1 });
    expect(mutations().length).toBe(before);
    // Чтение (шаг 1) исполнено сразу, без «Да».
    expect(
      st.net.requests.some(
        (q) => q.key === `${S.apiHost}/v1/orders/1042` && q.method === 'GET',
      ),
    ).toBe(true);
    const c1 = body(await confirm(a, p1).expect(200));
    expect(mutations().slice(before)).toHaveLength(1);
    const p2 = c1.next;
    expect(p2).toMatchObject({
      status: 'pending',
      kind: 'write',
      memo: { step: 2 },
    });
    expect(shop.orders.get('1042')!.status).toBe('shipped');
    expect(shop.orders.get('1042')!.notes).toHaveLength(0);
    const c2 = body(await confirm(a, p2).expect(200));
    expect(mutations().slice(before)).toHaveLength(2);
    expect(shop.orders.get('1042')!.notes).toEqual(['Відвантажено']);
    expect(c2.text).toMatch(/АМ-1 виконано|АМ-1 выполнено/);
    const run = await st.prisma.assistAdminMemoRun.findFirstOrThrow({
      where: { siteId: S.siteId, actor: 'jwt:emp-M' },
    });
    expect(run).toMatchObject({
      status: 'done',
      goalStatus: 'reached',
      slots: null,
    });
  });

  it('вызов фразой владельца; «Нет» на шаге — мемо остановлено, перечень сделанного', async () => {
    const a = await session('emp-N');
    const r = await ask(a, 'відвантаж замовлення 1043');
    const p1 = r.answer.proposal;
    expect(p1.memo.step).toBe(1);
    const rej = body(
      await request(st.srv())
        .post(`/assist-admin/v1/proposals/${p1.id}/reject`)
        .set(ADMIN_SESSION_HEADER, a)
        .expect(200),
    );
    expect(rej.text).toMatch(/зупинено|остановлено/);
    expect(shop.orders.get('1043')!.status).toBe('paid');
  });

  it('сотрудник без прав на операцию — отказ при вызове «АМ-N» (мемо не расширяет права)', async () => {
    const intern = await session('emp-R', 'intern');
    const before = mutations().length;
    const r = await ask(intern, 'АМ-1 1042');
    expect(r.answer.proposal).toBeNull();
    expect(r.answer.text).toMatch(/немає прав|нет прав/);
    expect(mutations().length).toBe(before);
    expect(
      await st.prisma.assistAdminMemoRun.count({
        where: { siteId: S.siteId, actor: 'jwt:emp-R' },
      }),
    ).toBe(0);
    // Несуществующий номер — тот же ответ, что и выключенное мемо.
    const a = await session('emp-M');
    expect((await ask(a, 'АМ-77 1042')).answer.text).toMatch(/АМ-77/);
  });

  it('номер не переиспользуется; фраза — одна сущность (409); Business — мемо нельзя (402)', async () => {
    const m2 = body(
      await request(st.srv())
        .post(memos())
        .set(st.as(S.ownerTg))
        .send({ draft: shipMemo('інша фраза') })
        .expect(201),
    );
    expect(m2.number).toBe(2);
    await request(st.srv())
      .delete(`${memos()}/2`)
      .set(st.as(S.ownerTg))
      .expect(200);
    const m3 = body(
      await request(st.srv())
        .post(memos())
        .set(st.as(S.ownerTg))
        .send({ draft: { ...shipMemo(), names: { uk: 'Друге мемо' } } })
        .expect(201),
    );
    expect(m3.number).toBe(3);
    await request(st.srv())
      .post(`${memos()}/3/versions`)
      .set(st.as(S.ownerTg))
      .expect(200);
    // Прогон видит занятую фразу — `partial` (предупреждение), публикация —
    // 409 уникального индекса фраз.
    const check = await dryRunMemo(st, S, 3, await session('owner-check3'));
    expect(check.result).toBe('partial');
    const conflict = await request(st.srv())
      .post(`${memos()}/3/versions/1/publish`)
      .set(st.as(S.ownerTg));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('MEMO_CONFLICT');
    const biz = await st.site({ plan: 'business' });
    await request(st.srv())
      .post(`/assist/sites/${biz.siteId}/admin-mode/memos`)
      .set(st.as(biz.ownerTg))
      .send({ draft: { names: { uk: 'Х' } } })
      .expect(402);
  });

  // D3 (ТЗ §5-бис.17 п.5 п.8): мемо, ушедшее в «требует проверки» или
  // выключенное посреди запуска, не исполняет следующий шаг.
  it('D3: мемо выключено, пока шаг ждёт «Да», — шаг не исполняется, запуск остановлен с причиной', async () => {
    const a = await session('emp-D1');
    const before = mutations().length;
    const r = await ask(a, 'виконай АМ-1 2001');
    const p1 = r.answer.proposal;
    expect(p1).toMatchObject({ status: 'pending', memo: { step: 1 } });
    await request(st.srv())
      .post(`${memos()}/1/disable`)
      .set(st.as(S.ownerTg))
      .expect(200);
    try {
      const c = await confirm(a, p1).expect(409);
      expect(c.body.error.code).toBe('MEMO_HALTED');
      expect(c.body.error.message).toMatch(/вимкнув мемо/);
      expect(c.body.error.message).toMatch(/кроком 2/);
      expect(mutations().length).toBe(before);
      expect(shop.orders.get('2001')!.status).toBe('paid');
      const run = await st.prisma.assistAdminMemoRun.findFirstOrThrow({
        where: { siteId: S.siteId, actor: 'jwt:emp-D1' },
      });
      expect(run).toMatchObject({
        status: 'stopped',
        goalStatus: 'not_reached',
        slots: null,
      });
      expect(run.progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: 'halted:disabled' }),
        ]),
      );
      const prop = await st.prisma.assistAdminActionProposal.findUniqueOrThrow({
        where: { id: p1.id },
      });
      expect(prop.status).toBe('rejected');
      // Повторное «Да» тоже не исполняет.
      await confirm(a, p1).expect(409);
      expect(mutations().length).toBe(before);
    } finally {
      await request(st.srv())
        .post(`${memos()}/1/enable`)
        .set(st.as(S.ownerTg))
        .expect(200);
    }
  });

  it('аудит пакета C (P3-8): шаг мемо в unknown, мемо выключено — 409 MEMO_HALTED (не 500), карточка expired', async () => {
    const a = await session('emp-D-unk');
    const before = mutations().length;
    const p1 = (await ask(a, 'виконай АМ-1 1043')).answer.proposal;
    expect(p1).toMatchObject({ status: 'pending', memo: { step: 1 } });
    // Шаг исполнялся, исход неизвестен (процесс умер посреди «Да»).
    await st.prisma.assistAdminActionProposal.updateMany({
      where: { id: p1.id },
      data: { status: 'executing', attempts: 1, decidedAt: new Date() },
    });
    await st.prisma.assistAdminActionProposal.updateMany({
      where: { id: p1.id },
      data: { status: 'unknown', outcome: 'stale' },
    });
    await request(st.srv())
      .post(`${memos()}/1/disable`)
      .set(st.as(S.ownerTg))
      .expect(200);
    try {
      const c = await confirm(a, p1);
      expect(c.status).toBe(409);
      expect(c.body.error.code).toBe('MEMO_HALTED');
      const prop = await st.prisma.assistAdminActionProposal.findUniqueOrThrow({
        where: { id: p1.id },
      });
      expect(prop).toMatchObject({ status: 'expired', outcome: 'memo_halted' });
      expect(mutations().length).toBe(before);
    } finally {
      await request(st.srv())
        .post(`${memos()}/1/enable`)
        .set(st.as(S.ownerTg))
        .expect(200);
    }
  });

  it('D3: мемо ушло в «требует проверки» между шагами — advance не исполняет следующий шаг', async () => {
    const a = await session('emp-D2');
    const r = await ask(a, 'виконай АМ-1 3001');
    const p1 = r.answer.proposal;
    expect(p1).toMatchObject({ status: 'pending', memo: { step: 1 } });
    const memo = await st.prisma.assistAdminMemo.findFirstOrThrow({
      where: { siteId: S.siteId, number: 1 },
    });
    // Монитор пометил мемо (как после серии сбоев у других сотрудников),
    // пока шаг 2 этого запуска исполнялся.
    await st.prisma.assistAdminMemo.update({
      where: { id: memo.id },
      data: { status: 'needs_review' },
    });
    try {
      const run = await st.prisma.assistAdminMemoRun.findFirstOrThrow({
        where: { siteId: S.siteId, actor: 'jwt:emp-D2' },
      });
      const before = mutations().length;
      const svc = st.app.get(AdminMemoService);
      const next = await svc.afterStep(
        {
          accountId: run.accountId,
          siteId: S.siteId,
          actor: 'jwt:emp-D2',
          actorRole: 'manager',
          actorExternal: 'emp-D2',
          channel: 'embed',
          conversationId: run.conversationId,
          assistRole: 'orders',
          lang: 'uk',
        },
        run.id,
        1,
        'done',
      );
      expect(next.next).toBeNull();
      expect(next.text).toMatch(/зупинено перед кроком 3/);
      expect(next.text).toMatch(/потребує перевірки/);
      expect(mutations().length).toBe(before);
      expect(
        await st.prisma.assistAdminActionProposal.count({
          where: { memoRunId: run.id, memoStep: 2 },
        }),
      ).toBe(0);
      const after = await st.prisma.assistAdminMemoRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(after).toMatchObject({ status: 'stopped', step: 2 });
      // План голосового управления с этим запуском — тоже причина, не шаги.
      const halted = await svc.haltRun(
        {
          accountId: run.accountId,
          siteId: S.siteId,
          actor: 'jwt:emp-D2',
          actorRole: 'manager',
          actorExternal: 'emp-D2',
          channel: 'embed',
          conversationId: run.conversationId,
          assistRole: 'orders',
          lang: 'ru',
        },
        run.id,
      );
      expect(halted?.text).toMatch(/требует проверки/);
    } finally {
      await st.prisma.assistAdminMemo.update({
        where: { id: memo.id },
        data: { status: 'published' },
      });
    }
  });

  it('SELECT под assist_public из assist_admin_memo* — отказ (§4.3-бис слой 3)', async () => {
    const url = process.env.ASSIST_PUBLIC_DATABASE_URL;
    if (!url) return;
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      for (const t of [
        'assist_admin_memos',
        'assist_admin_memo_versions',
        'assist_admin_memo_runs',
        'assist_admin_phrases',
        'assist_admin_action_proposals',
      ]) {
        await expect(
          client.query(`SELECT 1 FROM sites."${t}" LIMIT 1`),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.end();
    }
  });
});
