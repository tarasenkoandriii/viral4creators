/**
 * Э6-тер (к) «мемо из шагов одобренной обучалки» по HTTP на настоящем
 * Postgres (ТЗ помощника §5-бис.17 п.6 «Шаги обучалки», аудит §5-бис.18
 * м-16): настоящее приложение (initData бота помощника, SiteAccountGuard,
 * права по продукту), генератор — подделка, которая ПРОВЕРЯЕТ подпись тем же
 * общим кодом, что генератор (`shared/sites-internal-signature.ts`).
 *
 *  - список «Из обучалки» — одобренные ролики ЭТОГО сайта с мемо из них;
 *  - «создать» → черновик `origin: tutorial`: клик — по элементу Ш4,
 *    `fill` — слот без значения, вид `mobile`, ворота — в карточке;
 *    повтор — 409; лимит тарифа — 402;
 *  - чужой сайт / чужая обучалка — 404, генератор не спрашивается;
 *  - режим B и хост не этого сайта — 422, мемо не создаётся;
 *  - ответ генератора со значением поля — отказ целиком (503), мемо нет;
 *  - подпись: вызывающий `sites-memo`, путь с id сайта и черновика, чужой
 *    секрет — генератор отказывает (401) → 503;
 *  - оператор помощника — 403.
 */
import { Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { AssistSiteVoiceControlModule } from '../../modules/assist-site-voice-control/assist-site-voice-control.module';
import { GeneratorMemoStepsClient } from '../../modules/assist-site-voice-control/cabinet/generator-memo-steps.client';
import { MemoFromTutorialController } from '../../modules/assist-site-voice-control/cabinet/memo-from-tutorial.controller';
import { MemoFromTutorialService } from '../../modules/assist-site-voice-control/cabinet/memo-from-tutorial.service';
import { MemoService } from '../../modules/assist-site-voice-control/cabinet/memo.service';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { SitesDb } from '../../prisma/sites-db.service';
import { ingestUiSnapshot } from '../../modules/site-core/ui-map/ui-map-store';
import {
  SITES_CALLER_MEMO,
  verifySitesRequest,
} from '../../shared/sites-internal-signature';
import { E7Stack, describeE7, type E7Site } from '../e7/e7-stack';

jest.setTimeout(120_000);

const SECRET = 'memo-tutorial-secret-'.padEnd(48, 'x');

/**
 * Контроллер и сервисы раздела — те же классы, что в
 * `AssistSiteVoiceControlModule` (проверка ниже), без голоса и плана
 * посетителя (им нужна роль виджета, здесь не о них).
 */
@Module({
  imports: [SiteCoreModule],
  controllers: [MemoFromTutorialController],
  providers: [MemoService, MemoFromTutorialService, GeneratorMemoStepsClient],
})
class MemoTutorialTestModule {}

class MemoTutorialStack extends E7Stack {
  protected override extraModules() {
    return [MemoTutorialTestModule];
  }
}

interface GenReq {
  path: string;
  caller: string | undefined;
}

describeE7('Э6-тер (к): мемо из шагов одобренной обучалки', () => {
  const st = new MemoTutorialStack();
  const data = (r: request.Response) => r.body.data ?? r.body;
  let S: E7Site;
  let gen: GeneratorMemoStepsClient;
  const calls: GenReq[] = [];
  /** Ответ подделки генератора по draftId. */
  const answers = new Map<string, { status: number; body: unknown }>();
  /** Секрет, которым генератор ПРОВЕРЯЕТ подпись. */
  let generatorSecret = SECRET;

  const steps = (host: string, extra: Record<string, unknown> = {}) => ({
    host,
    title: 'Покласти в кошик',
    startPath: '/catalog',
    endPath: '/cart',
    view: 'mobile',
    requiresLogin: false,
    steps: [
      { kind: 'navigate', path: '/catalog' },
      { kind: 'click', selector: '#add-to-cart' },
      { kind: 'fill', selector: 'input[name="email"]', field: 'email' },
      { kind: 'click', selector: 'a.nav-cart' },
    ],
    dropped: { login: 4, foreign: 0, other: 1 },
    ...extra,
  });

  async function video(site: E7Site, draftId: string) {
    await st.prisma.assistSiteVideo.create({
      data: {
        accountId: site.accountId,
        siteId: site.siteId,
        externalId: `vid_${randomUUID().slice(0, 8)}`,
        draftId,
        ownerTelegramId: site.ownerTg,
        title: `Ролик ${draftId}`,
        locale: 'uk',
        url: 'https://blob.example.com/v.mp4',
        requiresLogin: false,
        syncedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    await st.init();
    gen = st.app.get(GeneratorMemoStepsClient);
    gen.env = {
      GENERATOR_INTERNAL_URL: 'https://gen.example.com',
      SITES_TUTORIAL_HMAC_SECRET: SECRET,
    };
    gen.fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ path: url.pathname, caller: headers['x-sites-caller'] });
      const check = verifySitesRequest(generatorSecret, {
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: '',
        headers,
        nowSeconds: Math.floor(Date.now() / 1000),
        expectedCaller: SITES_CALLER_MEMO,
      });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (!check.ok)
        return json(401, {
          success: false,
          error: { code: `INTERNAL_SIGNATURE_${check.reason.toUpperCase()}` },
        });
      const [, , , , , siteId, draftId] = url.pathname.split('/');
      const a = answers.get(draftId);
      if (!a)
        return json(404, {
          success: false,
          error: { code: 'MEMO_STEPS_NOT_FOUND' },
        });
      if (a.status !== 200) return json(a.status, a.body);
      return json(200, {
        success: true,
        data: { siteId, draftId, ...(a.body as object) },
      });
    };
    S = await st.site({ plan: 'business' });
    // Карта Ш4 хоста сайта: элементы со страниц обучалки (вид mobile).
    const db = new SitesDb(st.prisma).forAccount(S.accountId);
    const snap = (path: string, elements: unknown[]) =>
      ingestUiSnapshot(db, {
        accountId: S.accountId,
        siteId: S.siteId,
        hostId: S.siteHostId,
        host: S.host,
        path,
        source: 'tutorial',
        viewport: 'mobile',
        elements,
      });
    await snap('/catalog', [
      { selector: '#add-to-cart', tag: 'button', label: 'В кошик' },
      { selector: 'input[name="email"]', tag: 'input', label: 'Ваш e-mail' },
      { selector: 'a.nav-cart', tag: 'a', label: 'Кошик' },
    ]);
  });
  afterAll(() => st.close());
  beforeEach(() => {
    calls.length = 0;
    generatorSecret = SECRET;
  });

  const base = (s: E7Site) => `/assist/sites/${s.siteId}/memo-tutorials`;

  it('раздел подключён в модуле голосового управления «Сайта»', () => {
    const meta = (k: string) =>
      (Reflect.getMetadata(k, AssistSiteVoiceControlModule) ?? []) as unknown[];
    expect(meta('controllers')).toContain(MemoFromTutorialController);
    expect(meta('providers')).toEqual(
      expect.arrayContaining([
        MemoFromTutorialService,
        GeneratorMemoStepsClient,
      ]),
    );
  });

  it('список → создать: черновик origin tutorial, клик по Ш4, fill — слот без значения, вид mobile; повтор — 409', async () => {
    await video(S, 'dr_ok');
    answers.set('dr_ok', { status: 200, body: steps(S.host) });
    const before = data(
      await request(st.srv()).get(base(S)).set(st.as(S.ownerTg)).expect(200),
    );
    expect(before.configured).toBe(true);
    expect(before.items).toEqual([
      expect.objectContaining({ draftId: 'dr_ok', memo: null }),
    ]);

    const r = data(
      await request(st.srv())
        .post(`${base(S)}/dr_ok`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    // Подпись: вызывающий sites-memo, путь — с id сайта и черновика.
    expect(calls).toEqual([
      {
        path: `/api/internal/client-site-tutorial/memo-steps/${S.siteId}/dr_ok`,
        caller: SITES_CALLER_MEMO,
      },
    ]);
    expect(r.memo).toMatchObject({
      origin: 'tutorial',
      status: 'draft',
      view: 'mobile',
      name: 'Покласти в кошик',
    });
    const d = r.memo.draft;
    expect(d.steps).toHaveLength(3);
    expect(d.steps[0]).toMatchObject({
      page: '/catalog',
      action: 'click',
      target: { pin: { text: 'В кошик', role: 'button' } },
    });
    expect(d.steps[0].target.uiElementId).toEqual(expect.any(String));
    expect(d.steps[1]).toMatchObject({
      action: 'fill',
      value: { slot: 'email' },
    });
    expect(d.slots).toEqual([
      { name: 'email', kind: 'email', pii: true, options: [] },
    ]);
    // Ссылка, после которой страница сменилась, — переход (href в отпечатке).
    expect(d.steps[2].target.pin).toMatchObject({ tag: 'a', href: '/cart' });
    expect(d.goal.expect).toEqual([{ kind: 'url', path: '/cart' }]);
    expect(r.report).toMatchObject({
      steps: 3,
      unresolved: [],
      requiresLogin: false,
      dropped: { login: 4, foreign: 0, other: 1 },
    });
    // Ворота посчитаны (та же функция, что у сборки версии).
    expect(r.memo.gates).toEqual(
      expect.objectContaining({ ok: expect.any(Boolean) }),
    );
    expect(
      r.memo.gates.problems.filter(
        (p: { code: string }) =>
          p.code === 'no_target' || p.code === 'value_not_slot',
      ),
    ).toEqual([]);
    // История: источник tutorial, ссылка на обучалку.
    const ch = await st.prisma.assistSiteMemoChange.findFirst({
      where: { siteId: S.siteId, source: 'tutorial' },
    });
    expect(ch?.op).toMatchObject({
      op: 'create',
      origin: 'tutorial',
      draftId: 'dr_ok',
    });

    const after = data(
      await request(st.srv()).get(base(S)).set(st.as(S.ownerTg)).expect(200),
    );
    expect(after.items[0].memo).toEqual({
      number: r.memo.number,
      status: 'draft',
    });
    const again = await request(st.srv())
      .post(`${base(S)}/dr_ok`)
      .set(st.as(S.ownerTg))
      .expect(409);
    expect(again.body.error.code).toBe('MEMO_TUTORIAL_EXISTS');
  });

  it('чужая обучалка (ролик другого сайта) и чужой сайт — 404, генератор не спрашивается', async () => {
    const other = await st.site({ plan: 'business' });
    await video(other, 'dr_foreign');
    answers.set('dr_foreign', { status: 200, body: steps(other.host) });
    const a = await request(st.srv())
      .post(`${base(S)}/dr_foreign`)
      .set(st.as(S.ownerTg))
      .expect(404);
    expect(a.body.error.code).toBe('MEMO_TUTORIAL_NOT_FOUND');
    await request(st.srv())
      .post(`${base(other)}/dr_foreign`)
      .set(st.as(S.ownerTg))
      .expect(404);
    expect(calls).toEqual([]);
  });

  it('обучалка другого сайта ТОГО ЖЕ кабинета — 404 (сайт, а не только кабинет)', async () => {
    const twin = await st.prisma.site.create({
      data: { accountId: S.accountId, name: 'Другий сайт' },
    });
    await video({ ...S, siteId: twin.id }, 'dr_twin');
    answers.set('dr_twin', { status: 200, body: steps(S.host) });
    const r = await request(st.srv())
      .post(`${base(S)}/dr_twin`)
      .set(st.as(S.ownerTg))
      .expect(404);
    expect(r.body.error.code).toBe('MEMO_TUTORIAL_NOT_FOUND');
    expect(calls).toEqual([]);
    const l = data(
      await request(st.srv()).get(base(S)).set(st.as(S.ownerTg)).expect(200),
    );
    expect(l.items.map((i: { draftId: string }) => i.draftId)).not.toContain(
      'dr_twin',
    );
  });

  it('хост обучалки — не подтверждённый хост этого сайта — 422, мемо нет', async () => {
    await video(S, 'dr_host');
    answers.set('dr_host', {
      status: 200,
      body: steps('evil.example.org'),
    });
    const r = await request(st.srv())
      .post(`${base(S)}/dr_host`)
      .set(st.as(S.ownerTg))
      .expect(422);
    expect(r.body.error.code).toBe('MEMO_TUTORIAL_NOT_ELIGIBLE');
    expect(r.body.error.reason ?? r.body.error.details?.reason).toBe('host');
    expect(
      await st.prisma.assistSiteMemoChange.count({
        where: {
          siteId: S.siteId,
          op: { path: ['draftId'], equals: 'dr_host' },
        },
      }),
    ).toBe(0);
  });

  it('хост сайта есть, но не подтверждён (pending) или отозван — 422', async () => {
    const pending = `pending-${randomUUID().slice(0, 8)}.polygon.example`;
    const revoked = `revoked-${randomUUID().slice(0, 8)}.polygon.example`;
    for (const [host, extra] of [
      [pending, { status: 'pending' }],
      [revoked, { status: 'verified', revokedAt: new Date() }],
    ] as const)
      await st.prisma.siteHost.create({
        data: {
          accountId: S.accountId,
          siteId: S.siteId,
          host,
          method: 'dns',
          ...extra,
        },
      });
    for (const [draftId, host] of [
      ['dr_pending', pending],
      ['dr_revoked', revoked],
    ]) {
      await video(S, draftId);
      answers.set(draftId, { status: 200, body: steps(host) });
      const r = await request(st.srv())
        .post(`${base(S)}/${draftId}`)
        .set(st.as(S.ownerTg))
        .expect(422);
      expect(r.body.error.details?.reason).toBe('host');
    }
  });

  it('режим B (отказ генератора) — 422 с причиной', async () => {
    await video(S, 'dr_b');
    answers.set('dr_b', {
      status: 422,
      body: {
        success: false,
        error: {
          code: 'MEMO_STEPS_NOT_ELIGIBLE',
          details: { code: 'MEMO_STEPS_NOT_ELIGIBLE', reason: 'mode_b' },
        },
      },
    });
    const r = await request(st.srv())
      .post(`${base(S)}/dr_b`)
      .set(st.as(S.ownerTg))
      .expect(422);
    expect(r.body.error.code).toBe('MEMO_TUTORIAL_NOT_ELIGIBLE');
  });

  it('значение поля в ответе генератора — отказ целиком (503), мемо нет', async () => {
    await video(S, 'dr_value');
    const b = steps(S.host);
    answers.set('dr_value', {
      status: 200,
      body: {
        ...b,
        steps: [
          { kind: 'click', selector: '#add-to-cart' },
          {
            kind: 'fill',
            selector: 'input[name="email"]',
            field: 'email',
            value: 'boss@shop.ua',
          },
        ],
      },
    });
    const r = await request(st.srv())
      .post(`${base(S)}/dr_value`)
      .set(st.as(S.ownerTg))
      .expect(503);
    expect(r.body.error.code).toBe('MEMO_TUTORIAL_UNAVAILABLE');
    expect(JSON.stringify(r.body)).not.toContain('boss@shop.ua');
    const memos = await st.prisma.assistSiteMemo.findMany({
      where: { siteId: S.siteId },
      select: { draft: true },
    });
    expect(JSON.stringify(memos)).not.toContain('boss@shop.ua');
  });

  it('подпись не сошлась (генератор с другим секретом) — 503, мемо нет', async () => {
    await video(S, 'dr_sig');
    answers.set('dr_sig', { status: 200, body: steps(S.host) });
    generatorSecret = 'other-secret-'.padEnd(48, 'y');
    const r = await request(st.srv())
      .post(`${base(S)}/dr_sig`)
      .set(st.as(S.ownerTg))
      .expect(503);
    expect(r.body.error.code).toBe('MEMO_TUTORIAL_UNAVAILABLE');
    expect(calls).toHaveLength(1);
  });

  it('оператор помощника — 403; тариф без мемо — 402 MEMO_LIMIT', async () => {
    const op = await st.member(S, 'operator', { assist: 'operator' });
    await request(st.srv()).get(base(S)).set(st.as(op)).expect(403);
    await request(st.srv())
      .post(`${base(S)}/dr_ok`)
      .set(st.as(op))
      .expect(403);

    const start = await st.site({ plan: 'business' });
    await setPlan(st.prisma, start.accountId, 'start');
    await video(start, 'dr_start');
    answers.set('dr_start', { status: 200, body: steps(start.host) });
    const r = await request(st.srv())
      .post(`${base(start)}/dr_start`)
      .set(st.as(start.ownerTg))
      .expect(402);
    expect(r.body.error.code).toBe('MEMO_LIMIT');
  });
});
