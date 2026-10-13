/**
 * AT-CORE-02 / AT-CORE-09 / AT-F11, HTTP-часть публичного API P-D
 * (проектный документ §3.2, §11.4, §13.5; аудит P2-24): допуск по Origin в
 * каждом режиме, CORS без cookie, потолки тела (413), события `text/plain`
 * (`sendBeacon`), дедупликация `eventId`, очистка UTM/пути, 429 событий,
 * 503 без ключа шифрования и при закрытой форме — с альтернативным
 * контактом, конфиг сайта и его кэш.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import type { CoreStack } from '../../modules/publisher/core/testing/core-stack.testing';
import { PUBLIC_LIMITS } from '../../modules/publisher/contracts/public-api';
import {
  decideParam,
  intakeProduct,
  leadBody,
  leadsStack,
  postEvent,
  postLead,
  randomIp,
  testSessionRef,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';

jest.setTimeout(120_000);

const event = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  eventId: randomUUID(),
  name: 'content_view',
  path: '/materials/kak-vybraty',
  contentSlug: 'kak-vybraty',
  consentState: 'not_required',
  clientAt: new Date().toISOString(),
  ...over,
});

ciDescribe(
  '[AT-CORE-02] Публичный API по HTTP: Origin, CORS, тело, лимиты, честные ошибки',
  () => {
    let s: CoreStack;
    let test: IntakeWorld;
    let live: IntakeWorld;
    let restore: Array<() => void>;
    const srv = () => s.app!.getHttpServer();

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      test = await intakeProduct(s, { kind: 'test' });
      live = await intakeProduct(s, { kind: 'working' });
    });
    afterAll(async () => {
      await s.close();
      restore.forEach((r) => r());
    });

    it('режим test: Origin из test_hosts — 201, чужой — 403 PUB_ORIGIN_DENIED, без Origin POST — 403', async () => {
      expect(
        (
          await postLead(s, leadBody(test.product.publicKey), {
            origin: test.origin,
            ip: randomIp(),
          })
        ).status,
      ).toBe(201);
      const fb = leadBody(test.product.publicKey);
      const foreign = await postLead(s, fb, {
        origin: 'https://evil.example',
        ip: randomIp(),
      });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.code).toBe('PUB_ORIGIN_DENIED');
      const nb = leadBody(test.product.publicKey);
      const none = await postLead(s, nb, { ip: randomIp() });
      expect(none.status).toBe(403);
      // Отказ по Origin ничего не пишет.
      expect(
        await s.prisma.pubLead.count({
          where: {
            submissionKey: { in: [fb.submissionKey, nb.submissionKey] },
          },
        }),
      ).toBe(0);
    });

    it('режим live: только verified-хост сайта; заявки нетестовые; test_hosts в live не действуют', async () => {
      const body = leadBody(live.product.publicKey);
      const ok = await postLead(s, body, {
        origin: live.origin,
        ip: randomIp(),
      });
      expect(ok.status).toBe(201);
      const lead = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      expect(lead.testFlag).toBe(false);
      expect(
        (
          await postLead(s, leadBody(live.product.publicKey), {
            origin: test.origin,
            ip: randomIp(),
          })
        ).status,
      ).toBe(403);
    });

    it('live с закрытым гейтом real_leads → 503 PUB_FORM_CLOSED с альтернативным контактом; ничего не пишется', async () => {
      await s.prisma
        .$executeRaw`UPDATE "sites"."pub_products" SET "paramsRealLeadsOk" = false WHERE "id" = ${live.product.id}`;
      try {
        const body = leadBody(live.product.publicKey);
        const r = await postLead(s, body, {
          origin: live.origin,
          ip: randomIp(),
        });
        expect(r.status).toBe(503);
        expect(r.body.error.code).toBe('PUB_FORM_CLOSED');
        expect(r.body.error.details).toEqual({
          altContact: {
            label: 'Напишіть нам у Telegram',
            href: 'https://t.me/pubd_support',
          },
          reason: 'closed',
        });
        expect(
          await s.prisma.pubLead.count({
            where: { submissionKey: body.submissionKey },
          }),
        ).toBe(0);
        // События в live при закрытой форме принимаются (форма ≠ трекинг).
        const ev = await postEvent(s, event(live.product.publicKey), {
          origin: live.origin,
          ip: randomIp(),
        });
        expect(ev.status).toBe(202);
      } finally {
        await s.prisma
          .$executeRaw`UPDATE "sites"."pub_products" SET "paramsRealLeadsOk" = true WHERE "id" = ${live.product.id}`;
      }
    });

    it('CORS: Origin отражается без credentials; preflight OPTIONS отвечает', async () => {
      const pre = await request(srv())
        .options('/public/publisher/v1/leads')
        .set('Origin', test.origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(pre.status).toBeLessThan(300);
      expect(pre.headers['access-control-allow-origin']).toBe(test.origin);
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('потолок тела: заявка > 8 КБ → 413 PUB_PAYLOAD_TOO_LARGE; событие > 2 КБ → 413; битый JSON заявки → 400', async () => {
      const big = leadBody(test.product.publicKey, { task: 'я'.repeat(5000) });
      const r = await postLead(s, big, { origin: test.origin, ip: randomIp() });
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe('PUB_PAYLOAD_TOO_LARGE');
      const ev = await postEvent(
        s,
        event(test.product.publicKey, { path: `/${'a'.repeat(2100)}` }),
        { origin: test.origin },
      );
      expect(ev.status).toBe(413);
      const broken = await request(srv())
        .post('/public/publisher/v1/leads')
        .set('Origin', test.origin)
        .set('Content-Type', 'application/json')
        .send('{"key":');
      expect(broken.status).toBe(400);
      expect(broken.body.error.code).toBe('PUB_VALIDATION');
    });

    it('S3-1: потолок 8 КБ заявки при ЛЮБОМ Content-Type — urlencoded 60 КБ → 413, не-JSON → 400; JSON в text/plain принимается', async () => {
      const before = await s.prisma.pubLead.count({
        where: { productId: test.product.id },
      });
      const big = await request(srv())
        .post('/public/publisher/v1/leads')
        .set('Origin', test.origin)
        .set('X-Forwarded-For', randomIp())
        .type('form')
        .send(`key=${test.product.publicKey}&pad=${'x'.repeat(60_000)}`);
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe('PUB_PAYLOAD_TOO_LARGE');
      const form = await request(srv())
        .post('/public/publisher/v1/leads')
        .set('Origin', test.origin)
        .set('X-Forwarded-For', randomIp())
        .type('form')
        .send(`key=${test.product.publicKey}&name=x`);
      expect(form.status).toBe(400);
      expect(form.body.error).toMatchObject({
        code: 'PUB_VALIDATION',
        details: { fields: [{ field: 'body', code: 'json' }] },
      });
      expect(
        await s.prisma.pubLead.count({ where: { productId: test.product.id } }),
      ).toBe(before);
      const body = leadBody(test.product.publicKey);
      const plain = await request(srv())
        .post('/public/publisher/v1/leads')
        .set('Origin', test.origin)
        .set('X-Forwarded-For', randomIp())
        .set('Content-Type', 'text/plain;charset=UTF-8')
        .send(JSON.stringify(body));
      expect(plain.status).toBe(201);
    });

    it('S3-2: sessionRef и сегмент пути, похожие на телефон, не сохраняются (событие и заявка)', async () => {
      const sp = await intakeProduct(s, { kind: 'test', analytics: 'session' });
      const ev = event(sp.product.publicKey, {
        sessionRef: '380671234567',
        path: '/call-me/380671234567/ivan.petrenko',
      });
      expect(
        (await postEvent(s, ev, { origin: sp.origin, ip: randomIp() })).status,
      ).toBe(202);
      const row = await s.prisma.pubEvent.findFirstOrThrow({
        where: { eventId: ev.eventId },
      });
      expect(row.sessionRef).toBeNull();
      expect(
        await s.prisma.pubSession.count({
          where: { productId: sp.product.id },
        }),
      ).toBe(0);
      // Нормальный ref — сессия с путём; путь с телефоном — «/».
      const okRef = testSessionRef();
      const ok = event(sp.product.publicKey, {
        sessionRef: okRef,
        path: '/call-me/0671234567',
      });
      expect(
        (await postEvent(s, ok, { origin: sp.origin, ip: randomIp() })).status,
      ).toBe(202);
      expect(
        (
          await s.prisma.pubSession.findFirstOrThrow({
            where: { productId: sp.product.id, sessionRef: okRef },
          })
        ).landingPath,
      ).toBe('/');
      const lb = leadBody(sp.product.publicKey, { sessionRef: '0501234567x' });
      expect(
        (await postLead(s, lb, { origin: sp.origin, ip: randomIp() })).status,
      ).toBe(201);
      expect(
        (
          await s.prisma.pubLead.findFirstOrThrow({
            where: { submissionKey: lb.submissionKey },
          })
        ).sessionRef,
      ).toBeNull();
    });

    it('событие text/plain (sendBeacon) → 202 {}; дубликат eventId — тоже 202 без второй строки', async () => {
      const body = event(test.product.publicKey);
      const a = await postEvent(s, body, {
        origin: test.origin,
        ip: randomIp(),
      });
      expect(a.status).toBe(202);
      expect(a.body.data).toEqual({});
      const b = await postEvent(s, body, {
        origin: test.origin,
        ip: randomIp(),
      });
      expect(b.status).toBe(202);
      expect(
        await s.prisma.pubEvent.count({
          where: { productId: test.product.id, eventId: body.eventId },
        }),
      ).toBe(1);
      const row = await s.prisma.pubEvent.findFirstOrThrow({
        where: { eventId: body.eventId },
      });
      expect(row).toMatchObject({
        name: 'content_view',
        testFlag: true,
        contentSlugRaw: 'kak-vybraty',
        leadId: null,
        createdBy: 'public',
      });
    });

    it('клиент не может прислать lead_submit_success (его создаёт сервер) → 400', async () => {
      const r = await postEvent(
        s,
        event(test.product.publicKey, { name: 'lead_submit_success' }),
        { origin: test.origin },
      );
      expect(r.status).toBe(400);
      expect(r.body.error.details.fields).toEqual([
        { field: 'name', code: 'enum' },
      ]);
    });

    it('очистка: UTM с email/телефоном → [redacted] + флаг; путь без query/фрагмента; referrer — только хост; sessionRef без хранения не сохраняется', async () => {
      const body = event(test.product.publicKey, {
        path: '/materials/kak-vybraty?email=a@b.c#x',
        referrerHost: 'https://www.google.com/search?q=secret',
        sessionRef: 'sref_abcdefgh123',
        utm: {
          utm_source: 'ivan@example.com',
          utm_medium: 'social',
          campaign: '+380 67 123 45 67',
          bad: 'x',
        },
      });
      expect(
        (await postEvent(s, body, { origin: test.origin, ip: randomIp() }))
          .status,
      ).toBe(202);
      const row = await s.prisma.pubEvent.findFirstOrThrow({
        where: { eventId: body.eventId },
      });
      expect(row.utm).toEqual({
        source: '[redacted]',
        medium: 'social',
        campaign: '[redacted]',
      });
      expect(row.utmRedacted).toBe(true);
      expect(row.referrerHost).toBe('www.google.com');
      // analytics_storage = none (умолчание): sessionRef не хранится, сессии нет.
      expect(row.sessionRef).toBeNull();
      expect(
        await s.prisma.pubSession.count({
          where: { productId: test.product.id },
        }),
      ).toBe(0);
    });

    it('лимит событий: 120 в минуту с IP → 121-е — 429 с Retry-After', async () => {
      const ip = randomIp();
      const p = await intakeProduct(s, { kind: 'test' });
      let last = 0;
      for (let i = 0; i < PUBLIC_LIMITS.eventsPerIpMinute; i++) {
        last = (
          await postEvent(s, event(p.product.publicKey), {
            origin: p.origin,
            ip,
          })
        ).status;
        if (last !== 202) break;
      }
      expect(last).toBe(202);
      const over = await postEvent(s, event(p.product.publicKey), {
        origin: p.origin,
        ip,
      });
      expect(over.status).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('без ключа шифрования приём заявок и событий закрыт честным 503', async () => {
      const saved = process.env.ASSIST_SECRETS_KEY;
      delete process.env.ASSIST_SECRETS_KEY;
      try {
        const l = await postLead(s, leadBody(test.product.publicKey), {
          origin: test.origin,
          ip: randomIp(),
        });
        expect(l.status).toBe(503);
        expect(l.body.error.code).toBe('PUB_CONTACT_KEY_MISSING');
        const e = await postEvent(s, event(test.product.publicKey), {
          origin: test.origin,
        });
        expect(e.status).toBe(503);
      } finally {
        process.env.ASSIST_SECRETS_KEY = saved;
      }
    });

    it('GET /site-config: без Origin (сборка) — 200, кэш s-maxage=60, Vary: Origin; чужой Origin — 403; неизвестный ключ — 404', async () => {
      const r = await request(srv())
        .get('/public/publisher/v1/site-config')
        .query({
          key: live.product.publicKey,
          host: new URL(live.origin).host,
        });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toContain('s-maxage=60');
      expect(r.headers.vary).toContain('Origin');
      expect(r.body.data).toMatchObject({
        mode: 'live',
        indexable: true,
        formOpen: true,
        altContact: {
          label: 'Напишіть нам у Telegram',
          href: 'https://t.me/pubd_support',
        },
        analyticsStorage: 'none',
        formLimit: { count: 5, windowSec: 600 },
        contactSla: null,
      });
      const t = await request(srv())
        .get('/public/publisher/v1/site-config')
        .query({ key: test.product.publicKey, host: 'any.example' });
      expect(t.body.data).toMatchObject({
        mode: 'test',
        indexable: false,
        formOpen: true,
      });
      const foreign = await request(srv())
        .get('/public/publisher/v1/site-config')
        .set('Origin', 'https://evil.example')
        .query({ key: live.product.publicKey });
      expect(foreign.status).toBe(403);
      const unknown = await request(srv())
        .get('/public/publisher/v1/site-config')
        .query({ key: `pp_${'Z'.repeat(24)}` });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('PUB_NOT_FOUND');
      // Р-PUB-Z2-9: правило срока ответа — из утверждённого contact_sla
      // (до решения — null, сайт берёт умолчание).
      await decideParam(
        s,
        live.product,
        'contact_sla',
        {
          rule: 'next_business_day_end',
          calendar: {
            workdays: [1, 2, 3, 4, 5],
            holidays: [],
            dayEnd: '18:00',
          },
        },
        'approved',
        live.account.owner.memberId,
      );
      const sla = await request(srv())
        .get('/public/publisher/v1/site-config')
        .query({ key: live.product.publicKey });
      expect(sla.body.data.contactSla).toEqual({
        rule: 'next_business_day_end',
      });
    });

    it('ошибки публичного API — общий конверт, текст по Accept-Language, без кэша', async () => {
      const r = await postLead(s, leadBody(test.product.publicKey), {
        origin: 'https://evil.example',
        ip: randomIp(),
      }).set('Accept-Language', 'en');
      expect(r.status).toBe(403);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toMatchObject({
        success: false,
        error: { code: 'PUB_ORIGIN_DENIED' },
        meta: { path: '/public/publisher/v1/leads' },
      });
      expect(typeof r.body.error.message).toBe('string');
    });
  },
);
