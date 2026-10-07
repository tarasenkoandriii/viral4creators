/**
 * Мемо «Сайта» в TMA по HTTP на настоящем Postgres (настоящее приложение:
 * initData бота помощника, SiteAccountGuard, права по продукту):
 *
 * Правка с телефона (Э6-бис (е) хвост (4)):
 *  - `GET …/memos/:n/elements` — элементы Ш4 страницы шага с отпечатком
 *    `pin`: только хосты «Сайта» этого сайта (подтверждённые, не
 *    отозванные; не «Админки», не чужого сайта), подписи без ПД;
 *  - `POST …/memos/:n/steps/element` — «добавить шаг» / «заменить цель»
 *    теми же операциями черновика (ревизия 409, история); шаг «никогда»
 *    (оплата) — 422 и черновик не меняется; чужой элемент — 404;
 *  - оператор помощника — 403, чужой кабинет — отказ.
 *
 * ИИ-предложения фраз (Э6-тер-хвост (6) для мемо), модель — подделка:
 *  - 3–5 фраз на язык сайта в `suggested`, отбор той же проверкой, что у
 *    ручных (ПД, служебные слова, занятые фразы); бюджет обучения
 *    (`assist-learn`): учёт в site_ai_usage и списание; нет бюджета — 402
 *    без модели; чаще раза в минуту — 429 без модели; чужая ревизия — 409;
 *  - `suggested` не видит роль `assist_public`: черновик ей недоступен
 *    (нет GRANT), в версии на проверке (представление
 *    `assist_site_memo_checks`) предложений нет.
 */
import { Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { AssistSiteVoiceControlModule } from '../../modules/assist-site-voice-control/assist-site-voice-control.module';
import { MemoElementsService } from '../../modules/assist-site-voice-control/cabinet/memo-elements.service';
import { MemoPhraseSuggestService } from '../../modules/assist-site-voice-control/cabinet/memo-phrase-suggest.service';
import { MemoTmaEditController } from '../../modules/assist-site-voice-control/cabinet/memo-tma-edit.controller';
import { MemoController } from '../../modules/assist-site-voice-control/cabinet/memo.controller';
import { MemoService } from '../../modules/assist-site-voice-control/cabinet/memo.service';
import { SiteAiModule } from '../../modules/site-ai/site-ai.module';
import {
  TextModelError,
  type GenerateRequest,
} from '../../modules/site-ai/text-model';
import { estimateCost } from '../../shared/ai-pricing';
import {
  PRODUCT_ROLES_KEY,
  SiteAccountGuard,
} from '../../modules/site-core/account/site-account.guard';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { ALLOW_APPS_KEY } from '../../modules/telegram-auth/allow-apps.decorator';
import { ingestUiSnapshot } from '../../modules/site-core/ui-map/ui-map-store';
import { SitesDb } from '../../prisma/sites-db.service';
import { E7Stack, describeE7, type E7Site } from '../e7/e7-stack';

jest.setTimeout(180_000);

@Module({
  imports: [SiteCoreModule, SiteAiModule],
  controllers: [MemoController, MemoTmaEditController],
  providers: [MemoService, MemoElementsService, MemoPhraseSuggestService],
})
class MemoTmaTestModule {}

class MemoTmaStack extends E7Stack {
  protected override extraModules() {
    return [MemoTmaTestModule];
  }
}

const PHRASES = /saved multi-step action/;

describeE7('Мемо в TMA: правка с телефона (Ш4) и ИИ-фразы', () => {
  const st = new MemoTmaStack();
  const data = (r: request.Response) => r.body.data ?? r.body;
  const err = (r: request.Response) => r.body.error ?? r.body;
  let S: E7Site;
  let other: E7Site;
  const phraseCalls: GenerateRequest[] = [];
  let reply = '{}';
  /** Сбой модели фраз (вместо ответа). */
  let fail: Error | null = null;

  const base = (s: E7Site) => `/assist/sites/${s.siteId}/memos`;

  async function snap(
    s: E7Site,
    hostId: string,
    host: string,
    path: string,
    elements: unknown[],
  ) {
    await ingestUiSnapshot(new SitesDb(st.prisma).forAccount(s.accountId), {
      accountId: s.accountId,
      siteId: s.siteId,
      hostId,
      host,
      path,
      source: 'tutorial',
      viewport: 'any',
      elements,
    });
  }

  async function newMemo(s: E7Site, name: string, tg = s.ownerTg) {
    return data(
      await request(st.srv())
        .post(base(s))
        .set(st.as(tg))
        .send({ name, lang: 'uk' })
        .expect(200),
    );
  }

  async function elementId(s: E7Site, label: string): Promise<string> {
    const r = await st.prisma.siteUiElement.findFirst({
      where: { siteId: s.siteId, label: { contains: label } },
      select: { id: true },
    });
    if (!r) throw new Error(`нет элемента ${label}`);
    return r.id;
  }

  beforeAll(async () => {
    await st.init();
    const gen = st.text.generate.bind(st.text);
    jest.spyOn(st.text, 'generate').mockImplementation(async (req) => {
      if (!PHRASES.test(req.system)) return gen(req);
      phraseCalls.push(req);
      if (fail) throw fail;
      return {
        text: reply,
        model: 'gemini-3.6-flash',
        inputTokens: 900,
        cachedInputTokens: 0,
        outputTokens: 80,
      };
    });
    S = await st.site({ plan: 'business' });
    other = await st.site({ plan: 'business' });
    // Хост «Админки» этого сайта (триггер ставит assistRole = admin).
    await st.prisma.assistAdminSettings.upsert({
      where: { siteId: S.siteId },
      create: {
        accountId: S.accountId,
        siteId: S.siteId,
        adminHostIds: [S.adminHostId],
      },
      update: { adminHostIds: [S.adminHostId] },
    });
    const revoked = await st.prisma.siteHost.create({
      data: {
        accountId: S.accountId,
        siteId: S.siteId,
        host: `revoked-${randomUUID().slice(0, 8)}.polygon.example`,
        status: 'verified',
        method: 'dns',
        revokedAt: new Date(),
      },
    });
    await snap(S, S.siteHostId, S.host, '/product/1', [
      {
        selector: '[data-assist-id="add-to-cart"]',
        tag: 'button',
        label: 'В кошик',
      },
      { selector: 'a.nav-cart', tag: 'a', label: 'Кошик' },
      { selector: 'input[name="phone"]', tag: 'input', label: 'Телефон' },
      { selector: '#pay', tag: 'button', label: 'Оплатити замовлення' },
      { selector: '#call', tag: 'button', label: 'Дзвоніть 0671234567' },
    ]);
    await snap(S, S.adminHostId, S.adminHost, '/product/1', [
      { selector: '#adm', tag: 'button', label: 'Секрет адмінки' },
    ]);
    await snap(S, revoked.id, revoked.host, '/product/1', [
      { selector: '#rv', tag: 'button', label: 'Відкликаний хост' },
    ]);
    await snap(other, other.siteHostId, other.host, '/product/1', [
      { selector: '#foreign', tag: 'button', label: 'Чужий сайт' },
    ]);
  });
  afterAll(() => st.close());
  beforeEach(() => {
    phraseCalls.length = 0;
    reply = '{}';
    fail = null;
  });

  it('маршруты подключены в модуле голосового управления «Сайта»; права — assist: manager, SiteAccountGuard', () => {
    const meta = (k: string) =>
      (Reflect.getMetadata(k, AssistSiteVoiceControlModule) ?? []) as unknown[];
    expect(meta('controllers')).toContain(MemoTmaEditController);
    expect(meta('providers')).toEqual(
      expect.arrayContaining([MemoElementsService, MemoPhraseSuggestService]),
    );
    expect(
      Reflect.getMetadata(PRODUCT_ROLES_KEY, MemoTmaEditController),
    ).toEqual({ assist: ['manager'] });
    expect(Reflect.getMetadata(ALLOW_APPS_KEY, MemoTmaEditController)).toEqual([
      'assist',
    ]);
    expect(Reflect.getMetadata('__guards__', MemoTmaEditController)).toContain(
      SiteAccountGuard,
    );
    for (const k of Object.getOwnPropertyNames(
      MemoTmaEditController.prototype,
    ).filter((x) => x !== 'constructor'))
      expect(
        Reflect.getMetadata(
          PRODUCT_ROLES_KEY,
          (
            MemoTmaEditController.prototype as unknown as Record<string, object>
          )[k],
        ),
      ).toBeUndefined();
  });

  it('элементы страницы: только хосты «Сайта» этого сайта, с pin, подписи без ПД, без селекторов', async () => {
    const memo = await newMemo(S, 'Покласти в кошик');
    const r = data(
      await request(st.srv())
        .get(`${base(S)}/${memo.number}/elements?page=/product/1`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    expect(r.page).toBe('/product/1');
    const labels = r.items.map((x: { label: string }) => x.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'В кошик',
        'Кошик',
        'Телефон',
        'Оплатити замовлення',
      ]),
    );
    const all = JSON.stringify(r);
    for (const leak of [
      'Секрет адмінки',
      'Відкликаний хост',
      'Чужий сайт',
      '0671234567',
      'nav-cart',
      'selector',
    ])
      expect(all).not.toContain(leak);
    const cart = r.items.find((x: { label: string }) => x.label === 'В кошик');
    expect(cart).toMatchObject({
      action: 'click',
      pin: { assistId: 'add-to-cart', role: 'button', tag: 'button' },
    });
    const phone = r.items.find((x: { label: string }) => x.label === 'Телефон');
    expect(phone).toMatchObject({
      action: 'fill',
      pin: { pd: true, inputType: 'tel' },
    });
    // Маска хвостом — тоже; кривой адрес — 422.
    const masked = data(
      await request(st.srv())
        .get(`${base(S)}/${memo.number}/elements?page=/product/*`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    expect(masked.items.length).toBe(r.items.length);
    await request(st.srv())
      .get(`${base(S)}/${memo.number}/elements?page=/a/*/b`)
      .set(st.as(S.ownerTg))
      .expect(422);
  });

  it('«добавить шаг» и «заменить цель»: операции черновика (ревизия, история), поле — слот ПД; оплата — 422, черновик не меняется', async () => {
    const memo = await newMemo(S, 'Додати і відкрити кошик');
    const url = `${base(S)}/${memo.number}/steps/element`;
    const add = data(
      await request(st.srv())
        .post(url)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: memo.draftRevision,
          uiElementId: await elementId(S, 'В кошик'),
          mode: 'add',
          page: '/product/*',
        })
        .expect(200),
    );
    expect(add.draftRevision).toBe(memo.draftRevision + 1);
    expect(add.draft.steps).toHaveLength(1);
    expect(add.draft.steps[0]).toMatchObject({
      page: '/product/*',
      action: 'click',
      target: { pin: { assistId: 'add-to-cart', text: 'В кошик' } },
    });
    // Поле телефона — слот без значения, ПД ставит код.
    const withPhone = data(
      await request(st.srv())
        .post(url)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: add.draftRevision,
          uiElementId: await elementId(S, 'Телефон'),
          mode: 'add',
        })
        .expect(200),
    );
    expect(withPhone.draft.steps[1]).toMatchObject({
      action: 'fill',
      value: { slot: 'phone' },
    });
    expect(withPhone.draft.slots).toEqual([
      { name: 'phone', kind: 'phone', pii: true, options: [] },
    ]);
    // Оплата — «никогда»: 422, черновик тот же.
    const pay = await request(st.srv())
      .post(url)
      .set(st.as(S.ownerTg))
      .send({
        expectedRevision: withPhone.draftRevision,
        uiElementId: await elementId(S, 'Оплатити'),
        mode: 'add',
      })
      .expect(422);
    expect(err(pay).code).toBe('MEMO_INVALID');
    expect(JSON.stringify(pay.body)).toContain('never_step');
    // Заменить цель шага 1 той же оплатой — тоже 422.
    await request(st.srv())
      .post(url)
      .set(st.as(S.ownerTg))
      .send({
        expectedRevision: withPhone.draftRevision,
        uiElementId: await elementId(S, 'Оплатити'),
        mode: 'replace',
        index: 0,
      })
      .expect(422);
    // Заменить цель шага 1 ссылкой «Кошик» — действие прежнее, цель новая.
    const re = data(
      await request(st.srv())
        .post(url)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: withPhone.draftRevision,
          uiElementId: await elementId(S, 'Кошик'),
          mode: 'replace',
          index: 0,
        })
        .expect(200),
    );
    expect(re.draft.steps[0]).toMatchObject({
      action: 'click',
      target: { pin: { tag: 'a', text: 'Кошик' } },
    });
    // Устаревшая ревизия — 409, без изменений.
    const stale = await request(st.srv())
      .post(url)
      .set(st.as(S.ownerTg))
      .send({
        expectedRevision: withPhone.draftRevision,
        uiElementId: await elementId(S, 'В кошик'),
        mode: 'add',
      })
      .expect(409);
    expect(err(stale).code).toBe('MEMO_CONFLICT');
    // Элемент хоста «Админки», отозванного хоста, чужого сайта — 404.
    for (const label of ['Секрет адмінки', 'Відкликаний хост']) {
      const r = await request(st.srv())
        .post(url)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: re.draftRevision,
          uiElementId: await elementId(S, label),
          mode: 'add',
        })
        .expect(404);
      expect(err(r).code).toBe('MEMO_ELEMENT_NOT_FOUND');
    }
    await request(st.srv())
      .post(url)
      .set(st.as(S.ownerTg))
      .send({
        expectedRevision: re.draftRevision,
        uiElementId: await elementId(other, 'Чужий сайт'),
        mode: 'add',
      })
      .expect(404);
    const after = await st.prisma.assistSiteMemo.findFirst({
      where: { siteId: S.siteId, number: memo.number },
    });
    expect(after?.draftRevision).toBe(re.draftRevision);
    // История — операции `set` без значений, источник tma.
    const hist = await st.prisma.assistSiteMemoChange.findMany({
      where: { siteId: S.siteId, revision: { gt: 0 } },
      orderBy: { revision: 'asc' },
    });
    expect(hist.map((h) => h.source)).toEqual(expect.arrayContaining(['tma']));
    expect(JSON.stringify(hist.map((h) => h.op))).toContain('"steps"');
  });

  it('права: оператор — 403 на элементы, шаг и фразы; менеджер — можно; чужой кабинет — отказ', async () => {
    const memo = await newMemo(S, 'Права мемо');
    const op = await st.member(S, 'operator', { assist: 'operator' });
    const mgr = await st.member(S, 'manager', { assist: 'manager' });
    const paths = [
      ['get', `${base(S)}/${memo.number}/elements`],
      ['post', `${base(S)}/${memo.number}/steps/element`],
      ['post', `${base(S)}/${memo.number}/suggest-phrases`],
    ] as const;
    for (const [m, p] of paths) {
      await request(st.srv())[m](p).set(st.as(op)).send({}).expect(403);
      const foreign = await request(st.srv())
        [m](p)
        .set(st.as(other.ownerTg))
        .send({});
      expect([403, 404]).toContain(foreign.status);
    }
    await request(st.srv())
      .get(`${base(S)}/${memo.number}/elements`)
      .set(st.as(mgr))
      .expect(200);
    expect(phraseCalls).toHaveLength(0);
  });

  it('ИИ-фразы: 3–5 на язык в suggested, отбор как у ручных, бюджет обучения и учёт; повтор в минуту — 429 без модели', async () => {
    // Чужая (опубликованная) фраза сайта — в индексе фраз.
    await st.prisma.assistSitePhrase.create({
      data: {
        siteId: S.siteId,
        accountId: S.accountId,
        lang: 'uk',
        norm: 'зайнята фраза',
        owner: 'memo:someone-else',
        kind: 'memo-trigger',
      },
    });
    const created = await newMemo(S, 'Фрази мемо');
    // Предложения другого языка (не язык сайта) — генерация их не стирает.
    const memo = data(
      await request(st.srv())
        .patch(`${base(S)}/${created.number}/draft`)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: created.draftRevision,
          ops: [
            {
              op: 'set',
              field: 'suggested',
              value: { en: ['old english phrase'] },
            },
          ],
        })
        .expect(200),
    );
    reply = JSON.stringify({
      uk: [
        'поклади товар у кошик',
        'хочу купити це',
        'так',
        'подзвони 0671234567',
        'зайнята фраза',
        'Фрази мемо',
        'кинь у кошик',
      ],
      ru: ['положи в корзину', 'хочу купить это', 'добавь товар'],
      en: ['add to cart'],
    });
    const spendBefore = await st.prisma.assistLearningSpend.aggregate({
      where: { siteId: S.siteId },
      _sum: { spentMicroUsd: true },
    });
    const r = data(
      await request(st.srv())
        .post(`${base(S)}/${memo.number}/suggest-phrases`)
        .set(st.as(S.ownerTg))
        .send({ expectedRevision: memo.draftRevision })
        .expect(200),
    );
    expect(phraseCalls).toHaveLength(1);
    // Данные мемо — блоком; имени сайта/посетителей в промпте нет.
    expect(phraseCalls[0].user).toContain('name.uk: Фрази мемо');
    const langs: string[] = r.report.langs;
    expect(r.memo.draft.suggested.uk).toEqual([
      'поклади товар у кошик',
      'хочу купити це',
      'кинь у кошик',
    ]);
    expect(r.report.dropped).toMatchObject({
      service_word: 1,
      text: 1,
      phrase_conflict: 1,
      own: 1,
    });
    // Языки — только языки сайта (персоны нет — языки имён: uk): ru и en
    // ответа модели не сохраняются.
    expect(langs).toEqual(['uk']);
    expect(r.memo.draft.suggested.ru ?? []).toEqual([]);
    expect(r.memo.draft.suggested.en).toEqual(['old english phrase']);
    expect(r.memo.draftRevision).toBe(memo.draftRevision + 1);
    // Деньги — бюджет обучения: учёт `assist-learn` и списание.
    const usage = await st.prisma.siteAiUsage.findMany({
      where: { siteId: S.siteId, operation: 'assist-learn' },
    });
    expect(usage.length).toBeGreaterThan(0);
    const spendAfter = await st.prisma.assistLearningSpend.aggregate({
      where: { siteId: S.siteId },
      _sum: { spentMicroUsd: true },
    });
    expect(Number(spendAfter._sum.spentMicroUsd ?? 0)).toBeGreaterThan(
      Number(spendBefore._sum.spentMicroUsd ?? 0),
    );
    // История — источник suggestion.
    const ch = await st.prisma.assistSiteMemoChange.findFirst({
      where: { siteId: S.siteId, source: 'suggestion' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(ch?.op)).toContain('"suggested"');
    // Повтор в минуту — 429, модель не зовётся.
    const again = await request(st.srv())
      .post(`${base(S)}/${memo.number}/suggest-phrases`)
      .set(st.as(S.ownerTg))
      .send({ expectedRevision: r.memo.draftRevision })
      .expect(429);
    expect(err(again).code).toBe('MEMO_SUGGEST_LIMIT');
    expect(phraseCalls).toHaveLength(1);
    // Принять предложенное — существующей операцией.
    const acc = data(
      await request(st.srv())
        .patch(`${base(S)}/${memo.number}/draft`)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: r.memo.draftRevision,
          ops: [
            { op: 'acceptSuggested', lang: 'uk', phrase: 'хочу купити це' },
          ],
        })
        .expect(200),
    );
    expect(acc.draft.triggers.uk).toEqual(['хочу купити це']);
  });

  it('ИИ-фразы: чужая ревизия — 409, нет бюджета — 402; модель не зовётся', async () => {
    const memo = await newMemo(S, 'Без бюджету');
    const r409 = await request(st.srv())
      .post(`${base(S)}/${memo.number}/suggest-phrases`)
      .set(st.as(S.ownerTg))
      .send({ expectedRevision: memo.draftRevision + 7 })
      .expect(409);
    expect(err(r409).code).toBe('MEMO_CONFLICT');
    const period = new Date().toISOString().slice(0, 7);
    await st.prisma.assistLearningSpend.upsert({
      where: { siteId_period: { siteId: S.siteId, period } },
      create: {
        accountId: S.accountId,
        siteId: S.siteId,
        period,
        spentMicroUsd: BigInt(10) ** BigInt(15),
      },
      update: { spentMicroUsd: BigInt(10) ** BigInt(15) },
    });
    try {
      const r402 = await request(st.srv())
        .post(`${base(S)}/${memo.number}/suggest-phrases`)
        .set(st.as(S.ownerTg))
        .send({ expectedRevision: memo.draftRevision })
        .expect(402);
      expect(err(r402).code).toBe('MEMO_SUGGEST_BUDGET');
      expect(phraseCalls).toHaveLength(0);
    } finally {
      await st.prisma.assistLearningSpend.updateMany({
        where: { siteId: S.siteId, period },
        data: { spentMicroUsd: BigInt(0) },
      });
    }
  });

  it('ИИ-фразы: оплаченный сбой модели (truncated со spent) — 503 как раньше, расход assist-learn фактом и в бюджете обучения; timeout — без расхода', async () => {
    const spent = {
      model: 'gemini-3.6-flash',
      inputTokens: 900,
      cachedInputTokens: 0,
      outputTokens: 1361,
    };
    const fact = estimateCost(spent.model, spent).costMicroUsd;
    expect(fact).toBeGreaterThan(0);
    const spend = async () =>
      Number(
        (
          await st.prisma.assistLearningSpend.aggregate({
            where: { siteId: S.siteId },
            _sum: { spentMicroUsd: true },
          })
        )._sum.spentMicroUsd ?? 0,
      );
    const rows = () =>
      st.prisma.siteAiUsage.findMany({
        where: {
          siteId: S.siteId,
          operation: 'assist-learn',
          inputTokens: 900,
          outputTokens: 1361,
        },
      });
    const suggest = async (name: string) => {
      const memo = await newMemo(S, name);
      return request(st.srv())
        .post(`${base(S)}/${memo.number}/suggest-phrases`)
        .set(st.as(S.ownerTg))
        .send({ expectedRevision: memo.draftRevision })
        .expect(503);
    };

    let before = await spend();
    fail = new TextModelError('truncated', spent);
    const r = await suggest('Обрізана відповідь');
    expect(err(r).code).toBe('MEMO_SUGGEST_UNAVAILABLE');
    expect(phraseCalls).toHaveLength(1);
    const paid = await rows();
    expect(paid).toHaveLength(1);
    expect(paid[0].costMicroUsd).toBe(fact);
    expect((await spend()) - before).toBe(fact);

    before = await spend();
    fail = new TextModelError('timeout');
    const t = await suggest('Модель мовчить');
    expect(err(t).code).toBe('MEMO_SUGGEST_UNAVAILABLE');
    expect(await rows()).toHaveLength(1);
    expect(await spend()).toBe(before);
  });

  it('suggested не видит роль assist_public: черновик закрыт (нет GRANT), в версии на проверке предложений нет', async () => {
    const memo = await newMemo(S, 'Публічне мемо');
    const url = `${base(S)}/${memo.number}`;
    const step = data(
      await request(st.srv())
        .post(`${url}/steps/element`)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: memo.draftRevision,
          uiElementId: await elementId(S, 'В кошик'),
          mode: 'add',
        })
        .expect(200),
    );
    const goal = data(
      await request(st.srv())
        .patch(`${url}/draft`)
        .set(st.as(S.ownerTg))
        .send({
          expectedRevision: step.draftRevision,
          ops: [
            {
              op: 'set',
              field: 'goal',
              value: {
                text: { uk: 'Товар у кошику' },
                expect: [{ kind: 'url', path: '/cart' }],
              },
            },
          ],
        })
        .expect(200),
    );
    reply = JSON.stringify({ uk: ['таємна пропозиція моделі', 'друга фраза'] });
    const sug = data(
      await request(st.srv())
        .post(`${url}/suggest-phrases`)
        .set(st.as(S.ownerTg))
        .send({ expectedRevision: goal.draftRevision })
        .expect(200),
    );
    expect(sug.memo.draft.suggested.uk).toContain('таємна пропозиція моделі');
    const built = data(
      await request(st.srv())
        .post(`${url}/versions`)
        .set(st.as(S.ownerTg))
        .expect(200),
    );
    expect(built.gates.ok).toBe(true);
    expect(built.versions[0].status).toBe('checking');
    const asPublic = <T>(sql: string) =>
      st.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE assist_public');
        return tx.$queryRawUnsafe<T>(sql, S.siteId);
      });
    const checks = await asPublic<Array<{ content: unknown }>>(
      `SELECT "content" FROM "sites"."assist_site_memo_checks" WHERE "siteId" = $1`,
    );
    expect(checks.length).toBeGreaterThan(0);
    expect(JSON.stringify(checks)).not.toContain('таємна пропозиція');
    for (const c of checks)
      expect((c.content as { suggested?: unknown }).suggested).toEqual({});
    await expect(
      asPublic(
        `SELECT "draft" FROM "sites"."assist_site_memos" WHERE "siteId" = $1`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asPublic(
        `SELECT "op" FROM "sites"."assist_site_memo_changes" WHERE "siteId" = $1`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
