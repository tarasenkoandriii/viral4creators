/**
 * Приёмка захода 13, пакет Б (Р-З13-Б1, Р-З13-Б2) — TMA, раздел «Роли»
 * «Админки»: «сопоставить мою роль у заказчика с ролью помощника owner»
 * (хвост захода 11: раньше — только подсказка 409
 * `ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED` у ссылки редактора карты). По HTTP
 * на Postgres с настоящими гвардами (initData, SiteAccountGuard, права по
 * продукту), конвертом ошибок и ValidationPipe:
 *  - права: только `assistAdmin: owner`; менеджер «Сайта» и сотрудник
 *    «Админки» — 403; чужой кабинет — 404; мусорная роль — 400;
 *  - одна пара, остальные не трогаются; уже `owner` — без записи; прежнее
 *    значение заменяется (в ответе и журнале — `from`); 30 пар — 409;
 *  - журнал «Админки» (`kind: settings`): кто, роль, было → стало; журнал
 *    не записался — пара возвращена, ответ — ошибка;
 *  - после пары ссылка редактора карты выдаётся (409 больше нет);
 *  - общая правка карты ролей (`PATCH …/admin-mode`) — тоже строка журнала
 *    (какие пары появились/изменились/сняты), без карты ролей — нет строки.
 */
import * as request from 'supertest';
import { AssistAdminVoiceMapModule } from '../../modules/assist-admin-voice-map/assist-admin-voice-map.module';
import { AdminActionLogService } from '../../modules/assist-admin-mode/action-log.service';
import { describeE7, E7Stack, type E7Site } from '../e7/e7-stack';

jest.setTimeout(240_000);

class Stack extends E7Stack {
  protected override extraModules() {
    return [AssistAdminVoiceMapModule];
  }
}

const data = (r: { body: unknown }) =>
  (r.body as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
const code = (r: { body: unknown }) =>
  (r.body as { error?: { code?: string } }).error?.code;

describeE7('Заход 13 (Б): «Роли» «Админки» — моя роль → owner', () => {
  const st = new Stack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(() => st.close());

  const mode = (s: E7Site) => `/assist/sites/${s.siteId}/admin-mode`;
  const map = (s: E7Site, role: unknown, tg = s.ownerTg) =>
    request(st.srv())
      .post(`${mode(s)}/role-map/owner`)
      .set(st.as(tg))
      .send({ role });
  const roleMap = async (s: E7Site) =>
    (
      await st.prisma.assistAdminSettings.findFirstOrThrow({
        where: { siteId: s.siteId },
      })
    ).roleMap;
  const journal = (s: E7Site) =>
    st.prisma.assistAdminActionLog.findMany({
      where: { siteId: s.siteId, kind: 'settings' },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
  const link = (s: E7Site) =>
    request(st.srv())
      .post(`${mode(s)}/voice-map/editor-link`)
      .set(st.as(s.ownerTg))
      .send({});

  async function proSite(): Promise<E7Site> {
    const s = await st.site({ plan: 'pro' });
    await request(st.srv())
      .patch(mode(s))
      .set(st.as(s.ownerTg))
      .send({
        adminHostIds: [s.adminHostId],
        roleMap: { manager: 'orders', intern: 'readers' },
      })
      .expect(200);
    return s;
  }

  it('без пары → owner ссылки нет (409); «моя роль → owner» — одна пара, журнал; повтор — без записи; ссылка выдаётся', async () => {
    const s = await proSite();
    const no = await link(s);
    expect(no.status).toBe(409);
    expect(code(no)).toBe('ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED');
    const before = (await journal(s)).length;

    const r = data(await map(s, 'director').expect(200));
    expect(r).toMatchObject({
      role: 'director',
      previous: null,
      changed: true,
    });
    expect(r.view.roleMap).toEqual({
      manager: 'orders',
      intern: 'readers',
      director: 'owner',
    });
    expect(await roleMap(s)).toEqual(r.view.roleMap);
    const rows = await journal(s);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actor: `tg:${s.ownerTg}`,
      actorRole: 'owner',
      channel: 'tma',
      operation: 'role-map.owner',
      outcome: 'ok',
      requestMasked: { role: 'director', from: null, to: 'owner' },
    });
    // Цепочка журнала цела (хеши, строка `settings` в ней).
    expect(
      await st.app
        .get(AdminActionLogService)
        .verifyChain(s.accountId, s.siteId),
    ).toBe(-1);

    const again = data(await map(s, 'director').expect(200));
    expect(again).toMatchObject({ previous: 'owner', changed: false });
    expect(await journal(s)).toHaveLength(before + 1);

    const l = await link(s).expect(200);
    expect(data(l).url).toMatch(/^https:\/\//);
  });

  it('прежнее значение пары заменяется (`from` в журнале), прочие пары целы; 30 пар — 409; мусорная роль — 400', async () => {
    const s = await proSite();
    const r = data(await map(s, 'manager').expect(200));
    expect(r).toMatchObject({ previous: 'orders', changed: true });
    expect(await roleMap(s)).toEqual({ manager: 'owner', intern: 'readers' });
    expect((await journal(s)).at(-1)?.requestMasked).toEqual({
      role: 'manager',
      from: 'orders',
      to: 'owner',
    });
    // Аудит P3-1: «__proto__» — 400 (раньше: 200 и строка журнала без пары).
    for (const bad of ['', 'a b', 'x'.repeat(65), 42, '<b>', '__proto__']) {
      const res = await map(s, bad);
      expect(res.status).toBe(400);
    }
    const proto = await request(st.srv())
      .patch(mode(s))
      .set(st.as(s.ownerTg))
      .set('content-type', 'application/json')
      .send('{"roleMap":{"__proto__":"owner","boss":"owner"}}');
    // Ключ «__proto__» из JSON до разбора карты не доходит (транспорт тела):
    // в базе и в журнале — ровно то, что сохранено, без «__proto__».
    expect(proto.status).toBe(200);
    expect(await roleMap(s)).toEqual({ boss: 'owner' });
    expect((await journal(s)).at(-1)?.requestMasked).toEqual({
      set: { boss: 'owner' },
      removed: ['intern', 'manager'],
    });
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: s.siteId },
      data: { roleMap: { manager: 'owner', intern: 'readers' } },
    });
    const full = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`role${i}`, 'readers']),
    );
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: s.siteId },
      data: { roleMap: full },
    });
    const over = await map(s, 'boss');
    expect(over.status).toBe(409);
    expect(code(over)).toBe('ADMIN_ROLEMAP_INVALID');
    // Существующую пару из 30 заменить можно (пар не прибавляется).
    await map(s, 'role7').expect(200);
    expect((await roleMap(s)) as Record<string, string>).toMatchObject({
      role7: 'owner',
    });
  });

  it('гонка: пять «моя роль → owner» разных ролей одновременно — все пары на месте (замок сайта + условный UPDATE), прочие целы', async () => {
    const s = await proSite();
    const roles = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const res = await Promise.all(roles.map((r) => map(s, r)));
    for (const r of res) expect(r.status).toBe(200);
    expect(await roleMap(s)).toEqual({
      manager: 'orders',
      intern: 'readers',
      ...Object.fromEntries(roles.map((r) => [r, 'owner'])),
    });
    expect(await journal(s)).toHaveLength(1 + roles.length);
  });

  it('права: менеджер «Сайта», сотрудник «Админки» — 403; чужой кабинет — 404; карта не меняется', async () => {
    const s = await proSite();
    const other = await proSite();
    const manager = await st.member(s, 'manager', { assist: 'manager' });
    const employee = await st.member(s, 'operator', {
      assistAdmin: 'employee',
    });
    expect((await map(s, 'director', manager)).status).toBe(403);
    expect((await map(s, 'director', employee)).status).toBe(403);
    expect((await map(s, 'director', other.ownerTg)).status).toBe(404);
    expect(await roleMap(s)).toEqual({ manager: 'orders', intern: 'readers' });
    expect(await journal(s)).toHaveLength(1); // только PATCH из proSite()
  });

  it('журнал не записался — ни пары owner, ни правки PATCH: изменение и строка журнала — одна транзакция (аудит P2-1/P3-2)', async () => {
    const s = await proSite();
    const log = st.app.get(AdminActionLogService);
    const spy = jest
      .spyOn(log, 'appendIn')
      .mockRejectedValueOnce(new Error('журнал недоступен'))
      .mockRejectedValueOnce(new Error('журнал недоступен'));
    try {
      expect((await map(s, 'director')).status).toBe(500);
      const p = await request(st.srv())
        .patch(mode(s))
        .set(st.as(s.ownerTg))
        .send({ roleMap: { boss: 'owner' }, instructions: 'Нове' });
      expect(p.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await roleMap(s)).toEqual({ manager: 'orders', intern: 'readers' });
    const row = await st.prisma.assistAdminSettings.findFirstOrThrow({
      where: { siteId: s.siteId },
    });
    expect(row.instructions).toBeNull();
    expect(await journal(s)).toHaveLength(1); // только PATCH из proSite()
    // Повтор после сбоя — правка и её строка журнала.
    await map(s, 'director').expect(200);
    expect(await journal(s)).toHaveLength(2);
  });

  it('аудит P3-6: `expectedPrevious` — пару изменили после показа экрана → 409 ADMIN_ROLEMAP_CHANGED, карта и журнал прежние; совпало — замена', async () => {
    const s = await proSite();
    const stale = await request(st.srv())
      .post(`${mode(s)}/role-map/owner`)
      .set(st.as(s.ownerTg))
      .send({ role: 'manager', expectedPrevious: 'readers' });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('ADMIN_ROLEMAP_CHANGED');
    const absent = await request(st.srv())
      .post(`${mode(s)}/role-map/owner`)
      .set(st.as(s.ownerTg))
      .send({ role: 'manager', expectedPrevious: null });
    expect(code(absent)).toBe('ADMIN_ROLEMAP_CHANGED');
    expect(await roleMap(s)).toEqual({ manager: 'orders', intern: 'readers' });
    expect(await journal(s)).toHaveLength(1);
    await request(st.srv())
      .post(`${mode(s)}/role-map/owner`)
      .set(st.as(s.ownerTg))
      .send({ role: 'manager', expectedPrevious: 'BAD ROLE' })
      .expect(400);
    await request(st.srv())
      .post(`${mode(s)}/role-map/owner`)
      .set(st.as(s.ownerTg))
      .send({ role: 'manager', expectedPrevious: 'orders' })
      .expect(200);
    await request(st.srv())
      .post(`${mode(s)}/role-map/owner`)
      .set(st.as(s.ownerTg))
      .send({ role: 'director', expectedPrevious: null })
      .expect(200);
    // Уже owner — 200 без записи, какое бы `expectedPrevious` ни прислали.
    const again = data(
      await request(st.srv())
        .post(`${mode(s)}/role-map/owner`)
        .set(st.as(s.ownerTg))
        .send({ role: 'director', expectedPrevious: null })
        .expect(200),
    );
    expect(again.changed).toBe(false);
    expect(await roleMap(s)).toEqual({
      manager: 'owner',
      intern: 'readers',
      director: 'owner',
    });
    expect(await journal(s)).toHaveLength(3);
  });

  it('аудит P2-2: гонка PATCH всей карты и «моя роль → owner» — журнал, проигранный по порядку, даёт ровно карту в базе', async () => {
    const s = await proSite();
    for (let i = 0; i < 6; i++) {
      await Promise.all([
        request(st.srv())
          .patch(mode(s))
          .set(st.as(s.ownerTg))
          .send({ roleMap: { a: 'readers', [`p${i}`]: 'orders' } }),
        map(s, `d${i}`),
      ]).then((rs) => rs.forEach((r) => expect(r.status).toBe(200)));
    }
    let replay: Record<string, string> = {};
    for (const r of await journal(s)) {
      const q = r.requestMasked as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (r.operation === 'role-map') {
        replay = { ...replay, ...q.set };
        for (const k of q.removed as string[]) delete replay[k];
      } else replay = { ...replay, [q.role]: q.to };
    }
    expect(replay).toEqual(await roleMap(s));
  });

  it('аудит P3-3: журнал фильтруется `?kind=settings`', async () => {
    const s = await proSite();
    await map(s, 'director').expect(200);
    const r = await request(st.srv())
      .get(`/assist/sites/${s.siteId}/action-log?kind=settings`)
      .set(st.as(s.ownerTg))
      .expect(200);
    expect(
      data(r)
        .map((x: { operation: string }) => x.operation)
        .sort(),
    ).toEqual(['role-map', 'role-map.owner']);
  });

  it('PATCH карты ролей — строка журнала с разницей (новые/изменённые/снятые); без карты ролей или без изменений — строки нет', async () => {
    const s = await proSite();
    const first = await journal(s);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      operation: 'role-map',
      requestMasked: {
        set: { manager: 'orders', intern: 'readers' },
        removed: [],
      },
    });
    await request(st.srv())
      .patch(mode(s))
      .set(st.as(s.ownerTg))
      .send({ roleMap: { manager: 'owner', boss: 'owner' } })
      .expect(200);
    expect((await journal(s)).at(-1)?.requestMasked).toEqual({
      set: { manager: 'owner', boss: 'owner' },
      removed: ['intern'],
    });
    await request(st.srv())
      .patch(mode(s))
      .set(st.as(s.ownerTg))
      .send({ roleMap: { boss: 'owner', manager: 'owner' } })
      .expect(200);
    await request(st.srv())
      .patch(mode(s))
      .set(st.as(s.ownerTg))
      .send({ instructions: 'Ввічливо' })
      .expect(200);
    expect(await journal(s)).toHaveLength(2);
  });
});
