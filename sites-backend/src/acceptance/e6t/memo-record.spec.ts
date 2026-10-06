/**
 * Приёмка Э6-тер (д) «Мемо в редакторе» на реальном Postgres (ТЗ помощника
 * §5-бис.17 п.6–8, §5-кватер.5): маршруты `/editor/v1/memo/record/:op` и
 * `/editor/v1/memo/:key/try` в сессии редактора — основной ролью с
 * тенантом. Браузерная часть (пикер, клики, переход MPA, панель) — e2e
 * виджета `editor.spec.ts`.
 *
 *  - допуск: без сессии/после выхода/после смены роли — 401, как у всех
 *    `/editor/v1/*`; чужое мемо — 404;
 *  - запись: клик → шаг (цель Ш4 `uiElementId`), поле → слот без значения,
 *    «Оплатити» — стоп с подсветкой; сохранение — черновик `origin:
 *    recording`, история `editor`, лимит тарифа (402), подложенный опасный
 *    шаг или значение — 422 без черновика;
 *  - перепривязка в существующем мемо (`focus`): новый отпечаток, ревизия
 *    (409 — изменили в другой вкладке);
 *  - «Прогнать»: шаги по снимку до первого сбоя, переход — `next`, чужой
 *    хост снимка — 400, потолок — общий с «Сказать сейчас».
 * По HTTP с настоящими гвардами — `memo-record.http.spec.ts`.
 */
import { HttpException } from '@nestjs/common';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { MemoService } from '../../modules/assist-site-voice-control/cabinet/memo.service';
import { EditorMemoController } from '../../modules/assist-site-voice-map/editor/editor-memo.controller';
import { EditorMemoService } from '../../modules/assist-site-voice-map/editor/editor-memo.service';
import { EditorSessionService } from '../../modules/assist-site-voice-map/editor/editor-session.service';
import { VoiceMapService } from '../../modules/assist-site-voice-map/voice-map.service';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(300_000);

describeDb(
  'Приёмка Э6-тер (д) — мемо в редакторе: запись кликами и «Прогнать»',
  () => {
    const st = new ChatStack();
    let maps: VoiceMapService;
    let editor: EditorSessionService;
    let memos: MemoService;
    let rec: EditorMemoService;
    let ctrl: EditorMemoController;
    let clock = Date.now();

    beforeAll(async () => {
      await st.init();
      const db = new SitesDb(st.owner);
      maps = new VoiceMapService(db);
      maps.now = () => new Date(clock);
      editor = new EditorSessionService(db, maps);
      editor.now = () => new Date(clock);
      memos = new MemoService(db, st.owner as never);
      memos.now = () => new Date(clock);
      rec = new EditorMemoService(db, st.owner as never, maps, editor, memos);
      rec.now = () => new Date(clock);
      ctrl = new EditorMemoController(editor, rec);
    });
    afterAll(async () => {
      await st.close();
    });
    beforeEach(() => {
      clock = Date.now();
    });

    async function vcSite(
      plan: 'business' | 'start' = 'business',
      members: Array<{
        role: string;
        productRoles: Record<string, string>;
      }> = [],
    ): Promise<ChatSite> {
      const s = await st.site({ name: 'Магазин', members });
      await setPlan(st.owner, s.accountId, plan);
      await st.owner.siteHost.updateMany({
        where: { siteId: s.siteId },
        data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
      });
      await st.owner.assistSite.update({
        where: { siteId: s.siteId },
        data: { voiceControlSiteState: 'on' },
      });
      return s;
    }

    async function member(
      s: ChatSite,
      role = 'owner',
    ): Promise<AccountMembership> {
      const m = await st.owner.siteAccountMember.findFirst({
        where: { accountId: s.accountId, role },
        orderBy: { createdAt: 'asc' },
      });
      return {
        accountId: s.accountId,
        memberId: m!.id,
        telegramId: m!.telegramId,
        role: role as AccountMembership['role'],
        productRoles: m!.productRoles as AccountMembership['productRoles'],
      };
    }

    async function session(s: ChatSite, m?: AccountMembership) {
      const who = m ?? (await member(s));
      const link = await maps.editorLink(who, s.siteId, { path: '/product/1' });
      const ses = await editor.exchange({
        token: new URL(link.url).searchParams.get('v4c_edit')!,
        parentOrigin: s.origin,
      });
      return { who, s: ses.session };
    }

    async function code(p: Promise<unknown>): Promise<{
      status: number;
      code: string;
      errors: Array<{ path: string; code: string }>;
      reason?: string;
    }> {
      try {
        await p;
      } catch (e) {
        if (e instanceof HttpException) {
          const r = e.getResponse() as {
            code: string;
            errors?: Array<{ path: string; code: string }>;
            reason?: string;
          };
          return {
            status: e.getStatus(),
            code: r.code,
            errors: r.errors ?? [],
            reason: r.reason,
          };
        }
        throw e;
      }
      throw new Error('ожидался отказ');
    }

    const cart = {
      tag: 'button',
      role: 'button',
      text: 'В кошик',
      assistId: 'add-to-cart',
      unique: true,
    };
    const pay = {
      tag: 'button',
      role: 'button',
      text: 'Оплатити',
      unique: true,
    };
    const email = {
      tag: 'input',
      role: 'textbox',
      text: 'Ваш e-mail',
      inputType: 'email',
      pd: true,
      unique: true,
      // Подложенное «значение» поля: сервер его не принимает и не хранит.
      value: 'owner.secret@example.com',
    };
    const cartLink = (s: ChatSite) => ({
      tag: 'a',
      role: 'link',
      text: 'Кошик',
      hrefPath: '/cart',
      hrefHost: s.host,
      unique: true,
    });

    type Step = Record<string, unknown>;
    const rc = async (
      ses: string,
      op: string,
      body: unknown,
    ): Promise<unknown> => ctrl.record(ses, op, body);
    async function recordAll(ses: string, s: ChatSite) {
      await ctrl.record(ses, 'start', { path: '/product/1' });
      const steps: Step[] = [];
      const slots: Array<Record<string, unknown>> = [];
      for (const [descriptor, extra] of [
        [cart, {}],
        [email, { fieldName: 'email' }],
        [cartLink(s), {}],
      ] as const) {
        const r = (await rc(ses, 'step', {
          path: '/product/1',
          descriptor,
          ...extra,
          slots: slots.map((x) => x.name),
          count: steps.length,
        })) as {
          kind: string;
          step: Step;
          slot: Record<string, unknown> | null;
        };
        expect(r.kind).toBe('step');
        steps.push(r.step);
        if (r.slot) slots.push(r.slot);
      }
      return { steps, slots };
    }

    it('допуск: без сессии, после выхода, после смены роли на оператора — 401 на всех маршрутах мемо', async () => {
      const s = await vcSite('business', [
        { role: 'manager', productRoles: { assist: 'manager' } },
      ]);
      for (const p of [
        () => ctrl.record(undefined, 'start', { path: '/' }),
        () => ctrl.record('x'.repeat(43), 'step', { path: '/' }),
        () => ctrl.record(undefined, 'stop', {}),
        () => ctrl.tryMemo(undefined, 'abc', {}),
      ])
        expect(await code(p())).toMatchObject({
          status: 401,
          code: 'EDITOR_SESSION_EXPIRED',
        });
      const a = await session(s);
      await ctrl.record(a.s, 'start', { path: '/product/1' });
      await editor.exit(await editor.resolve(a.s));
      expect(
        (await code(ctrl.record(a.s, 'start', { path: '/' }))).status,
      ).toBe(401);
      const mgr = await member(s, 'manager');
      const b = await session(s, mgr);
      await ctrl.record(b.s, 'start', { path: '/product/1' });
      await st.owner.siteAccountMember.update({
        where: { id: mgr.memberId },
        data: { productRoles: { assist: 'operator' } },
      });
      expect(
        (await code(ctrl.record(b.s, 'step', { path: '/', descriptor: cart })))
          .status,
      ).toBe(401);
      // Неизвестная операция — 404 (после проверки сессии).
      const c = await session(s);
      expect((await code(ctrl.record(c.s, 'publish', {}))).status).toBe(404);
    });

    it('запись: клик → шаг с целью Ш4, поле → слот без значения, «Оплатити» — стоп; сохранение — черновик recording/editor', async () => {
      const s = await vcSite();
      const { s: ses } = await session(s);
      // Ш4 знает «В кошик» на этой странице — шаг ссылается на строку карты.
      const host = await st.owner.siteHost.findFirstOrThrow({
        where: { siteId: s.siteId },
      });
      const ui = await st.owner.siteUiElement.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          hostId: host.id,
          host: s.host,
          path: '/product/1',
          viewport: 'any',
          elementKey: 'a:add-to-cart',
          elementId: 'u12345678',
          tag: 'button',
          label: 'В кошик',
          selector: '[data-assist-id="add-to-cart"]',
          candidates: [],
          stability: 'strong',
          confidence: 100,
          sources: ['manual'],
          sourceRank: 0,
          position: 0,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
      const start = (await rc(ses, 'start', {
        path: '/product/1',
      })) as { page: string; limit: { used: number; max: number }; memo: null };
      expect(start).toMatchObject({
        page: '/product/1',
        limit: { used: 0, max: 20 },
        memo: null,
      });
      const { steps, slots } = await recordAll(ses, s);
      expect(steps[0]).toMatchObject({
        action: 'click',
        target: {
          uiElementId: ui.id,
          key: 'a:add-to-cart',
          pin: { assistId: 'add-to-cart', text: 'В кошик' },
        },
      });
      expect(steps[1]).toMatchObject({
        action: 'fill',
        value: { slot: 'email' },
      });
      expect(slots).toEqual([
        { name: 'email', kind: 'email', pii: true, options: [] },
      ]);
      expect(steps[2]).toMatchObject({
        action: 'click',
        expect: { path: '/cart' },
      });
      // Опасное — стоп записи с подсветкой «нажмите сами».
      const stop = (await rc(ses, 'step', {
        path: '/product/1',
        descriptor: pay,
        count: 3,
      })) as { kind: string; reason: string; step: Step | null };
      expect(stop).toMatchObject({
        kind: 'stop',
        reason: 'payment',
        step: { action: 'highlight' },
      });
      // Без подписи — отказ шага, не стоп.
      expect(
        await code(
          ctrl.record(ses, 'step', {
            path: '/product/1',
            descriptor: { tag: 'button', role: 'button', text: '', elId: 'x' },
          }),
        ),
      ).toMatchObject({
        status: 422,
        code: 'EDITOR_MEMO_STEP_SKIPPED',
        reason: 'unnamed',
      });

      const saved = (await rc(ses, 'stop', {
        lang: 'uk',
        name: 'Покласти в кошик і відкрити кошик',
        goalText: 'Товар у кошику',
        path: '/cart',
        steps: [...steps, stop.step],
        slots,
      })) as { number: number; key: string; status: string; gates: unknown };
      expect(saved).toMatchObject({ number: 1, status: 'draft' });
      const row = await st.owner.assistSiteMemo.findFirstOrThrow({
        where: { siteId: s.siteId, number: saved.number },
      });
      expect(row.origin).toBe('recording');
      expect(JSON.stringify(row.draft)).not.toContain('owner.secret');
      const draft = row.draft as {
        steps: Step[];
        goal: { expect: unknown[] };
      };
      expect(draft.steps.map((x) => x.action)).toEqual([
        'click',
        'fill',
        'click',
        'highlight',
      ]);
      expect(draft.goal.expect).toEqual([{ kind: 'url', path: '/cart' }]);
      const hist = await st.owner.assistSiteMemoChange.findMany({
        where: { memoId: row.id },
      });
      expect(hist.map((h) => h.source)).toEqual(['editor']);
      expect(JSON.stringify(hist)).not.toContain('owner.secret');
    });

    it('сохранение перепроверяет шаги: подложенный клик «Оплатити», значение вместо слота — 422 без черновика; тариф без мемо — 402', async () => {
      const s = await vcSite();
      const { s: ses } = await session(s);
      const { steps, slots } = await recordAll(ses, s);
      const evil = {
        ...steps[0],
        target: {
          ...(steps[0].target as Step),
          pin: {
            ...((steps[0].target as Step).pin as Step),
            assistId: null,
            text: 'Оплатити',
          },
        },
      };
      const e1 = await code(
        ctrl.record(ses, 'stop', { name: 'Злое', steps: [evil], slots: [] }),
      );
      expect(e1).toMatchObject({ status: 422, code: 'EDITOR_MEMO_INVALID' });
      expect(e1.errors).toEqual(
        expect.arrayContaining([{ path: 'steps[0]', code: 'never_step' }]),
      );
      const e2 = await code(
        ctrl.record(ses, 'stop', {
          name: 'Зі значенням',
          steps: [{ ...steps[1], value: { const: 'Ivan' } }],
          slots,
        }),
      );
      expect(e2.status).toBe(422);
      expect(e2.errors.map((x) => x.code)).toEqual(
        expect.arrayContaining(['value_recorded']),
      );
      expect(await code(ctrl.record(ses, 'stop', { steps }))).toMatchObject({
        status: 422,
      });
      expect(
        await st.owner.assistSiteMemo.count({ where: { siteId: s.siteId } }),
      ).toBe(0);

      const poor = await vcSite('start');
      const p = await session(poor);
      expect(
        await code(ctrl.record(p.s, 'start', { path: '/product/1' })),
      ).toMatchObject({ status: 402, code: 'MEMO_LIMIT' });
      expect(
        await code(
          ctrl.record(p.s, 'stop', {
            name: 'Мемо',
            steps: [steps[0]],
            slots: [],
          }),
        ),
      ).toMatchObject({ status: 402, code: 'MEMO_LIMIT' });
    });

    it('перепривязка шага в существующем мемо (focus): новый отпечаток, ревизия; две вкладки — 409; чужое мемо — 404', async () => {
      const s = await vcSite();
      const { s: ses } = await session(s);
      const { steps, slots } = await recordAll(ses, s);
      const saved = (await rc(ses, 'stop', {
        name: 'Кошик',
        path: '/cart',
        steps,
        slots,
      })) as { number: number; draftRevision: number };
      // Сигнал needs_review → «Открыть в редакторе» на шаге: focus `memo-N-K`
      // проходит ссылку кабинета и возвращается панели при обмене.
      const who = await member(s);
      const fl = await maps.editorLink(who, s.siteId, {
        path: '/product/1',
        focus: `memo-${saved.number}-1`,
      });
      const fx = await editor.exchange({
        token: new URL(fl.url).searchParams.get('v4c_edit')!,
        parentOrigin: s.origin,
      });
      expect(fx.focusKey).toBe(`memo-${saved.number}-1`);
      const open = (await rc(ses, 'start', {
        path: '/product/1',
        memo: saved.number,
      })) as {
        memo: {
          number: number;
          draftRevision: number;
          steps: Step[];
          name: string;
        };
      };
      expect(open.memo).toMatchObject({ number: saved.number, name: 'Кошик' });
      // «Выбрать шаг → кликнуть другой элемент».
      const re = (await rc(ses, 'step', {
        path: '/product/1',
        descriptor: { ...cart, text: 'Додати в кошик' },
        prev: open.memo.steps[0],
        count: 3,
      })) as { kind: string; step: Step };
      expect(re.kind).toBe('step');
      const next = [re.step, ...open.memo.steps.slice(1)];
      const upd = (await rc(ses, 'stop', {
        memo: saved.number,
        expectedRevision: open.memo.draftRevision,
        steps: next,
        slots,
      })) as { draftRevision: number };
      expect(upd.draftRevision).toBe(open.memo.draftRevision + 1);
      const row = await st.owner.assistSiteMemo.findFirstOrThrow({
        where: { siteId: s.siteId, number: saved.number },
      });
      const pin = ((row.draft as { steps: Step[] }).steps[0].target as Step)
        .pin as Step;
      expect(pin.text).toBe('Додати в кошик');
      // Та же ревизия ещё раз — мемо изменили «в другой вкладке».
      expect(
        await code(
          ctrl.record(ses, 'stop', {
            memo: saved.number,
            expectedRevision: open.memo.draftRevision,
            steps: next,
            slots,
          }),
        ),
      ).toMatchObject({ status: 409, code: 'MEMO_CONFLICT' });
      const hist = await st.owner.assistSiteMemoChange.findMany({
        where: { memoId: row.id },
        orderBy: { revision: 'asc' },
      });
      expect(hist.map((h) => h.source)).toEqual(['editor', 'editor']);

      // Мемо другого сайта — как несуществующее.
      const other = await vcSite();
      const o = await session(other);
      expect(
        await code(
          ctrl.record(o.s, 'start', { path: '/product/1', memo: saved.number }),
        ),
      ).toMatchObject({ status: 404, code: 'MEMO_NOT_FOUND' });
      expect(
        await code(ctrl.tryMemo(o.s, 'kosyk', { snapshot: {} })),
      ).toMatchObject({ status: 400 });
    });

    it('«Прогнать»: шаги по снимку до первого сбоя; переход — next; цель на последней странице; чужой хост — 400', async () => {
      const s = await vcSite();
      const { s: ses } = await session(s);
      const { steps, slots } = await recordAll(ses, s);
      const saved = (await rc(ses, 'stop', {
        name: 'Кошик і пошта',
        path: '/cart',
        steps,
        slots,
      })) as { key: string };
      const el = (p: Record<string, unknown>) => ({ inView: true, ...p });
      const product = (cartText: string) => ({
        url: s.url('/product/1'),
        title: 'Футболка',
        elements: [
          el({
            ref: 'e1',
            role: 'button',
            tag: 'button',
            text: cartText,
            assistId: 'add-to-cart',
          }),
          el({
            ref: 'e2',
            role: 'textbox',
            tag: 'input',
            inputType: 'email',
            text: 'Ваш e-mail',
          }),
          el({
            ref: 'e3',
            role: 'link',
            tag: 'a',
            text: 'Кошик',
            href: s.url('/cart'),
          }),
        ],
      });
      const ok = (await ctrl.tryMemo(ses, saved.key, {
        snapshot: product('В кошик'),
      })) as {
        steps: Array<{ i: number; ok: boolean; ref: string | null }>;
        stopAt: number | null;
        done: boolean;
        left: number;
      };
      expect(ok.steps.map((x) => [x.i, x.ok, x.ref])).toEqual([
        [0, true, 'e1'],
        [1, true, 'e2'],
        [2, true, 'e3'],
      ]);
      expect(ok.stopAt).toBeNull();
      expect(ok.done).toBe(true);
      // Подмена кнопки под той же разметкой — стоп на шаге 1 с причиной.
      const bad = (await ctrl.tryMemo(ses, saved.key, {
        snapshot: product('Купити в 1 клік'),
      })) as {
        stopAt: number;
        problem: string;
        steps: unknown[];
        left: number;
      };
      expect(bad).toMatchObject({ stopAt: 0, problem: 'pin_mismatch' });
      expect(bad.steps).toHaveLength(1);
      expect(bad.left).toBe(ok.left - 1);
      // Снимок с чужого адреса — 400; несуществующее мемо — 404.
      expect(
        await code(
          ctrl.tryMemo(ses, saved.key, {
            snapshot: {
              ...product('В кошик'),
              url: 'https://evil.example.org/product/1',
            },
          }),
        ),
      ).toMatchObject({ status: 400 });
      expect(
        await code(
          ctrl.tryMemo(ses, 'nema-takoho', { snapshot: product('В кошик') }),
        ),
      ).toMatchObject({ status: 404, code: 'MEMO_NOT_FOUND' });
    });
  },
);
