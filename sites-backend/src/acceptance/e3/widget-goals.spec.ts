/**
 * Э3 (W): маршруты СТРАНИЦЫ заказчика по HTTP — счётчики событий, цели,
 * режим выбора цели (ТЗ §4.16, §5-тер.1, §5-тер.14; контракт Э3 §6, §7
 * «серверные спеки маршрутов»). Стыки с A — подделки (testing/widget-stack):
 * здесь — допуск W (Origin = точный допущенный хост pk, visitor-token у
 * iframe), белый список полей (неизвестное — 400), батч ≤ 20 и тело ≤ 4 КБ,
 * text/plain от sendBeacon, orderId-контакт — 422, ответ 204 не оракул,
 * токен выбора цели одноразовый и только для своего хоста, результат
 * выбора пишется ПОД РОЛЬЮ виджета, поле ввода выбрать нельзя; в логах —
 * ни orderId, ни сумм, ни текста элемента.
 */
import { Logger, type LoggerService } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import {
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_VISITOR_TOKEN_HEADER,
} from '../../brand';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { sha256Hex } from '../../modules/assist-widget/site-access';
import {
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

// Поднятие стенда и HTTP-серии под нагрузкой CI дольше 5 с по умолчанию.
jest.setTimeout(30_000);

class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(args: unknown[]) {
    this.lines.push(args.map((a) => String(a)).join(' '));
  }
  log(...a: unknown[]) {
    this.push(a);
  }
  error(...a: unknown[]) {
    this.push(a);
  }
  warn(...a: unknown[]) {
    this.push(a);
  }
  debug(...a: unknown[]) {
    this.push(a);
  }
  verbose(...a: unknown[]) {
    this.push(a);
  }
  fatal(...a: unknown[]) {
    this.push(a);
  }
}

const ENGAGEMENT = {
  schema: 1,
  triggers: [
    {
      key: 'delivery',
      enabled: true,
      condition: { kind: 'time_on_page', seconds: 15 },
      pathMasks: [],
      text: { ru: 'Подсказать?' },
      onAccept: { kind: 'open' },
    },
    {
      key: 'off-one',
      enabled: false,
      condition: { kind: 'time_on_page', seconds: 15 },
      pathMasks: [],
      text: { ru: 'Выключен' },
      onAccept: { kind: 'open' },
    },
  ],
  limits: { perVisit: 1, excludedPaths: [], notOnFirstScreenMobile: true },
  scenarios: [],
};

describeDb(
  'Э3 (W): счётчики, цели и режим выбора цели — маршруты страницы',
  () => {
    let stack: WidgetStack;
    const cap = new CaptureLogger();
    const srv = () => stack.app.getHttpServer();
    const ip = () => `${randomV6Prefix()}::7`;

    beforeAll(async () => {
      stack = await startWidgetStack();
      Logger.overrideLogger(cap);
    });
    afterAll(async () => {
      Logger.overrideLogger(false);
      await stack?.close();
    });

    const event = (origin: string | null, body: unknown, type = 'json') => {
      const r = request(srv())
        .post('/widget/v1/event')
        .set('X-Forwarded-For', ip());
      if (origin) r.set('Origin', origin);
      if (type === 'text') {
        return r
          .set('Content-Type', 'text/plain;charset=UTF-8')
          .send(typeof body === 'string' ? body : JSON.stringify(body));
      }
      return r.send(body as object);
    };

    describe('POST /widget/v1/event', () => {
      let f: WidgetFixture;
      beforeAll(async () => {
        f = await widgetFixture(
          stack,
          [{ host: domain() }, { host: domain(), enabled: false }],
          { engagement: ENGAGEMENT },
        );
      });

      it('Origin = допущенный хост pk → 204; пишутся только ключи включённых триггеров', async () => {
        const before = stack.events.batches.length;
        await event(f.hosts[0].origin, {
          pk: f.pk,
          events: [
            { kind: 'widget_view', key: null },
            { kind: 'proactive_shown', key: 'delivery' },
            { kind: 'proactive_shown', key: 'off-one' },
            { kind: 'proactive_shown', key: 'made-up' },
            { kind: 'open', key: null },
          ],
        }).expect(204);
        expect(stack.events.batches.length).toBe(before + 1);
        expect(stack.events.batches.at(-1)).toEqual({
          siteId: f.siteId,
          events: [
            { kind: 'widget_view', key: null },
            { kind: 'proactive_shown', key: 'delivery' },
            { kind: 'open', key: null },
          ],
        });
      });

      it('text/plain от sendBeacon — строкой ≤ 4 КБ → 204', async () => {
        await event(
          f.hosts[0].origin,
          { pk: f.pk, events: [{ kind: 'open', key: null }] },
          'text',
        ).expect(204);
        await event(f.hosts[0].origin, '{битый', 'text').expect(400);
      });

      it('Origin чужого сайта / выключенного хоста / без Origin / localhost у live → 403 ORIGIN_DENIED', async () => {
        const before = stack.events.batches.length;
        const body = { pk: f.pk, events: [{ kind: 'open', key: null }] };
        for (const o of [
          `https://${domain('evil')}`,
          f.hosts[1].origin,
          null,
          'http://localhost:3000',
          `${f.hosts[0].origin}/path`,
        ]) {
          const r = await event(o, body).expect(403);
          expect(r.body.error.code).toBe('ORIGIN_DENIED');
        }
        // Чужой pk — ключ неизвестен.
        await event(f.hosts[0].origin, {
          ...body,
          pk: WIDGET_PK_LIVE_PREFIX + 'x'.repeat(24),
        }).expect(404);
        expect(stack.events.batches.length).toBe(before);
      });

      it('неизвестное поле, вид, ключ, > 20 событий, > 4 КБ → 400 EVENT_INVALID', async () => {
        const o = f.hosts[0].origin;
        for (const body of [
          { pk: f.pk, events: [{ kind: 'open', key: null, url: '/x' }] },
          { pk: f.pk, events: [{ kind: 'open', key: null }], visitorId: 'v1' },
          { pk: f.pk, events: [{ kind: 'page_view', key: null }] },
          { pk: f.pk, events: [{ kind: 'proactive_shown', key: 'Bad Key' }] },
          {
            pk: f.pk,
            events: Array.from({ length: 21 }, () => ({
              kind: 'open',
              key: null,
            })),
          },
          { pk: f.pk, events: [] },
        ]) {
          const r = await event(o, body).expect(400);
          expect(r.body.error.code).toBe('EVENT_INVALID');
        }
        const big = JSON.stringify({
          pk: f.pk,
          events: [{ kind: 'open', key: null }],
          pad: 'x'.repeat(5000),
        });
        await event(o, big, 'text').expect((r) => {
          // body-parser режет > 4 КБ сам (413) или разбор — 400: в базу ничего.
          expect([400, 413]).toContain(r.status);
        });
      });
    });

    describe('POST /widget/v1/goal', () => {
      let f: WidgetFixture;
      beforeAll(async () => {
        f = await widgetFixture(stack, [{ host: domain() }]);
      });
      const goal = (
        origin: string,
        body: Record<string, unknown>,
        token?: string,
      ) => {
        const r = request(srv())
          .post('/widget/v1/goal')
          .set('Origin', origin)
          .set('X-Forwarded-For', '203.0.113.9');
        if (token) r.set(WIDGET_VISITOR_TOKEN_HEADER, token);
        return r.send(body);
      };
      const base = {
        goalKey: 'purchase',
        detector: 'js',
        docId: 'doc_abcdefgh12',
        path: '/thanks',
      };

      it('загрузчик: Origin хоста + pk → GoalIntake.fromLoader с сырым IP (CIDR офиса); 204', async () => {
        await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          orderId: 'A-1042',
          value: 1299,
          currency: 'UAH',
        }).expect(204);
        const c = stack.goals.fromLoaderCalls.at(-1)!;
        expect(c.site.siteId).toBe(f.siteId);
        expect(c.rawIp).toBe('203.0.113.9');
        expect(c.hit).toMatchObject({
          goalKey: 'purchase',
          detector: 'js',
          docId: 'doc_abcdefgh12',
          path: '/thanks',
          orderId: 'A-1042',
          value: 1299,
          currency: 'UAH',
        });
      });

      it('e-mail/телефон в orderId → 422 GOAL_ORDER_ID_INVALID (формат W); ответ A «контакт» → 422; прочее A → 204', async () => {
        const r = await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          orderId: 'ivan@example.com',
        }).expect(422);
        expect(r.body.error.code).toBe('GOAL_ORDER_ID_INVALID');
        stack.goals.result = 'GOAL_ORDER_ID_INVALID';
        await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          orderId: '380671234567',
        }).expect(422);
        for (const res of ['GOAL_UNKNOWN', 'duplicate', 'ignored'] as const) {
          stack.goals.result = res;
          await goal(f.hosts[0].origin, { ...base, pk: f.pk }).expect(204);
        }
        stack.goals.result = 'recorded';
      });

      it('страница не назначает себе атрибуцию: поля iframe и чужие поля от загрузчика → 400; чужой Origin → 403', async () => {
        const n = stack.goals.fromLoaderCalls.length;
        await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          assist: { proactive: null, scenario: null, link: true },
        }).expect(400);
        await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          lastAssistClickAt: new Date().toISOString(),
        }).expect(400);
        await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          phone: '+380',
        }).expect(400);
        await goal(f.hosts[0].origin, {
          ...base,
          pk: f.pk,
          path: '/t?e=a@b.c',
        }).expect(400);
        await goal(`https://${domain('evil')}`, { ...base, pk: f.pk }).expect(
          403,
        );
        expect(stack.goals.fromLoaderCalls.length).toBe(n);
      });

      it('iframe: visitor-token + Origin виджета → fromIframe с диалогом посетителя и временем клика; чужой диалог — null', async () => {
        const sess = async () =>
          (
            await request(srv())
              .post('/widget/v1/session')
              .set('Origin', W_ORIGIN)
              .set('X-Forwarded-For', ip())
              .send({ pk: f.pk, parentOrigin: f.hosts[0].origin })
              .expect(200)
          ).body.data.visitorToken as string;
        const a = await sess();
        const b = await sess();
        const conv = await request(srv())
          .post('/widget/v1/chat')
          .set('Origin', W_ORIGIN)
          .set(WIDGET_VISITOR_TOKEN_HEADER, a)
          .set('Accept', 'application/json')
          .send({
            conversationId: null,
            clientRequestId: newRequestId(),
            question: 'Вопрос',
            page: { url: null, title: null },
            context: null,
            uiLang: 'ru',
          })
          .expect(200);
        const cid = conv.body.data.conversationId as string;
        const click = new Date(Date.now() - 60_000).toISOString();
        const body = {
          ...base,
          detector: 'click',
          conversationId: cid,
          lastAssistClickAt: click,
          assist: { proactive: 'delivery', scenario: null, link: true },
        };
        await goal(W_ORIGIN, body, a).expect(204);
        const c = stack.goals.fromIframeCalls.at(-1)!;
        expect(c.conversationId).toBe(cid);
        expect(c.visitor.visitorId).toBeTruthy();
        expect(c.lastAssistClickAt?.toISOString()).toBe(click);
        expect(c.assist).toEqual({
          proactive: 'delivery',
          scenario: null,
          link: true,
        });
        // Чужой посетитель с тем же conversationId — без диалога.
        await goal(W_ORIGIN, body, b).expect(204);
        expect(stack.goals.fromIframeCalls.at(-1)!.conversationId).toBeNull();
        // Клик «из будущего» — без времени клика (не direct).
        await goal(
          W_ORIGIN,
          {
            ...body,
            lastAssistClickAt: new Date(Date.now() + 3600e3).toISOString(),
          },
          a,
        ).expect(204);
        expect(
          stack.goals.fromIframeCalls.at(-1)!.lastAssistClickAt,
        ).toBeNull();
        // Токен с Origin страницы — отказ сессии (токен не уносится на страницу).
        await goal(f.hosts[0].origin, body, a).expect(403);
        // Негодный токен — 401, а не «тихо как загрузчик».
        await goal(W_ORIGIN, { ...base, pk: f.pk }, 'garbage').expect(401);
      });

      it('text/plain от sendBeacon загрузчика → 204', async () => {
        await request(srv())
          .post('/widget/v1/goal')
          .set('Origin', f.hosts[0].origin)
          .set('Content-Type', 'text/plain;charset=UTF-8')
          .send(
            JSON.stringify({
              ...base,
              pk: f.pk,
              detector: 'url',
              orderId: 'B-77',
            }),
          )
          .expect(204);
        expect(stack.goals.fromLoaderCalls.at(-1)!.hit.orderId).toBe('B-77');
      });
    });

    describe('режим выбора цели (goal-picker)', () => {
      let f: WidgetFixture;
      beforeAll(async () => {
        f = await widgetFixture(stack, [
          { host: domain() },
          { host: domain() },
        ]);
      });
      async function token(
        p: {
          origin?: string;
          purpose?: string;
          expiresAt?: Date;
        } = {},
      ): Promise<{ raw: string; id: string }> {
        const raw = randomBytes(32).toString('base64url');
        const row = await stack.prisma.assistSitePreviewToken.create({
          data: {
            accountId: f.accountId,
            siteId: f.siteId,
            tokenHash: sha256Hex(raw),
            purpose: p.purpose ?? 'goal',
            origin: p.origin ?? f.hosts[0].origin,
            createdByTelegramId: f.owner,
            expiresAt: p.expiresAt ?? new Date(Date.now() + 30 * 60_000),
          },
        });
        return { raw, id: row.id };
      }
      const session = (origin: string, raw: string) =>
        request(srv())
          .post('/widget/v1/goal-picker/session')
          .set('Origin', origin)
          .set('X-Forwarded-For', ip())
          .send({ pk: f.pk, token: raw });
      const pick = (origin: string, body: Record<string, unknown>) =>
        request(srv())
          .post('/widget/v1/goal-picker/pick')
          .set('Origin', origin)
          .set('X-Forwarded-For', ip())
          .send(body);
      const desc = {
        assistGoal: null,
        assistId: null,
        role: 'button',
        text: 'Оформить заказ',
        tag: 'button',
      };

      it('обмен один раз; выбор пишется в result ПОД РОЛЬЮ виджета; повторный выбор — перезапись', async () => {
        const t = await token();
        const s = await session(f.hosts[0].origin, t.raw).expect(200);
        const ps = s.body.data.pickerSession as string;
        expect(ps).toMatch(/^[A-Za-z0-9_-]{43}$/);
        await session(f.hosts[0].origin, t.raw).expect(403);
        await pick(f.hosts[0].origin, {
          pickerSession: ps,
          kind: 'click',
          descriptor: desc,
          path: '/product/1',
          label: 'Оформить заказ',
        }).expect(200);
        const row = await stack.prisma.assistSitePreviewToken.findUniqueOrThrow(
          {
            where: { id: t.id },
          },
        );
        expect(row.result).toMatchObject({
          kind: 'click',
          path: '/product/1',
          label: 'Оформить заказ',
          descriptor: { role: 'button', text: 'Оформить заказ', tag: 'button' },
        });
        expect(row.usedAt).not.toBeNull();
        await pick(f.hosts[0].origin, {
          pickerSession: ps,
          kind: 'form_submit',
          descriptor: { ...desc, role: 'form', tag: 'form' },
          path: '/cart',
          label: 'Оформить заказ',
        }).expect(200);
        const row2 =
          await stack.prisma.assistSitePreviewToken.findUniqueOrThrow({
            where: { id: t.id },
          });
        expect(row2.result).toMatchObject({
          kind: 'form_submit',
          path: '/cart',
        });
      });

      it('поле ввода выбрать нельзя; лишнее поле/путь с query — 400; ничего не пишется', async () => {
        const t = await token();
        const ps = (await session(f.hosts[0].origin, t.raw).expect(200)).body
          .data.pickerSession as string;
        for (const body of [
          {
            pickerSession: ps,
            kind: 'click',
            descriptor: { ...desc, tag: 'input' },
            path: '/a',
            label: 'x',
          },
          {
            pickerSession: ps,
            kind: 'click',
            descriptor: { ...desc, tag: 'textarea' },
            path: '/a',
            label: 'x',
          },
          {
            pickerSession: ps,
            kind: 'click',
            descriptor: { ...desc, role: 'textbox', tag: 'div' },
            path: '/a',
            label: 'x',
          },
          {
            pickerSession: ps,
            kind: 'click',
            descriptor: { ...desc, value: '42' },
            path: '/a',
            label: 'x',
          },
          {
            pickerSession: ps,
            kind: 'click',
            descriptor: desc,
            path: '/a?email=a@b.c',
            label: 'x',
          },
        ]) {
          await pick(f.hosts[0].origin, body).expect(400);
        }
        const row = await stack.prisma.assistSitePreviewToken.findUniqueOrThrow(
          {
            where: { id: t.id },
          },
        );
        expect(row.result).toBeNull();
      });

      it('токен другого хоста / purpose site / истёкший / чужой pk → 403 PICKER_INVALID; сессия — только со своего хоста', async () => {
        const other = await token({ origin: f.hosts[1].origin });
        const r = await session(f.hosts[0].origin, other.raw).expect(403);
        expect(r.body.error.code).toBe('PICKER_INVALID');
        await session(
          f.hosts[0].origin,
          (await token({ purpose: 'site' })).raw,
        ).expect(403);
        await session(
          f.hosts[0].origin,
          (await token({ expiresAt: new Date(Date.now() - 1000) })).raw,
        ).expect(403);
        // Токен не тратится попытками с чужого хоста: со своего — работает.
        const ok = await session(f.hosts[1].origin, other.raw).expect(200);
        await pick(f.hosts[0].origin, {
          pickerSession: ok.body.data.pickerSession,
          kind: 'click',
          descriptor: desc,
          path: '/a',
          label: 'x',
        }).expect(403);
        await pick(f.hosts[1].origin, {
          pickerSession: 'z'.repeat(43),
          kind: 'click',
          descriptor: desc,
          path: '/a',
          label: 'x',
        }).expect(403);
      });

      it('в логах — ни orderId, ни сумм, ни текста элемента, ни токенов', () => {
        const all = cap.lines.join('\n');
        for (const secret of [
          'A-1042',
          '1299',
          'B-77',
          'Оформить заказ',
          'ivan@example.com',
          '380671234567',
        ]) {
          expect(all).not.toContain(secret);
        }
        expect(all).toMatch(/goal page site=/);
        expect(all).toMatch(/picker pick site=/);
      });
    });
  },
);
