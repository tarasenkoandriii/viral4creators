/**
 * Приёмка захода 13, пакет А — хвост Р-З11-А11: инструменты панели
 * редактора карты «Админки» (iframe `wa.`) до паритета с панелью «Сайта» —
 * на НАСТОЯЩЕМ Postgres через HTTP (гварды, сессии employee-JWT и редактора),
 * фейк-модель и фейк Soniox. ТЗ §5-кватер.4, §5-кватер.5, §5-кватер.6 п.1,
 * §5-кватер.9 «Изоляция», §5-кватер.10, §5-кватер.13; §5-бис.17 п.10.
 *
 *  - ИИ-синонимы: `suggested` в черновик карты «Админки», деньги — суточный
 *    потолок «Админки» (операция `assist-admin-map-synonyms`, не бюджет
 *    обучения «Сайта»), частота (429), исчерпанный потолок (402) — до модели;
 *  - «Промахи»/«Пропозиції»: из журнала планов «Админки» (`mapKey` шага,
 *    стоп человеком ≤ 5 с — «не туда», 0 шагов — «просили, не нашли»),
 *    пороги «Админки», «не предлагать»; карта «Сайта» этих планов не видит;
 *  - мемо АМ-N записью кликами: шаги `ui` без серверного эффекта, кнопка
 *    «Зберегти» — стоп, подложенный шаг-клик — 422, шаги `api` черновика
 *    сохраняются по `keep`, журнал `memo` от сотрудника `jwt:<sub>`,
 *    «Прогнати» по снимку;
 *  - микрофон: запись → Soniox «Админки» (`assist-admin-stt`), общий
 *    потолок «Сказать сейчас»; без обеих сессий — 401.
 */
import * as request from 'supertest';
import {
  ADMIN_SESSION_HEADER,
  EDITOR_SESSION_HEADER,
  WIDGET_EDITOR_PARAM,
} from '../../brand';
import { AdminMemoService } from '../../modules/assist-admin-actions/admin-memo.service';
import { siteDailyCapFromPlan } from '../../modules/assist-billing/plans';
import { AssistAdminVoiceMapModule } from '../../modules/assist-admin-voice-map/assist-admin-voice-map.module';
import { ADMIN_MAP_SYNONYMS_OPERATION } from '../../modules/assist-admin-voice-map/editor/admin-editor-assist.service';
import { MapMissesService } from '../../modules/assist-site-voice-map/map-misses';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import type {
  GenerateRequest,
  GenerateResult,
} from '../../modules/site-ai/text-model';
import { TextModelError } from '../../modules/site-ai/text-model';
import { SitesDb } from '../../prisma/sites-db.service';
import { ShopApi } from '../e8/e8-stack';
import {
  AdminVoiceStack,
  FakeVoiceText,
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

/** Фейк-модель: ещё и ИИ-синонимы цели (промпт панели редактора). */
class FakeMapText extends FakeVoiceText {
  readonly synCalls: GenerateRequest[] = [];
  syn: Record<string, string[]> | 'down' = {};

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (/suggest short voice commands/.test(req.system)) {
      this.synCalls.push(req);
      if (this.syn === 'down') throw new TextModelError('unavailable');
      return {
        model: 'gemini-3.6-flash',
        inputTokens: 700,
        cachedInputTokens: 0,
        outputTokens: 80,
        text: JSON.stringify(this.syn),
      };
    }
    return super.generate(req);
  }
}

class MapStack extends AdminVoiceStack {
  override readonly text = new FakeMapText();
  protected override extraModules() {
    return [...super.extraModules(), AssistAdminVoiceMapModule];
  }
}

describeE6bAdmin(
  'Заход 13 (А) — инструменты панели редактора карты «Админки»',
  () => {
    const st = new MapStack();
    const shop = new ShopApi();
    let R: Ready;
    let n = 0;

    beforeAll(async () => {
      await st.init();
      R = await readySite(st, shop);
      await st.prisma.assistAdminSettings.updateMany({
        where: { siteId: R.S.siteId },
        data: {
          roleMap: { manager: 'orders', intern: 'readers', director: 'owner' },
        },
      });
      await forceOn(st, R);
    });
    afterAll(() => st.close());
    beforeEach(async () => {
      await st.prisma.$executeRawUnsafe(
        `DELETE FROM "sites"."assist_rate_buckets" WHERE "scope" = 'admin-session-ip-min'`,
      );
    });

    const base = `/assist/sites/${'%SITE%'}/admin-mode/voice-map`;
    const tma = () => base.replace('%SITE%', R.S.siteId);
    const owner = () => st.as(R.S.ownerTg);
    const ownerSession = () =>
      employeeSession(st, R, `emp-own-${++n}`, 'director');

    async function revision(): Promise<number> {
      return data(
        await request(st.srv()).get(`${tma()}/draft`).set(owner()).expect(200),
      ).revision as number;
    }

    async function patchDraft(ops: unknown[]) {
      await request(st.srv())
        .patch(`${tma()}/draft`)
        .set(owner())
        .send({ expectedRevision: await revision(), ops })
        .expect(200);
    }

    async function publish() {
      const v = data(
        await request(st.srv())
          .post(`${tma()}/versions`)
          .set(owner())
          .expect(200),
      );
      await request(st.srv())
        .post(`${tma()}/versions/${v.number}/publish`)
        .set(owner())
        .expect(200);
    }

    /** Ссылка владельца (TMA) → обмен сессией сотрудника-владельца `wa.`. */
    async function openEd(path = '/admin/orders/1042') {
      const l = data(
        await request(st.srv())
          .post(`${tma()}/editor-link`)
          .set(owner())
          .send({ path })
          .expect(200),
      );
      const token = new URL(l.url).searchParams.get(WIDGET_EDITOR_PARAM)!;
      const sess = await ownerSession();
      const ex = data(
        await request(st.srv())
          .post('/assist-admin/v1/editor/session')
          .set(ADMIN_SESSION_HEADER, sess)
          .send({ token, parentOrigin: `https://${R.S.adminHost}` })
          .expect(200),
      );
      return { sess, ed: ex.session as string };
    }

    const ed = (
      method: 'get' | 'post',
      path: string,
      a: { sess: string; ed: string } | null,
    ) => {
      const r = request(st.srv())[method](`/assist-admin/v1/editor/${path}`);
      if (a)
        r.set(ADMIN_SESSION_HEADER, a.sess).set(EDITOR_SESSION_HEADER, a.ed);
      return r;
    };

    const history = {
      key: 'history',
      scope: 'site',
      descriptor: {
        tag: 'button',
        role: 'tab',
        text: 'Історія',
        toggle: true,
        unique: true,
      },
      names: { uk: 'Історія', ru: 'История' },
      synonyms: { uk: [{ text: 'журнал змін' }] },
    };
    const customers = {
      key: 'customers',
      scope: 'site',
      descriptor: {
        tag: 'a',
        role: 'link',
        text: 'Клієнти',
        hrefPath: '/admin/customers',
        hrefHost: '',
        unique: true,
      },
      names: { uk: 'Клієнти' },
      synonyms: {},
    };

    it('ИИ-синонимы: `suggested` в черновик (отбор ядра), деньги — суточный потолок «Админки», журнал от сотрудника; 409/422/429/402 — до модели; модель недоступна — 503', async () => {
      await patchDraft([
        { op: 'upsert-target', target: history },
        {
          op: 'upsert-target',
          target: {
            ...customers,
            descriptor: { ...customers.descriptor, hrefHost: R.S.adminHost },
          },
        },
        {
          op: 'upsert-target',
          target: {
            key: 'drop-order',
            scope: 'site',
            descriptor: {
              tag: 'button',
              role: 'button',
              text: 'Видалити замовлення',
              unique: true,
            },
            names: {},
            synonyms: {},
            denylisted: true,
          },
        },
      ]);
      const a = await openEd();
      const rev = await revision();
      const calls = () => st.text.synCalls.length;
      // Старая ревизия — 409; цель «никогда» — 422; модель не звали.
      const c0 = calls();
      await ed('post', 'suggest-synonyms', a)
        .send({ expectedRevision: rev - 1, key: 'history' })
        .expect(409);
      const never = await ed('post', 'suggest-synonyms', a)
        .send({ expectedRevision: rev, key: 'drop-order' })
        .expect(422);
      expect(never.body.error.code).toBe('EDITOR_SUGGEST_NEVER');
      expect(calls()).toBe(c0);
      // Без сессии сотрудника/редактора — 401.
      await ed('post', 'suggest-synonyms', null)
        .send({ expectedRevision: rev, key: 'history' })
        .expect(401);
      st.text.syn = {
        // «клієнти» — фраза ДРУГОЙ цели; e-mail — ПД; «так» — служебное.
        uk: ['зміни замовлення', 'клієнти', 'пиши ivan@x.com', 'так'],
        ru: ['история изменений'],
      };
      const r = data(
        await ed('post', 'suggest-synonyms', a)
          .send({ expectedRevision: rev, key: 'history' })
          .expect(200),
      );
      expect(r).toMatchObject({
        key: 'history',
        langs: ['uk', 'ru'],
        kept: { uk: 1, ru: 1 },
        dropped: { phrase_conflict: 1, text: 1, service_word: 1 },
      });
      expect(st.text.synCalls[st.text.synCalls.length - 1].system).toMatch(
        /EMPLOYEE working in the admin panel/,
      );
      const draft = data(
        await request(st.srv()).get(`${tma()}/draft`).set(owner()).expect(200),
      );
      const t = draft.content.targets.find(
        (x: { key: string }) => x.key === 'history',
      );
      expect(t.synonyms.uk).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: 'зміни замовлення',
            origin: 'suggested',
          }),
        ]),
      );
      // Деньги — операция «Админки»; бюджета обучения «Сайта» не касались.
      const usage = await st.prisma.siteAiUsage.findMany({
        where: { siteId: R.S.siteId },
        select: { operation: true, costMicroUsd: true },
      });
      expect(usage.map((u) => u.operation)).toContain(
        ADMIN_MAP_SYNONYMS_OPERATION,
      );
      expect(usage.map((u) => u.operation)).not.toContain('assist-learn');
      // Резерв снят фактом: в строке дня «Админки» резерва не висит.
      const day = await st.prisma.$queryRawUnsafe<Array<{ r: bigint }>>(
        `SELECT "reservedMicroUsd" AS r FROM "sites"."assist_budget_days" WHERE "scope" = 'admin' AND "key" = $1`,
        R.S.siteId,
      );
      expect(Number(day[0]?.r ?? 0)).toBe(0);
      // Журнал: правка черновика (источник suggestion) и строка ИИ — от `jwt:`.
      const log = await st.prisma.assistAdminActionLog.findMany({
        where: {
          siteId: R.S.siteId,
          operation: { in: ['voice-map.draft', 'voice-map.ai-synonyms'] },
        },
        orderBy: [{ at: 'desc' }],
        take: 2,
      });
      expect(log.map((l) => l.operation).sort()).toEqual([
        'voice-map.ai-synonyms',
        'voice-map.draft',
      ]);
      for (const l of log) {
        expect(l.actor).toMatch(/^jwt:emp-own-/);
        expect(JSON.stringify(l.requestMasked)).not.toContain('ivan@x.com');
      }
      // Р-З13-А8: правка цели в TMA (синонимы без `origin`) предложение ИИ не
      // «принимает» молча — оно остаётся `suggested` и в версию не идёт.
      await patchDraft([
        {
          op: 'upsert-target',
          target: {
            key: 'history',
            names: { uk: 'Історія замовлення', ru: 'История' },
            synonyms: {
              uk: [{ text: 'журнал змін' }, { text: 'зміни замовлення' }],
            },
          },
        },
      ]);
      const after = data(
        await request(st.srv()).get(`${tma()}/draft`).set(owner()).expect(200),
      ).content.targets.find((x: { key: string }) => x.key === 'history');
      expect(after.synonyms.uk).toEqual([
        expect.objectContaining({ text: 'журнал змін', origin: 'owner' }),
        expect.objectContaining({
          text: 'зміни замовлення',
          origin: 'suggested',
        }),
      ]);
      // Повтор на ту же цель в ту же минуту — 429 до модели.
      const c1 = calls();
      const again = await ed('post', 'suggest-synonyms', a)
        .send({ expectedRevision: await revision(), key: 'history' })
        .expect(429);
      expect(again.body.error).toMatchObject({ code: 'EDITOR_SUGGEST_LIMIT' });
      expect(calls()).toBe(c1);
      // Модель недоступна — 503, резерв возвращён, строка журнала `failed`.
      st.text.syn = 'down';
      const down = await ed('post', 'suggest-synonyms', a)
        .send({ expectedRevision: await revision(), key: 'customers' })
        .expect(503);
      expect(down.body.error.code).toBe('EDITOR_SUGGEST_UNAVAILABLE');
      // Потолок «Админки» на сегодня исчерпан — 402 ДО модели.
      await st.prisma.siteAiUsage.create({
        data: {
          accountId: R.S.accountId,
          siteId: R.S.siteId,
          product: 'assist',
          provider: 'GEMINI',
          operation: 'assist-admin-ui-plan',
          model: 'gemini-3.6-flash',
          calls: 1,
          costMicroUsd: siteDailyCapFromPlan('pro'),
          pricingVersion: 'test',
        },
      });
      st.text.syn = { uk: ['ще одна'] };
      // Новая цель — без минутного окна от прошлых вызовов.
      await patchDraft([
        {
          op: 'upsert-target',
          target: {
            ...customers,
            key: 'orders-link',
            descriptor: {
              ...customers.descriptor,
              text: 'Замовлення',
              hrefPath: '/admin/orders',
              hrefHost: R.S.adminHost,
            },
            names: { uk: 'Замовлення' },
          },
        },
      ]);
      const dayHits = async () =>
        Number(
          (
            await st.prisma.$queryRawUnsafe<Array<{ n: bigint | null }>>(
              `SELECT sum("count") AS n FROM "sites"."assist_rate_buckets" WHERE "scope" = 'admin-map-ai-day' AND "key" = $1`,
              R.S.siteId,
            )
          )[0]?.n ?? 0,
        );
      const hits0 = await dayHits();
      const c2 = calls();
      const broke = await ed('post', 'suggest-synonyms', a)
        .send({ expectedRevision: await revision(), key: 'orders-link' })
        .expect(402);
      expect(broke.body.error.code).toBe('EDITOR_SUGGEST_BUDGET');
      expect(calls()).toBe(c2);
      // Аудит З13-А P3-1: отказ по бюджету окон частоты не тратит.
      expect(await dayHits()).toBe(hits0);
      await st.prisma.siteAiUsage.deleteMany({
        where: { siteId: R.S.siteId, operation: 'assist-admin-ui-plan' },
      });
      const ok = data(
        await ed('post', 'suggest-synonyms', a)
          .send({ expectedRevision: await revision(), key: 'orders-link' })
          .expect(200),
      );
      expect(ok.kept).toMatchObject({ uk: 1 });
      expect(await dayHits()).toBe(hits0 + 1);
      // Минутное окно — скользящее, по журналу цели: сразу ещё раз — 429.
      await ed('post', 'suggest-synonyms', a)
        .send({ expectedRevision: await revision(), key: 'orders-link' })
        .expect(429);
    });

    it('«Промахи»/«Пропозиції»: журнал планов «Админки» — тепловые значки, «не туда» (стоп ≤ 5 с, `mapKey` шага), «просили, не нашли»; пороги «Админки»; «не предлагать»; карта «Сайта» планов «Админки» не видит', async () => {
      await patchDraft([{ op: 'upsert-target', target: history }]);
      await publish();
      // Два сотрудника: команда «покажи журнал змін і замовлення» → модель:
      // вкладка «Історія» (цель карты) и ссылка; после шага 1 — стоп кнопкой.
      st.text.uiModel = (cmd) =>
        /журнал/.test(cmd)
          ? {
              steps: [
                { kind: 'click', target: 'e13' },
                { kind: 'click', target: 'e1' },
              ],
            }
          : { steps: [] };
      for (const who of ['emp-wrong-1', 'emp-wrong-2']) {
        const s = await employeeSession(st, R, who);
        const p = api(st, s);
        const plan = data(
          await p
            .plan({
              text: 'покажи журнал змін і замовлення',
              snapshot: orderPage(R.S.adminHost),
            })
            .expect(200),
        );
        expect(plan.steps[0]).toMatchObject({ mapKey: 'history' });
        if (plan.status === 'proposed')
          await p
            .confirm(plan.planId, { by: 'button', stepsHash: plan.stepsHash })
            .expect(200);
        await p
          .step(plan.planId, { index: 0, result: 'dispatched' })
          .expect(200);
        await p
          .step(plan.planId, {
            index: 0,
            result: 'done',
            url: `https://${R.S.adminHost}/admin/orders/1042`,
          })
          .expect(200);
        await p.stop(plan.planId, { by: 'button' }).expect(200);
      }
      // «Просили, не нашли»: два сотрудника, три раза (порог «Админки» —
      // 2 сотрудника И 3 повтора). Команды с именем/номером клиента
      // (аудит З13-А P3-3) — не кандидаты, сколько бы их ни было.
      const asker = [
        await employeeSession(st, R, 'emp-asked-1'),
        await employeeSession(st, R, 'emp-asked-2'),
      ];
      for (const [who, text] of [
        [0, 'відкрий експорт замовлень'],
        [0, 'відкрий експорт замовлень'],
        [1, 'відкрий експорт замовлень'],
        [0, 'відкрий клієнта Іван Петренко'],
        [1, 'відкрий клієнта Іван Петренко'],
        [1, 'відкрий клієнта Іван Петренко'],
        [0, 'відкрий замовлення 1043'],
        [1, 'відкрий замовлення 1043'],
        [1, 'відкрий замовлення 1043'],
      ] as const)
        await api(st, asker[who])
          .plan({ text, snapshot: orderPage(R.S.adminHost) })
          .expect(200);
      // Шаг журнала несёт `mapKey` цели карты (заход 13).
      const stepRow = await st.prisma.assistAdminActionLog.findFirst({
        where: { siteId: R.S.siteId, kind: 'ui-step', outcome: 'done' },
        orderBy: { at: 'desc' },
      });
      expect(stepRow?.requestMasked).toMatchObject({ mapKey: 'history' });

      const a = await openEd();
      const m = data(
        await ed('get', 'misses?path=/admin/orders/1042', a).expect(200),
      );
      expect(m.heat).toEqual([
        expect.objectContaining({ key: 'history', done: 2, wrong: 2 }),
      ]);
      expect(m.items).toEqual([
        expect.objectContaining({ key: 'history', wrong: 2 }),
      ]);
      expect(m.wrong).toEqual([
        expect.objectContaining({
          key: 'history',
          phrase: 'журнал змін і замовлення',
          visitors: 2,
        }),
      ]);
      expect(m.asked).toEqual([
        expect.objectContaining({
          phrase: 'експорт замовлень',
          count: 3,
          visitors: 2,
        }),
      ]);
      // Другая страница вне шаблона — «просили» там нет.
      const other = data(
        await ed('get', 'misses?path=/admin/settings', a).expect(200),
      );
      expect(other.asked).toEqual([]);
      const sug = data(
        await ed('get', 'suggestions?path=/admin/orders/1042', a).expect(200),
      );
      const kinds = sug.items.map((x: { kind: string }) => x.kind).sort();
      expect(kinds).toEqual(['asked', 'wrong']);
      // «Не предлагать» — в журнале только id; карточка пропала.
      const asked = sug.items.find((x: { kind: string }) => x.kind === 'asked');
      await ed('post', 'suggestions/mute', a)
        .send({ id: asked.id })
        .expect(200);
      const sug2 = data(
        await ed('get', 'suggestions?path=/admin/orders/1042', a).expect(200),
      );
      expect(sug2.items.map((x: { kind: string }) => x.kind)).toEqual([
        'wrong',
      ]);
      const mute = await st.prisma.assistAdminActionLog.findFirst({
        where: { siteId: R.S.siteId, operation: 'voice-map.suggestion-mute' },
      });
      expect(mute?.requestMasked).toEqual({ id: asked.id });
      // Терминов распознавания у «Админки» нет — принять нечего.
      await ed('post', 'suggestions/term', a)
        .send({ expectedRevision: 0, id: 'e'.repeat(24) })
        .expect(400);
      // Изоляция: «Промахи» карты «Сайта» того же сайта планов «Админки» не видят.
      const site = await new MapMissesService(new SitesDb(st.prisma)).statsFor(
        R.S.accountId,
        R.S.siteId,
      );
      expect(site.items).toEqual([]);
      // Путь — только по правилу.
      await ed('get', 'misses?path=https://evil/x', a).expect(400);
    });

    it('мемо АМ-N записью кликами: вкладка/поле — шаги `ui`, «Зберегти» — стоп; сохранение — черновик (журнал от `jwt:`), «Прогнати»; шаги `api` черновика — по `keep`; подложенный шаг-клик — 422; «Чекати це» — 404', async () => {
      const a = await openEd();
      const start = data(
        await ed('post', 'memo/record/start', a)
          .send({ path: '/admin/orders/1042', memo: null, lang: 'uk' })
          .expect(200),
      );
      expect(start).toMatchObject({ memo: null, limit: { max: 50 } });
      const step = (descriptor: Record<string, unknown>, extra = {}) =>
        ed('post', 'memo/record/step', a).send({
          path: '/admin/orders/1042',
          descriptor: { unique: true, ...descriptor },
          slots: [],
          count: 0,
          ...extra,
        });
      const tab = data(
        await step({
          tag: 'button',
          role: 'tab',
          text: 'Історія',
          toggle: true,
        }).expect(200),
      );
      expect(tab).toMatchObject({ kind: 'step', exec: true });
      const fill = data(
        await step(
          {
            tag: 'input',
            role: 'textbox',
            text: 'Трек-номер',
            inputType: 'text',
          },
          { fieldName: 'track' },
        ).expect(200),
      );
      expect(fill).toMatchObject({
        kind: 'step',
        slot: { name: 'track', kind: 'text' },
        step: { action: 'fill', value: { slot: 'track' } },
      });
      const save = data(
        await step({
          tag: 'button',
          role: 'button',
          text: 'Зберегти',
          submit: true,
          inForm: true,
        }).expect(200),
      );
      expect(save).toEqual({
        kind: 'stop',
        reason: 'server_effect',
        step: null,
      });
      // Сохранить черновик.
      const saved = data(
        await ed('post', 'memo/record/stop', a)
          .send({
            memo: null,
            lang: 'uk',
            name: 'Трек замовлення',
            goalText: 'Трек внесено',
            path: '/admin/orders/1042',
            steps: [tab.step, fill.step],
            slots: [fill.slot],
          })
          .expect(200),
      );
      expect(saved).toMatchObject({ status: 'draft', draftRevision: 0 });
      // Ворота: шагов `api` нет — это мемо из шагов на странице (годно).
      expect(
        saved.gates.problems.map((p: { code: string }) => p.code),
      ).not.toContain('no_api');
      const memoLog = await st.prisma.assistAdminActionLog.findFirst({
        where: { siteId: R.S.siteId, operation: `memo:АМ-${saved.number}` },
      });
      expect(memoLog).toMatchObject({ channel: 'embed', outcome: 'create' });
      expect(memoLog?.actor).toMatch(/^jwt:emp-own-/);
      const list = data(await ed('get', 'memo/list?lang=uk', a).expect(200));
      expect(list.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            number: saved.number,
            name: 'Трек замовлення',
            steps: 2,
          }),
        ]),
      );
      // «Прогнати» по снимку страницы заказа: обе цели найдены.
      const tr = data(
        await ed('post', `memo/${saved.key}/try`, a)
          .send({ snapshot: orderPage(R.S.adminHost), from: 0 })
          .expect(200),
      );
      expect(tr).toMatchObject({
        stopAt: null,
        done: true,
        number: saved.number,
      });
      expect(tr.steps.map((s: { ref: string }) => s.ref)).toEqual([
        'e13',
        'e12',
      ]);
      // Подложенный панелью шаг-клик по «Зберегти» — 422, черновик не тронут.
      const forged = await ed('post', 'memo/record/stop', a)
        .send({
          memo: saved.number,
          expectedRevision: saved.draftRevision,
          lang: 'uk',
          name: 'Трек замовлення',
          steps: [
            tab.step,
            {
              action: 'click',
              page: '',
              target: {
                pin: { text: 'Зберегти' },
                assistId: null,
                role: 'button',
              },
              value: null,
            },
          ],
          slots: [],
        })
        .expect(422);
      expect(forged.body.error.code).toBe('EDITOR_MEMO_INVALID');
      // АМ-N из TMA с шагом `api`: панель видит его как `keep` и сохраняет
      // перестановку, не меняя содержимого шага.
      const memos = st.app.get(AdminMemoService);
      const om = await st.prisma.siteAccountMember.findFirstOrThrow({
        where: { accountId: R.S.accountId, telegramId: R.S.ownerTg },
      });
      const mem = {
        accountId: R.S.accountId,
        memberId: om.id,
        telegramId: R.S.ownerTg,
        role: 'owner',
        productRoles: {},
      } as unknown as AccountMembership;
      const withApi = await memos.create(mem, R.S.siteId, {
        draft: {
          names: { uk: 'Статус' },
          goal: { text: { uk: 'Статус змінено' } },
          slots: [{ name: 'order', kind: 'number' }],
          steps: [
            {
              action: 'api',
              op: R.ops.updateOrderStatus,
              opKey: 'shop.updateOrderStatus',
              args: { id: { slot: 'order' }, status: { const: 'shipped' } },
            },
          ],
        },
      });
      const opened = data(
        await ed('post', 'memo/record/start', a)
          .send({
            path: '/admin/orders/1042',
            memo: withApi.number,
            lang: 'uk',
          })
          .expect(200),
      );
      expect(opened.memo.steps).toEqual([
        expect.objectContaining({ action: 'api', keep: 0 }),
      ]);
      const kept = data(
        await ed('post', 'memo/record/stop', a)
          .send({
            memo: withApi.number,
            expectedRevision: opened.memo.draftRevision,
            lang: 'uk',
            name: 'Статус',
            steps: [tab.step, opened.memo.steps[0]],
            slots: [],
          })
          .expect(200),
      );
      expect(kept.draftRevision).toBe(opened.memo.draftRevision + 1);
      const after = await memos.get(mem, R.S.siteId, withApi.number);
      expect(after.draft.steps.map((s) => s.action)).toEqual(['ui', 'api']);
      expect(after.draft.steps[1]).toMatchObject({
        op: R.ops.updateOrderStatus,
        args: { status: { const: 'shipped' } },
      });
      expect(after.draft.slots.map((s) => s.name)).toEqual(['order']);
      // Старая ревизия — 409 (изменили в TMA/другой вкладке).
      await ed('post', 'memo/record/stop', a)
        .send({
          memo: withApi.number,
          expectedRevision: opened.memo.draftRevision,
          lang: 'uk',
          name: 'Статус',
          steps: [opened.memo.steps[0]],
          slots: [],
        })
        .expect(409);
      // «Чекати це» — только у мемо сайта.
      await ed('post', 'memo/record/wait', a)
        .send({ path: '/admin/orders/1042', descriptor: {} })
        .expect(404);
      // Аудит З13-А P3-2: кривой номер мемо — 400, не 500.
      for (const memo of ['abc', 0, 1.5, {}])
        await ed('post', 'memo/record/stop', a)
          .send({ memo, lang: 'uk', name: 'x', steps: [tab.step], slots: [] })
          .expect(400);
      // P2-1: переключатель / флажок вне формы — стоп; флажок формы — шаг, но
      // НЕ нажимается при записи.
      expect(
        data(
          await step({
            tag: 'button',
            role: 'switch',
            text: 'Активний',
          }).expect(200),
        ),
      ).toEqual({ kind: 'stop', reason: 'server_effect', step: null });
      expect(
        data(
          await step({
            tag: 'input',
            role: 'checkbox',
            inputType: 'checkbox',
            text: 'Терміново',
            inForm: true,
          }).expect(200),
        ),
      ).toMatchObject({ kind: 'step', exec: false });
      // P3-3: ссылка в строке таблицы без разметки — не шаг (ПД клиента).
      const rowStep = await step(
        {
          tag: 'a',
          role: 'link',
          text: 'Іван Петренко',
          hrefPath: '/admin/customers/55',
        },
        { row: true },
      ).expect(422);
      expect(rowStep.body.error).toMatchObject({
        code: 'EDITOR_MEMO_STEP_SKIPPED',
      });
      // P3-5: «кто правил» в строке мемо — сотрудник панели, как в журнале.
      const savedRow = await st.prisma.assistAdminMemo.findFirstOrThrow({
        where: { siteId: R.S.siteId, number: saved.number },
      });
      expect(savedRow.createdBy).toMatch(/^jwt:emp-own-/);
      expect(
        (
          await st.prisma.assistAdminMemo.findFirstOrThrow({
            where: { siteId: R.S.siteId, number: withApi.number },
          })
        ).updatedBy,
      ).toMatch(/^jwt:emp-own-/);
      // P3-4 (A6): удалённое мемо «Прогнати» не находит — 404.
      await memos.remove(mem, R.S.siteId, withApi.number);
      await ed('post', `memo/${withApi.key}/try`, a)
        .send({ snapshot: orderPage(R.S.adminHost), from: 0 })
        .expect(404);
    });

    it('микрофон «Сказать сейчас»: запись → Soniox «Админки» (убран в finally), учёт `assist-admin-stt`, общий потолок проверок; не тот тип — 400; без сессий — 401', async () => {
      const a = await openEd();
      st.soniox.reset();
      st.soniox.transcript = 'покажи журнал змін';
      const audio = Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.alloc(3000, 7),
      ]);
      const before = await st.prisma.assistAdminVoiceMap.findFirstOrThrow({
        where: { siteId: R.S.siteId },
        select: { tryCount: true },
      });
      const v = data(
        await ed('post', 'voice', a)
          .set('content-type', 'audio/webm')
          .send(audio)
          .expect(200),
      );
      expect(v).toMatchObject({ text: 'покажи журнал змін', lang: 'uk' });
      expect(typeof v.left).toBe('number');
      expect(st.soniox.count('DELETE', '/files/')).toBe(1);
      expect(st.soniox.count('DELETE', '/transcriptions/')).toBe(1);
      const afterTry = await st.prisma.assistAdminVoiceMap.findFirstOrThrow({
        where: { siteId: R.S.siteId },
        select: { tryCount: true },
      });
      expect(afterTry.tryCount).toBe(before.tryCount + 1);
      const stt = await st.prisma.siteAiUsage.findFirst({
        where: { siteId: R.S.siteId, operation: 'assist-admin-stt' },
      });
      expect(stt).not.toBeNull();
      const bad = await ed('post', 'voice', a)
        .set('content-type', 'text/plain')
        .send('hello')
        .expect(400);
      expect(bad.body.error.code).toBe('EDITOR_VOICE_AUDIO_INVALID');
      await ed('post', 'voice', null)
        .set('content-type', 'audio/webm')
        .send(audio)
        .expect(401);
      // Аудит З13-А P3-4 (A1): потолок проверок исчерпан — 429, резерв
      // суточного потолка «Админки» снят (не висит до конца суток).
      await st.prisma.assistAdminVoiceMap.updateMany({
        where: { siteId: R.S.siteId },
        data: { tryCount: 100 },
      });
      const full = await ed('post', 'voice', a)
        .set('content-type', 'audio/webm')
        .send(audio)
        .expect(429);
      expect(full.body.error.code).toBe('EDITOR_TRY_LIMIT');
      const day = await st.prisma.$queryRawUnsafe<Array<{ r: bigint }>>(
        `SELECT "reservedMicroUsd" AS r FROM "sites"."assist_budget_days" WHERE "scope" = 'admin' AND "key" = $1`,
        R.S.siteId,
      );
      expect(Number(day[0]?.r ?? 0)).toBe(0);
      await st.prisma.assistAdminVoiceMap.updateMany({
        where: { siteId: R.S.siteId },
        data: { tryCount: 0 },
      });
      // Текст дальше — тем же «Сказать сейчас» (прямой путь по карте).
      const t = data(
        await ed('post', 'try', a)
          .send({ text: v.text, snapshot: orderPage(R.S.adminHost) })
          .expect(200),
      );
      expect(t).toMatchObject({ via: 'map', key: 'history' });
    });
  },
);
