/**
 * Приёмка захода 11, пакет А — №117 «голосовая карта „Админки“» и №62
 * «синоним „Сайта“ не действует в „Админке“» — на НАСТОЯЩЕМ Postgres через
 * HTTP (гварды initData, SiteAccountGuard, сессии employee-JWT), фейк-модель
 * плана «Админки». ТЗ §5-кватер.2 «Админка», §5-кватер.9 «Изоляция»
 * (К-9, У-28/У-29), §5-кватер.13, §5-кватер.14 п.14; В-55.
 *
 *  - права: только `assistAdmin: owner` (менеджер «Сайта», сотрудник
 *    «Админки» — 403); тариф Pro — изменения (402);
 *  - кабинет: CRUD целей/шаблонов в TMA, сборка → публикация → откат;
 *  - план сотрудника: фраза карты «Админки» — прямой путь без модели (и без
 *    глагола), denylist карты — вон из снимка до модели, `mapKey` в журнале;
 *  - №62: тот же синоним в опубликованной карте «Сайта» в «Админке» НЕ
 *    действует (модель, `mapKey` пуст);
 *  - редактор `wa.`: ссылка владельца + сессия сотрудника, привязка к ЭТОЙ
 *    сессии, «Сказать сейчас», запрос публикации (бот), публикация из панели
 *    — 403, выход; панель `we.` («Сайт») сессию «Админки» не принимает;
 *    iframe `/wa/v1/editor-frame` — frame-ancestors только хосты админки.
 */
import * as request from 'supertest';
import { HttpException } from '@nestjs/common';
import {
  ADMIN_SESSION_HEADER,
  EDITOR_SESSION_HEADER,
  WIDGET_EDITOR_PARAM,
  WIDGET_PK_LIVE_PREFIX,
} from '../../brand';
import { defaultAdminRules } from '../../modules/assist-admin-voice/admin-voice-rules';
import { AdminVoiceMapService } from '../../modules/assist-admin-voice-map/admin-voice-map.service';
import { AdminEditorSessionService } from '../../modules/assist-admin-voice-map/editor/admin-editor-session.service';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { AssistAdminVoiceMapModule } from '../../modules/assist-admin-voice-map/assist-admin-voice-map.module';
import { EditorSessionService } from '../../modules/assist-site-voice-map/editor/editor-session.service';
import { VoiceMapService } from '../../modules/assist-site-voice-map/voice-map.service';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { SitesDb } from '../../prisma/sites-db.service';
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
} from '../e6b-admin/admin-voice-stack';

jest.setTimeout(240_000);

class MapStack extends AdminVoiceStack {
  protected override extraModules() {
    return [...super.extraModules(), AssistAdminVoiceMapModule];
  }
}

describeE6bAdmin('Заход 11 (№117, №62) — голосовая карта «Админки»', () => {
  const st = new MapStack();
  const shop = new ShopApi();
  let R: Ready;
  let n = 0;
  const sent: string[] = [];

  beforeAll(async () => {
    await st.init();
    R = await readySite(st, shop);
    await ownerRole(R);
    await forceOn(st, R);
    const maps = st.app.get(AdminVoiceMapService);
    maps.env = {
      ...process.env,
      ASSIST_BOT_TOKEN: 'bot-test',
      ASSIST_TMA_URL: 'https://tma.example.com',
    };
    maps.fetchImpl = async (_url, init) => {
      sent.push(init.body);
      return { ok: true, status: 200 };
    };
  });
  afterAll(() => st.close());
  // Много сессий сотрудников в одном файле: окно «обменов в минуту с IP»
  // (защита входа) между тестами обнуляем — проверяет его acceptance/e7.
  beforeEach(async () => {
    await st.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_rate_buckets" WHERE "scope" = 'admin-session-ip-min'`,
    );
  });

  const base = (siteId = R.S.siteId) =>
    `/assist/sites/${siteId}/admin-mode/voice-map`;
  const owner = () => st.as(R.S.ownerTg);
  const session = (role = 'manager') =>
    employeeSession(st, R, `emp-map-${++n}`, role);
  /**
   * Раунд исправлений (аудит P2-1): редактор — только сотруднику «с ролью
   * владельца у заказчика»: роль JWT `director` в карте ролей → `owner`.
   */
  async function ownerRole(site: Ready) {
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: site.S.siteId },
      data: {
        roleMap: { manager: 'orders', intern: 'readers', director: 'owner' },
      },
    });
  }
  const ownerSession = (site: Ready = R) =>
    employeeSession(st, site, `emp-own-${++n}`, 'director');
  const lastPlanLog = async () =>
    (
      await st.prisma.assistAdminActionLog.findMany({
        where: { siteId: R.S.siteId, kind: 'ui-plan', operation: 'ui.plan' },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: 1,
      })
    )[0];

  const history = {
    tag: 'button',
    role: 'tab',
    text: 'Історія',
    toggle: true,
    unique: true,
  };

  async function revision(): Promise<number> {
    return data(
      await request(st.srv()).get(`${base()}/draft`).set(owner()).expect(200),
    ).revision as number;
  }

  async function publishAdmin(ops: unknown[]): Promise<number> {
    await request(st.srv())
      .patch(`${base()}/draft`)
      .set(owner())
      .send({ expectedRevision: await revision(), ops })
      .expect(200);
    const v = data(
      await request(st.srv())
        .post(`${base()}/versions`)
        .set(owner())
        .expect(200),
    );
    expect(v.status).toBe('checking');
    const p = data(
      await request(st.srv())
        .post(`${base()}/versions/${v.number}/publish`)
        .set(owner())
        .expect(200),
    );
    expect(p.status).toBe('published');
    return v.number as number;
  }

  it('права: менеджер «Сайта» и сотрудник «Админки» — 403; владелец — 200; тариф Business — изменения 402, сводка — да', async () => {
    const mgr = await st.member(R.S, 'manager', { assist: 'manager' });
    const emp = await st.member(R.S, 'manager', { assistAdmin: 'employee' });
    for (const tg of [mgr, emp]) {
      await request(st.srv()).get(base()).set(st.as(tg)).expect(403);
      await request(st.srv())
        .post(`${base()}/editor-link`)
        .set(st.as(tg))
        .send({})
        .expect(403);
    }
    const sum = data(
      await request(st.srv()).get(base()).set(owner()).expect(200),
    );
    expect(sum).toMatchObject({
      publishedVersion: 0,
      planAllows: true,
      hosts: [R.S.adminHost],
    });
    // Хост публичного сайта в карте «Админки» не участвует.
    expect(sum.hosts).not.toContain(R.S.host);

    const B = await readySite(st, shop, { plan: 'business', enableOps: false });
    const r = await request(st.srv())
      .patch(`${base(B.S.siteId)}/draft`)
      .set(st.as(B.S.ownerTg))
      .send({ expectedRevision: 0, ops: [] })
      .expect(402);
    expect(r.body.error.code).toBe('ADMIN_VOICE_MAP_PLAN_REQUIRED');
    expect(
      data(
        await request(st.srv())
          .get(base(B.S.siteId))
          .set(st.as(B.S.ownerTg))
          .expect(200),
      ).planAllows,
    ).toBe(false);
  });

  it('№62: синоним опубликованной карты «Сайта» в «Админке» не действует — модель, `mapKey` пуст; та же фраза в карте «Админки» — прямой путь без модели', async () => {
    // Карта «Сайта» того же сайта: вкладка «Історія», синоним «журнал змін».
    const db = new SitesDb(st.prisma);
    const siteMaps = new VoiceMapService(db);
    const om = await st.prisma.siteAccountMember.findFirstOrThrow({
      where: { accountId: R.S.accountId, telegramId: R.S.ownerTg },
    });
    const m = {
      accountId: R.S.accountId,
      memberId: om.id,
      telegramId: R.S.ownerTg,
      role: 'owner',
      productRoles: {},
    } as unknown as AccountMembership;
    const d = await siteMaps.draft(m, R.S.siteId);
    await siteMaps.patch(
      m,
      R.S.siteId,
      {
        expectedRevision: d.revision,
        ops: [
          {
            op: 'upsert-target',
            target: {
              key: 'history',
              scope: 'site',
              descriptor: history,
              names: { uk: 'Історія' },
              synonyms: { uk: [{ text: 'журнал змін' }] },
            },
          },
        ],
      },
      'tma',
    );
    const sv = await siteMaps.buildVersion(m, R.S.siteId, 'tma');
    await siteMaps.publish(m, R.S.siteId, String(sv.number));
    expect(
      await st.prisma.assistSitePhrase.count({
        where: { siteId: R.S.siteId, norm: 'журнал змін' },
      }),
    ).toBe(1);

    const sess = await session();
    st.text.uiModel = () => ({ steps: [] });
    const calls = st.text.uiCalls.length;
    const viaModel = data(
      await api(st, sess)
        .plan({
          text: 'відкрий журнал змін',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(st.text.uiCalls.length).toBe(calls + 1);
    expect(viaModel.steps).toEqual([]);
    expect((await lastPlanLog()).requestMasked).toMatchObject({
      origin: 'model',
      mapKey: null,
      mapMiss: false,
    });
    // Без глагола фраза «Сайта» в «Админке» — не команда (карта чужая).
    const bare = data(
      await api(st, sess)
        .plan({ text: 'журнал змін', snapshot: orderPage(R.S.adminHost) })
        .expect(200),
    );
    expect(bare.kind).toBe('not_command');

    // Та же фраза — в карте «Админки»: прямой путь без модели (и без глагола).
    const v = await publishAdmin([
      {
        op: 'upsert-target',
        target: {
          key: 'history',
          scope: 'site',
          descriptor: history,
          names: { uk: 'Історія замовлення', en: 'Order history' },
          synonyms: { uk: [{ text: 'журнал змін' }] },
        },
      },
    ]);
    const direct = data(
      await api(st, sess)
        .plan({
          text: 'відкрий журнал змін',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(st.text.uiCalls.length).toBe(calls + 1);
    expect(direct.kind).toBe('plan');
    expect(direct.steps[0].target.ref).toBe('e13');
    // Имена владельца в ответ сотруднику не уходят.
    expect(JSON.stringify(direct)).not.toContain('Order history');
    expect((await lastPlanLog()).requestMasked).toMatchObject({
      origin: 'direct',
      mapKey: 'history',
      mapMiss: false,
      mapVersion: v,
    });
    const bareNow = data(
      await api(st, sess)
        .plan({ text: 'журнал змін', snapshot: orderPage(R.S.adminHost) })
        .expect(200),
    );
    expect(bareNow.kind).toBe('plan');
    expect(st.text.uiCalls.length).toBe(calls + 1);
    // Цель названа, а на странице её нет — промах карты в журнале.
    const page = orderPage(R.S.adminHost);
    (page.elements as Array<{ ref: string }>).splice(12, 1);
    await api(st, sess)
      .plan({ text: 'відкрий журнал змін', snapshot: page })
      .expect(200);
    expect((await lastPlanLog()).requestMasked).toMatchObject({
      mapKey: 'history',
      mapMiss: true,
    });
    // Карта «Сайта» не изменилась картой «Админки» (и наоборот).
    const siteVer = await st.prisma.assistSiteVoiceMapVersion.findFirstOrThrow({
      where: { siteId: R.S.siteId, status: 'published' },
    });
    expect(JSON.stringify(siteVer.content)).not.toContain('Order history');
  });

  it('denylist карты «Админки» — вон из снимка до модели; откат возвращает прежнюю версию новой', async () => {
    const sess = await session();
    st.text.uiModel = () => ({
      steps: [{ kind: 'click', target: 'e2', risk: 'auto' }],
    });
    const before = data(
      await api(st, sess)
        .plan({ text: 'відкрий клієнтів', snapshot: orderPage(R.S.adminHost) })
        .expect(200),
    );
    expect(
      before.steps.map((s: { target: { ref: string } }) => s.target.ref),
    ).toEqual(['e2']);
    const prev = data(
      await request(st.srv()).get(base()).set(owner()).expect(200),
    ).publishedVersion as number;
    await publishAdmin([
      {
        op: 'upsert-target',
        target: {
          key: 'customers',
          scope: 'site',
          descriptor: {
            tag: 'a',
            role: 'link',
            text: 'Клієнти',
            hrefPath: '/admin/customers',
            hrefHost: R.S.adminHost,
            unique: true,
          },
          denylisted: true,
        },
      },
    ]);
    const calls = st.text.uiCalls.length;
    const after = data(
      await api(st, sess)
        .plan({ text: 'відкрий клієнтів', snapshot: orderPage(R.S.adminHost) })
        .expect(200),
    );
    expect(st.text.uiCalls.length).toBe(calls + 1);
    expect(st.text.uiCalls[calls].user).not.toContain('Клієнти');
    expect(
      after.steps.some(
        (s: { target: { ref: string } | null }) => s.target?.ref === 'e2',
      ),
    ).toBe(false);
    // Откат на прежнюю версию — новая версия с её содержимым.
    const back = data(
      await request(st.srv())
        .post(`${base()}/versions/${prev}/rollback`)
        .set(owner())
        .expect(200),
    );
    expect(back).toMatchObject({ rollbackOf: prev, status: 'checking' });
    await request(st.srv())
      .post(`${base()}/versions/${back.number}/publish`)
      .set(owner())
      .expect(200);
    const again = data(
      await api(st, sess)
        .plan({ text: 'відкрий клієнтів', snapshot: orderPage(R.S.adminHost) })
        .expect(200),
    );
    expect(
      again.steps.map((s: { target: { ref: string } }) => s.target.ref),
    ).toEqual(['e2']);
    // Журнал кабинета: каждое изменение — строка `voice-map`.
    const ops = (
      await st.prisma.assistAdminActionLog.findMany({
        where: { siteId: R.S.siteId, kind: 'voice-map' },
        select: { operation: true, channel: true },
      })
    ).map((r) => r.operation);
    expect(ops).toEqual(
      expect.arrayContaining([
        'voice-map.draft',
        'voice-map.version',
        'voice-map.publish',
      ]),
    );
    const list = data(
      await request(st.srv())
        .get(`/assist/sites/${R.S.siteId}/action-log?kind=voice-map`)
        .set(owner())
        .expect(200),
    );
    expect((list as Array<{ kind: string }>).length).toBeGreaterThan(0);
    expect(
      (list as Array<{ kind: string }>).every((i) => i.kind === 'voice-map'),
    ).toBe(true);
  });

  it('TMA: шаблон страниц и цель на шаблоне; экспорт `kind: admin` → импорт файла «Сайта» — 422', async () => {
    const rev = await revision();
    // Шаблон — своим пакетом: id нового шаблона выдаёт сервер.
    const t1 = data(
      await request(st.srv())
        .patch(`${base()}/draft`)
        .set(owner())
        .send({
          expectedRevision: rev,
          ops: [
            {
              op: 'upsert-template',
              template: {
                name: 'Картка замовлення',
                pathPattern: '/admin/orders/*',
                samplePages: ['/admin/orders/1042'],
              },
            },
          ],
        })
        .expect(200),
    );
    const tpl = (
      data(
        await request(st.srv()).get(`${base()}/draft`).set(owner()).expect(200),
      ).content.templates as Array<{ id: string; pathPattern: string }>
    ).find((x) => x.pathPattern === '/admin/orders/*')!;
    const r = data(
      await request(st.srv())
        .patch(`${base()}/draft`)
        .set(owner())
        .send({
          expectedRevision: t1.revision,
          ops: [
            {
              op: 'upsert-target',
              target: {
                key: 'track',
                scope: 'template',
                templateId: tpl.id,
                descriptor: {
                  tag: 'input',
                  role: 'textbox',
                  text: 'Трек-номер',
                  inputType: 'text',
                  unique: true,
                },
                names: { uk: 'Трек-номер' },
              },
            },
          ],
        })
        .expect(200),
    );
    expect(r.applied).toBe(1);
    const draft = data(
      await request(st.srv()).get(`${base()}/draft`).set(owner()).expect(200),
    );
    expect(
      draft.content.targets.find((t: { key: string }) => t.key === 'track'),
    ).toMatchObject({ scope: 'template', templateId: tpl.id });
    const file = data(
      await request(st.srv()).get(`${base()}/export`).set(owner()).expect(200),
    ).file;
    expect(file.kind).toBe('admin');
    const bad = await request(st.srv())
      .post(`${base()}/import`)
      .set(owner())
      .send({ expectedRevision: r.revision, file: { ...file, kind: 'site' } })
      .expect(422);
    expect(bad.body.error.code).toBe('VOICE_MAP_IMPORT_KIND');
    // 409 — вторая вкладка со старой ревизией.
    const stale = await request(st.srv())
      .patch(`${base()}/draft`)
      .set(owner())
      .send({
        expectedRevision: rev,
        ops: [{ op: 'remove-target', key: 'track' }],
      })
      .expect(409);
    expect(stale.body.error.code).toBe('VOICE_MAP_CONFLICT');
  });

  it('редактор `wa.`: ссылка владельца + сессия сотрудника; привязка к ЭТОЙ сессии; «Сказать сейчас»; запрос публикации — в бот; публикация из панели — 403; выход', async () => {
    const link = data(
      await request(st.srv())
        .post(`${base()}/editor-link`)
        .set(owner())
        .send({ path: '/admin/orders/1042', focus: 'history' })
        .expect(200),
    );
    expect(link.url).toMatch(
      new RegExp(
        `^https://${R.S.adminHost.replace(/\./g, '\\.')}/admin/orders/1042\\?`,
      ),
    );
    const token = new URL(link.url).searchParams.get(WIDGET_EDITOR_PARAM)!;
    const origin = `https://${R.S.adminHost}`;
    const sess = await ownerSession();
    const post = (path: string, a: string | null, e: string | null) => {
      const r = request(st.srv()).post(`/assist-admin/v1/editor/${path}`);
      if (a) r.set(ADMIN_SESSION_HEADER, a);
      if (e) r.set(EDITOR_SESSION_HEADER, e);
      return r;
    };
    // Без сессии сотрудника — 401; чужой origin — 403 (ссылка не сгорает).
    await post('session', null, null)
      .send({ token, parentOrigin: origin })
      .expect(401);
    const wrong = await post('session', sess, null)
      .send({ token, parentOrigin: `https://${R.S.host}` })
      .expect(403);
    expect(wrong.body.error.code).toBe('EDITOR_LINK_INVALID');
    // Сессия сотрудника ДРУГОЙ «Админки» (другой сайт) — 403, не обмен.
    const B = await readySite(st, shop, { enableOps: false });
    await ownerRole(B);
    const foreign = await ownerSession(B);
    const cross = await post('session', foreign, null)
      .send({ token, parentOrigin: origin })
      .expect(403);
    expect(cross.body.error.code).toBe('EDITOR_LINK_INVALID');
    const ex = data(
      await post('session', sess, null)
        .send({ token, parentOrigin: origin })
        .expect(200),
    );
    expect(ex).toMatchObject({
      kind: 'admin',
      pagePath: '/admin/orders/1042',
      focusKey: 'history',
      host: R.S.adminHost,
    });
    const ed = ex.session as string;
    // Повторный обмен — 403.
    await post('session', sess, null)
      .send({ token, parentOrigin: origin })
      .expect(403);
    // Карта страницы: цели шаблона и сайта.
    const map = data(
      await request(st.srv())
        .get('/assist-admin/v1/editor/map?path=/admin/orders/1042')
        .set(ADMIN_SESSION_HEADER, sess)
        .set(EDITOR_SESSION_HEADER, ed)
        .expect(200),
    );
    expect(map.targets.map((t: { key: string }) => t.key)).toEqual(
      expect.arrayContaining(['history', 'track']),
    );
    // Тот же сотрудник, но НОВАЯ сессия `wa.` (перелогин, другая вкладка) —
    // 401: редактор привязан к сессии, а не только к `sub`.
    const sub = (
      await st.prisma.assistAdminVoiceMapEditorSession.findFirstOrThrow({
        where: { siteId: R.S.siteId, exchangedAt: { not: null } },
        orderBy: { exchangedAt: 'desc' },
      })
    ).employeeRef!.replace(/^jwt:/, '');
    const relogin = await employeeSession(st, R, sub, 'director');
    await request(st.srv())
      .get('/assist-admin/v1/editor/map?path=/')
      .set(ADMIN_SESSION_HEADER, relogin)
      .set(EDITOR_SESSION_HEADER, ed)
      .expect(401);
    // Другой сотрудник с тем же токеном редактора — 401.
    const other = await ownerSession();
    const stolen = await request(st.srv())
      .get('/assist-admin/v1/editor/map?path=/')
      .set(ADMIN_SESSION_HEADER, other)
      .set(EDITOR_SESSION_HEADER, ed)
      .expect(401);
    expect(stolen.body.error.code).toBe('EDITOR_SESSION_EXPIRED');
    // Панель `we.` («Сайт») сессию редактора «Админки» не принимает.
    const siteEditor = new EditorSessionService(
      new SitesDb(st.prisma),
      new VoiceMapService(new SitesDb(st.prisma)),
    );
    let weStatus = 0;
    try {
      await siteEditor.resolve(ed);
    } catch (e) {
      weStatus = (e as HttpException).getStatus();
    }
    expect(weStatus).toBe(401);
    // Операция панели — журнал от имени сотрудника `wa.`.
    const ops = data(
      await post('ops', sess, ed)
        .send({
          expectedRevision: map.revision,
          ops: [
            {
              op: 'add-synonym',
              key: 'history',
              lang: 'ru',
              text: 'история заказа',
            },
          ],
        })
        .expect(200),
    );
    expect(ops.applied).toBe(1);
    const row = (
      await st.prisma.assistAdminActionLog.findMany({
        where: { siteId: R.S.siteId, operation: 'voice-map.draft' },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: 1,
      })
    )[0];
    expect(row).toMatchObject({ channel: 'embed' });
    expect(row.actor).toMatch(/^jwt:emp-own-/);
    // «Сказать сейчас» по черновику: синоним — прямой путь по карте.
    const t = data(
      await post('try', sess, ed)
        .send({
          text: 'покажи история заказа',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(t).toMatchObject({ via: 'map', key: 'history' });
    expect(t.steps[0].target.ref).toBe('e13');
    // Публикация из панели — 403; запрос публикации — версия и бот.
    const pub = await post('publish', sess, ed).expect(403);
    expect(pub.body.error.code).toBe('EDITOR_PUBLISH_FORBIDDEN');
    sent.length = 0;
    const req = data(await post('publish-request', sess, ed).expect(200));
    expect(req).toMatchObject({ status: 'checking', requestedVia: 'editor' });
    expect(sent.join('\n')).toContain(`v${req.number}`);
    const again = await post('publish-request', sess, ed).expect(429);
    expect(again.body.error.code).toBe('EDITOR_PUBLISH_LIMIT');
    // Публикует владелец в TMA.
    await request(st.srv())
      .post(`${base()}/versions/${req.number}/publish`)
      .set(owner())
      .expect(200);
    // Выход — сессия гаснет.
    await post('exit', sess, ed).expect(200);
    await post('ops', sess, ed)
      .send({ expectedRevision: 0, ops: [] })
      .expect(401);
  });

  it('редактор: владелец «Админки» понижен до сотрудника — следующий запрос 401; «завершить все» в TMA — 401', async () => {
    const tg = await st.member(R.S, 'manager', { assistAdmin: 'owner' });
    const open = async (who: bigint) => {
      const l = data(
        await request(st.srv())
          .post(`${base()}/editor-link`)
          .set(st.as(who))
          .send({})
          .expect(200),
      );
      const sess = await ownerSession();
      const ex = data(
        await request(st.srv())
          .post('/assist-admin/v1/editor/session')
          .set(ADMIN_SESSION_HEADER, sess)
          .send({
            token: new URL(l.url).searchParams.get(WIDGET_EDITOR_PARAM),
            parentOrigin: `https://${R.S.adminHost}`,
          })
          .expect(200),
      );
      return { sess, ed: ex.session as string };
    };
    const map = (a: { sess: string; ed: string }) =>
      request(st.srv())
        .get('/assist-admin/v1/editor/map?path=/')
        .set(ADMIN_SESSION_HEADER, a.sess)
        .set(EDITOR_SESSION_HEADER, a.ed);
    const a = await open(tg);
    await map(a).expect(200);
    await st.prisma.siteAccountMember.updateMany({
      where: { accountId: R.S.accountId, telegramId: tg },
      data: { productRoles: { assistAdmin: 'employee' } },
    });
    await map(a).expect(401);
    const b = await open(R.S.ownerTg);
    await map(b).expect(200);
    const sessions = data(
      await request(st.srv())
        .get(`${base()}/editor-sessions`)
        .set(owner())
        .expect(200),
    );
    expect(sessions.items.length).toBeGreaterThanOrEqual(1);
    expect(sessions.items[0].employeeRef).toMatch(/^jwt:emp-own-/);
    await request(st.srv())
      .delete(`${base()}/editor-sessions`)
      .set(owner())
      .expect(200);
    await map(b).expect(401);
  });

  it('iframe `/wa/v1/editor-frame`: frame-ancestors — только хост самой админки; неизвестный pk — none; метка контура в разметке', async () => {
    const ok = await request(st.srv())
      .get(`/wa/v1/editor-frame?pk=${R.S.pk}`)
      .expect(200);
    const csp = ok.headers['content-security-policy'] as string;
    expect(csp).toContain(`frame-ancestors https://${R.S.adminHost}`);
    expect(csp).not.toContain(R.S.host);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.text).toContain('<meta name="v4c-editor-kind" content="admin">');
    expect(ok.text).toContain('/v1/editor-panel.js');
    const none = await request(st.srv())
      .get(`/wa/v1/editor-frame?pk=${WIDGET_PK_LIVE_PREFIX}nope0000`)
      .expect(200);
    expect(none.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
  });
  // ── раунд исправлений захода 11 (аудит З11-А) ───────────────────────────

  /** Ссылка владельца (TMA) → токен; `who` — участник кабинета. */
  async function linkToken(path = '/', who = R.S.ownerTg): Promise<string> {
    const l = data(
      await request(st.srv())
        .post(`${base()}/editor-link`)
        .set(st.as(who))
        .send({ path })
        .expect(200),
    );
    return new URL(l.url).searchParams.get(WIDGET_EDITOR_PARAM)!;
  }
  const exchange = (sess: string, token: string) =>
    request(st.srv())
      .post('/assist-admin/v1/editor/session')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ token, parentOrigin: `https://${R.S.adminHost}` });
  async function openEd(path = '/') {
    const sess = await ownerSession();
    const ex = data(await exchange(sess, await linkToken(path)).expect(200));
    return { sess, ed: ex.session as string };
  }
  const edReq = (
    method: 'get' | 'post',
    path: string,
    a: { sess: string; ed: string },
  ) =>
    request(st.srv())
      [method](`/assist-admin/v1/editor/${path}`)
      .set(ADMIN_SESSION_HEADER, a.sess)
      .set(EDITOR_SESSION_HEADER, a.ed);
  const edSvc = () => st.app.get(AdminEditorSessionService);
  const subOf = async () =>
    (
      await st.prisma.assistAdminVoiceMapEditorSession.findFirstOrThrow({
        where: { siteId: R.S.siteId, exchangedAt: { not: null } },
        orderBy: { exchangedAt: 'desc' },
      })
    ).employeeRef!.replace(/^jwt:/, '');

  it('P2-1: обмен ссылки — только роль владельца у заказчика (карта ролей → owner); менеджер, роль вне карты — 403; роль убрали из карты — 401; ссылку без owner в карте ролей TMA не выдаёт', async () => {
    const token = await linkToken();
    for (const role of ['manager', 'intern-not-in-rolemap']) {
      const r = await exchange(await session(role), token).expect(403);
      expect(r.body.error.code).toBe('EDITOR_OWNER_REQUIRED');
    }
    // Отказ по роли ссылку не сжигает: владелец обменивает её сам.
    const sess = await ownerSession();
    const ed = data(await exchange(sess, token).expect(200)).session as string;
    await edReq('get', 'map?path=/', { sess, ed }).expect(200);
    // Роль `director` больше не владелец — следующий запрос 401.
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: R.S.siteId },
      data: { roleMap: { manager: 'orders', director: 'orders' } },
    });
    await edReq('get', 'map?path=/', { sess, ed }).expect(401);
    // Нет ни одной роли → owner — TMA ссылку не выдаёт (409 с подсказкой).
    const no = await request(st.srv())
      .post(`${base()}/editor-link`)
      .set(owner())
      .send({})
      .expect(409);
    expect(no.body.error.code).toBe('ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED');
    await ownerRole(R);
  });

  it('P1-1: сессия сотрудника истекла (`exp` JWT) — rebind новой сессией ТОГО ЖЕ сотрудника продлевает редактор; другой сотрудник, менеджер, чужой сайт — 401', async () => {
    const a = await openEd();
    await edReq('get', 'map?path=/', a).expect(200);
    const sub = await subOf();
    // JWT заказчика (≤ 15 мин) истёк — сессия сотрудника `wa.` погасла.
    await st.prisma.assistAdminSession.updateMany({
      where: { siteId: R.S.siteId, sub },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const dead = await edReq('get', 'map?path=/', a).expect(401);
    expect(dead.body.error.code).toBe('ADMIN_SESSION_INVALID');
    // Другой сотрудник-владелец / тот же sub без роли владельца — 401.
    for (const other of [
      await ownerSession(),
      await employeeSession(st, R, sub, 'manager'),
    ]) {
      const r = await edReq('post', 'rebind', { sess: other, ed: a.ed })
        .send({})
        .expect(401);
      expect(r.body.error.code).toBe('EDITOR_SESSION_EXPIRED');
    }
    // Свежий JWT того же сотрудника → rebind → редактор жив.
    const fresh = await employeeSession(st, R, sub, 'director');
    const rb = data(
      await edReq('post', 'rebind', { sess: fresh, ed: a.ed })
        .send({})
        .expect(200),
    );
    expect(Date.parse(rb.expiresAt)).toBeGreaterThan(Date.now() + 25 * 60_000);
    await edReq('get', 'map?path=/', { sess: fresh, ed: a.ed }).expect(200);
    // Журнал: перепривязка — строка `voice-map.editor-session` «rebound».
    const row = await st.prisma.assistAdminActionLog.findMany({
      where: { siteId: R.S.siteId, operation: 'voice-map.editor-session' },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    expect(JSON.stringify(row[0])).toContain('rebound');
    // Сессия редактора погасла (выход) — rebind 401.
    await edReq('post', 'exit', { sess: fresh, ed: a.ed }).send({}).expect(200);
    await edReq('post', 'rebind', { sess: fresh, ed: a.ed })
      .send({})
      .expect(401);
    // Сессия сотрудника другого сайта — 401.
    const B = await readySite(st, shop, { enableOps: false });
    await ownerRole(B);
    const b = await openEd();
    await edReq('post', 'rebind', { sess: await ownerSession(B), ed: b.ed })
      .send({})
      .expect(401);
  });

  it('P3-1: сроки редактора — ссылка старше 10 мин — 403; 30 мин бездействия — 401; не дольше 4 ч при активности', async () => {
    const svc = edSvc();
    const real = svc.now;
    try {
      // Ссылка 10 мин.
      const token = await linkToken();
      const sess = await ownerSession();
      svc.now = () => new Date(Date.now() + 11 * 60_000);
      const old = await exchange(sess, token).expect(403);
      expect(old.body.error.code).toBe('EDITOR_LINK_INVALID');
      svc.now = real;
      // Бездействие 30 мин.
      const a = await openEd();
      svc.now = () => new Date(Date.now() + 29 * 60_000);
      await edReq('get', 'map?path=/', a).expect(200);
      const t1 = Date.now() + 29 * 60_000;
      svc.now = () => new Date(t1 + 31 * 60_000);
      await edReq('get', 'map?path=/', a).expect(401);
      // Активность каждые 25 мин — живёт до 4 ч, не дольше.
      svc.now = real;
      const b = await openEd();
      const t0 = Date.now();
      for (let k = 1; k <= 9; k++) {
        svc.now = () => new Date(t0 + k * 25 * 60_000);
        await edReq('get', 'map?path=/', b).expect(200);
      }
      svc.now = () => new Date(t0 + 4 * 3_600_000 + 60_000);
      await edReq('get', 'map?path=/', b).expect(401);
    } finally {
      svc.now = real;
    }
  });

  it('P3-1: обмен — владелец понижен, тариф не Pro, хост админки снят ДО обмена — 403', async () => {
    // Понижен.
    const tg = await st.member(R.S, 'manager', { assistAdmin: 'owner' });
    const t1 = await linkToken('/', tg);
    await st.prisma.siteAccountMember.updateMany({
      where: { accountId: R.S.accountId, telegramId: tg },
      data: { productRoles: { assistAdmin: 'employee' } },
    });
    expect(
      (await exchange(await ownerSession(), t1).expect(403)).body.error.code,
    ).toBe('EDITOR_LINK_INVALID');
    // Тариф Business.
    const t2 = await linkToken();
    await setPlan(st.prisma, R.S.accountId, 'business');
    try {
      await exchange(await ownerSession(), t2).expect(403);
    } finally {
      await setPlan(st.prisma, R.S.accountId, 'pro');
    }
    // Хост админки снят.
    const t3 = await linkToken();
    const set = await st.prisma.assistAdminSettings.findFirstOrThrow({
      where: { siteId: R.S.siteId },
    });
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: R.S.siteId },
      data: { adminHostIds: [] },
    });
    try {
      await exchange(await ownerSession(), t3).expect(403);
    } finally {
      await st.prisma.assistAdminSettings.updateMany({
        where: { siteId: R.S.siteId },
        data: { adminHostIds: set.adminHostIds },
      });
    }
    // Контроль: с теми же условиями ссылка обменивается.
    await exchange(await ownerSession(), await linkToken()).expect(200);
  });

  it('P3-1/P2-2: «Сказать сейчас» — снимок не с хоста админки 400; зоны владельца — в карте редактора', async () => {
    const a = await openEd('/admin/orders/1042');
    const r = await edReq('post', 'try', a)
      .send({ text: 'відкрий історію', snapshot: orderPage(R.S.host) })
      .expect(400);
    expect(r.body.error.code).toBe('EDITOR_BAD_REQUEST');
    await st.prisma.assistAdminSettings.updateMany({
      where: { siteId: R.S.siteId },
      data: {
        voiceControlAdminRules: {
          ...defaultAdminRules(),
          denySelectors: ['#customer-card'],
          allowSelectors: ['main'],
        },
      },
    });
    const map = data(await edReq('get', 'map?path=/', a).expect(200));
    expect(map).toMatchObject({
      denySelectors: ['#customer-card'],
      allowSelectors: ['main'],
    });
  });

  it('P3-1: «отклонить» опубликованную версию — 409 (живая карта не гаснет); импорт без ревизии — 400', async () => {
    const v = await publishAdmin([
      {
        op: 'add-synonym',
        key: 'history',
        lang: 'en',
        text: 'order log',
      },
    ]);
    const r = await request(st.srv())
      .post(`${base()}/versions/${v}/discard`)
      .set(owner())
      .expect(409);
    expect(r.body.error.code).toBe('VOICE_MAP_VERSION_STATE');
    expect(
      data(await request(st.srv()).get(base()).set(owner()).expect(200))
        .publishedVersion,
    ).toBe(v);
    const file = data(
      await request(st.srv()).get(`${base()}/export`).set(owner()).expect(200),
    ).file;
    const imp = await request(st.srv())
      .post(`${base()}/import`)
      .set(owner())
      .send({ file })
      .expect(400);
    expect(imp.body.error.code).toBe('VOICE_MAP_INVALID');
  });

  it('P3-2: путь страницы со ссылкой и в сессии редактора — в журнале без ПД', async () => {
    const sess = await ownerSession();
    await exchange(
      sess,
      await linkToken(
        '/admin/customers/ivan.petrenko@example.com/orders/123456789',
      ),
    ).expect(200);
    const rows = await st.prisma.assistAdminActionLog.findMany({
      where: {
        siteId: R.S.siteId,
        operation: {
          in: ['voice-map.editor-link', 'voice-map.editor-session'],
        },
      },
    });
    const s = JSON.stringify(rows.map((x) => x.requestMasked));
    expect(s).toContain('/admin/customers/:email');
    expect(s).not.toContain('ivan.petrenko');
    expect(s).not.toContain('123456789');
  });

  it('P3-1: denylist карты действует и после перехода (`resume`): цель шага на новой странице — не запрещённый элемент', async () => {
    await publishAdmin([
      {
        op: 'upsert-target',
        target: {
          key: 'customer-note',
          scope: 'site',
          descriptor: {
            tag: 'input',
            role: 'textbox',
            text: 'Примітка клієнта',
            inputType: 'text',
            unique: true,
          },
          denylisted: true,
        },
      },
    ]);
    const sess = await session();
    st.text.uiModel = () => ({
      steps: [
        { kind: 'click', target: 'e1' },
        {
          kind: 'fill',
          target: { text: 'Примітка клієнта', role: 'textbox' },
          value: 'тест',
        },
      ],
    });
    const p = data(
      await api(st, sess)
        .plan({
          text: 'відкрий замовлення і заповни примітка клієнта тест',
          snapshot: orderPage(R.S.adminHost),
        })
        .expect(200),
    );
    expect(p.steps).toHaveLength(2);
    if (p.status === 'proposed')
      await api(st, sess)
        .confirm(p.planId, { stepsHash: p.stepsHash, by: 'button' })
        .expect(200);
    await api(st, sess)
      .step(p.planId, { index: 0, result: 'dispatched' })
      .expect(200);
    await api(st, sess)
      .step(p.planId, {
        index: 0,
        result: 'done',
        url: `https://${R.S.adminHost}/admin/orders`,
      })
      .expect(200);
    const z = data(
      await api(st, sess)
        .resume(p.planId, {
          snapshot: {
            url: `https://${R.S.adminHost}/admin/orders`,
            title: 'Замовлення',
            elements: [
              {
                ref: 'e1',
                role: 'textbox',
                tag: 'input',
                text: 'Примітка клієнта',
                inputType: 'text',
                inView: true,
              },
            ],
          },
        })
        .expect(200),
    );
    // Запрещённое поле на новой странице не стало целью шага.
    expect(z.steps[1].target?.ref ?? null).not.toBe('e1');
    expect(z.steps[1].state).toBe('failed');
  });
});
