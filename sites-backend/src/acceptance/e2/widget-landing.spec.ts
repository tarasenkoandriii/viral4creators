/**
 * Открытые маршруты W2 по HTTP на настоящем Postgres под ролью
 * assist_public (контракт Э2 §6, лендинг-ТЗ §5.3/§7.3/§10.1/§17.3):
 *  - `POST /public/landing/event`: батч ≤ 20, тело ≤ 4 КБ, путь без query,
 *    мусор — отброшен, лимит на ipHash в минуту, origin — ASSIST_LANDING_ORIGINS;
 *  - `GET /public/assist/plans` — снимок тарифов;
 *  - `POST /public/widget-drafts` («к Л3») — ≤ 2 КБ, без hosts/картинок,
 *    10 в сутки на ipHash, id 128 бит;
 *  - `POST /assist/acquisition` (кабинет) — одна запись на кабинет;
 *  - пинг загрузчика картинкой и отдача картинок бренда.
 */
import { Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as request from 'supertest';
import { LANDING_DEFAULTS } from '../../config/assist-defaults';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { LandingService } from '../../modules/assist-widget/landing/landing.service';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PIXEL_GIF } from '../../modules/assist-widget/widget-config.service';
import {
  LANDING_ORIGIN,
  domain,
  startWidgetStack,
  widgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';
import { defaultWidgetConfig } from '../../modules/assist-site-setup/widget-config';
import {
  TEST_ASSIST_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';
import { awaitMinuteHeadroom, awaitUtcDayHeadroom } from '../window-headroom';

// Поднятие стенда и HTTP-серии под нагрузкой CI дольше 5 с по умолчанию;
// ожидание запаса до конца окна лимита (../window-headroom) — до 20 с.
jest.setTimeout(60_000);

const LANDING = LANDING_ORIGIN;
/** Свой адрес (IPv6 /64) у каждого вызова: окна лимитов в базе живут между прогонами. */
function freshIp(): string {
  return `${randomV6Prefix()}::1`;
}

describeDb(
  'Лендинг, атрибуция, пинг и картинки (W2, открытые маршруты)',
  () => {
    let stack: WidgetStack;
    const srv = () => stack.app.getHttpServer();

    beforeAll(async () => {
      if (!process.env.W2_DEBUG) Logger.overrideLogger(false);
      stack = await startWidgetStack();
    });
    afterAll(async () => stack?.close());

    function events(
      body: unknown,
      ip = freshIp(),
      origin: string | null = LANDING,
    ) {
      const r = request(srv())
        .post('/public/landing/event')
        .set('X-Forwarded-For', ip);
      if (origin) r.set('Origin', origin);
      return r.send(body as object);
    }

    describe('POST /public/landing/event', () => {
      it('батч пишется под ролью: путь без query, мусорные события отброшены, 204', async () => {
        const tag = `ev_${randomBytes(4).toString('hex')}`;
        await events({
          events: [
            {
              name: tag,
              props: { cta: 'hero', n: 2, ok: true },
              locale: 'uk',
              path: '/pricing?email=a@b.c#x',
            },
            { name: tag, variant: 'b' },
            { name: 'Bad Name!' },
            { name: tag, props: { nested: { a: 1 } } },
            { name: tag, path: 'no-slash' },
          ],
        }).expect(204);
        const rows = await stack.prisma.assistLandingEvent.findMany({
          where: { name: tag },
          orderBy: { variant: 'asc' },
        });
        expect(rows).toHaveLength(2);
        const withPath = rows.find((r) => r.path !== null)!;
        expect(withPath.path).toBe('/pricing');
        expect(withPath.props).toEqual({ cta: 'hero', n: 2, ok: true });
        expect(withPath.ipHash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(rows)).not.toContain('a@b.c');
      });

      it('sendBeacon text/plain — тот же разбор', async () => {
        const tag = `ev_${randomBytes(4).toString('hex')}`;
        await request(srv())
          .post('/public/landing/event')
          .set('Origin', LANDING)
          .set('X-Forwarded-For', freshIp())
          .set('Content-Type', 'text/plain;charset=UTF-8')
          .send(JSON.stringify({ events: [{ name: tag }] }))
          .expect(204);
        expect(
          await stack.prisma.assistLandingEvent.count({ where: { name: tag } }),
        ).toBe(1);
      });

      it('тело > 4 КБ, > 20 событий, пустой батч — 400; чужой origin — 403', async () => {
        const big = { events: [{ name: 'x', props: { a: 'я'.repeat(3000) } }] };
        expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(
          LANDING_DEFAULTS.eventBodyMaxBytes,
        );
        await events(big).expect(400);
        await events({
          events: Array.from(
            { length: LANDING_DEFAULTS.eventsPerBatch + 1 },
            () => ({
              name: 'x',
            }),
          ),
        }).expect(400);
        await events({ events: [] }).expect(400);
        await events({ nope: 1 }).expect(400);
        // Чужой origin по HTTP режет ещё общий CORS (/public/* — список
        // CORS_ORIGIN); фильтр ASSIST_LANDING_ORIGINS сервиса — второй слой.
        await expect(
          stack.app.get(LandingService).recordEvents({
            body: { events: [{ name: 'x' }] },
            ip: freshIp(),
            origin: 'https://evil.example.com',
          }),
        ).rejects.toMatchObject({
          response: { error: 'ORIGIN_DENIED' },
          status: 403,
        });
      });

      it('лимит батчей на ipHash в минуту — RATE_LIMITED', async () => {
        const ip = freshIp();
        // Окно — минута по часам: серия на смене минуты делится между окнами.
        await awaitMinuteHeadroom();
        for (let i = 0; i < LANDING_DEFAULTS.eventBatchesPerMinute; i++) {
          await events({ events: [{ name: 'rl_probe' }] }, ip).expect(204);
        }
        expect(
          (await events({ events: [{ name: 'rl_probe' }] }, ip).expect(429))
            .body.error.code,
        ).toBe('RATE_LIMITED');
      });
    });

    it('GET /public/assist/plans — Э4: живые тарифы той же формы, что снимок лендинга, с кэшем', async () => {
      const r = await request(srv()).get('/public/assist/plans').expect(200);
      const landing = JSON.parse(
        readFileSync(
          join(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'sites-landing',
            'assist-plans.snapshot.json',
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const strip = ({
        source: _s,
        checkedAt: _c,
        note: _n,
        ...rest
      }: Record<string, unknown>) => rest;
      const { dialogWeights, ...live } = strip(r.body.data);
      expect(live).toEqual(strip(landing));
      expect(dialogWeights).toEqual({ text: 1, voice: 2, admin: 3 });
      expect(r.body.data.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.headers['cache-control']).toContain('s-maxage=');
    });

    describe('POST /public/widget-drafts («к Л3»)', () => {
      const cfg = () => {
        const { hosts: _h, ...c } = defaultWidgetConfig('Лендинг');
        return c;
      };
      function draft(config: unknown, ip = freshIp()) {
        return request(srv())
          .post('/public/widget-drafts')
          .set('Origin', LANDING)
          .set('X-Forwarded-For', ip)
          .send({ config });
      }

      it('черновик пишется (id 128 бит, 7 дней), hosts и картинки — отказ, > 2 КБ — отказ', async () => {
        const r = await draft(cfg()).expect(200);
        expect(r.body.data.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        const row = await stack.prisma.assistWidgetDraft.findUniqueOrThrow({
          where: { id: r.body.data.id },
        });
        expect(row.expiresAt.toISOString()).toBe(r.body.data.expiresAt);
        expect((row.config as Record<string, unknown>).hosts).toBeUndefined();
        await draft({
          ...cfg(),
          hosts: [{ hostId: 'h1', enabled: true }],
        }).expect(400);
        await draft({
          ...cfg(),
          brand: { ...cfg().brand, logoAssetId: 'a1' },
        }).expect(400);
        await draft({
          ...cfg(),
          brand: { ...cfg().brand, primaryColor: 'red;background:url(//x)' },
        }).expect(400);
        await draft({
          ...cfg(),
          junk: 'я'.repeat(LANDING_DEFAULTS.widgetDraftMaxBytes),
        }).expect(400);
      });

      it('не больше 10 черновиков в сутки на ipHash', async () => {
        const ip = freshIp();
        // Окно — сутки UTC: серия на полуночи делится между окнами.
        await awaitUtcDayHeadroom(10_000);
        for (let i = 0; i < LANDING_DEFAULTS.widgetDraftsPerIpPerDay; i++) {
          await draft(cfg(), ip).expect(200);
        }
        expect((await draft(cfg(), ip).expect(429)).body.error.code).toBe(
          'RATE_LIMITED',
        );
      });
    });

    describe('POST /assist/acquisition (кабинет)', () => {
      function as(f: { owner: bigint; accountId: string }) {
        return {
          'X-Telegram-App': 'assist',
          'X-Telegram-Init-Data': signInitData({
            botToken: TEST_ASSIST_TOKEN,
            userId: Number(f.owner),
          }),
          'X-Site-Account': f.accountId,
        };
      }

      it('одна запись на кабинет (первый вход), даже при параллельных запусках; utm фильтруются', async () => {
        const f = await widgetFixture(stack, [{ host: domain() }]);
        const rs = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            request(srv())
              .post('/assist/acquisition')
              .set(as(f))
              .send({
                payload: i === 0 ? 'lp_spring' : 'pl_start',
                utm: {
                  utm_source: 'google',
                  utm_campaign: 'x',
                  evil: 'y',
                  utm_long: 'я'.repeat(101),
                },
                landingPath: '/pricing?x=1',
              }),
          ),
        );
        expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
        expect(rs.filter((r) => r.body.data.recorded === true)).toHaveLength(1);
        const rows = await stack.prisma.assistAcquisition.findMany({
          where: { accountId: f.accountId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].utm).toEqual({
          utm_source: 'google',
          utm_campaign: 'x',
        });
        expect(rows[0].landingPath).toBe('/pricing');
        expect(['lp', 'pl']).toContain(rows[0].source);
      });

      it('чужой payload — 400; без initData — 401/403', async () => {
        const f = await widgetFixture(stack, [{ host: domain() }]);
        await request(srv())
          .post('/assist/acquisition')
          .set(as(f))
          .send({ payload: 'xx_hack' })
          .expect(400);
        const r = await request(srv())
          .post('/assist/acquisition')
          .send({ payload: 'lp_spring' });
        expect([401, 403]).toContain(r.status);
      });
    });

    describe('GET /assist/widget-drafts/:id (кабинет, читатель wd_)', () => {
      function as(f: { owner: bigint; accountId: string }) {
        return {
          'X-Telegram-App': 'assist',
          'X-Telegram-Init-Data': signInitData({
            botToken: TEST_ASSIST_TOKEN,
            userId: Number(f.owner),
          }),
          'X-Site-Account': f.accountId,
        };
      }
      async function created(): Promise<string> {
        const { hosts: _h, ...config } = defaultWidgetConfig('Лендинг');
        const r = await request(srv())
          .post('/public/widget-drafts')
          .set('Origin', LANDING)
          .set('X-Forwarded-For', freshIp())
          .send({
            config: {
              ...config,
              brand: { ...config.brand, primaryColor: '#123456' },
            },
          })
          .expect(200);
        return r.body.data.id as string;
      }

      it('существующий черновик — { config } без hosts и картинок; просроченный и неизвестный — 404; без initData — 401/403', async () => {
        const f = await widgetFixture(stack, [{ host: domain() }]);
        const id = await created();
        const r = await request(srv())
          .get(`/assist/widget-drafts/${id}`)
          .set(as(f))
          .expect(200);
        expect(Object.keys(r.body.data)).toEqual(['config']);
        expect(r.body.data.config.brand.primaryColor).toBe('#123456');
        expect(r.body.data.config.brand.logoAssetId).toBeNull();
        expect(r.body.data.config.hosts).toBeUndefined();
        await request(srv())
          .get('/assist/widget-drafts/nope-nope-nope')
          .set(as(f))
          .expect(404);
        await request(srv())
          .get(`/assist/widget-drafts/${encodeURIComponent('../x')}`)
          .set(as(f))
          .expect(404);
        await stack.prisma.assistWidgetDraft.update({
          where: { id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        await request(srv())
          .get(`/assist/widget-drafts/${id}`)
          .set(as(f))
          .expect(404);
        // Старая строка с картинками (до запрета) — ссылки на картинки не уходят.
        const { hosts: _h2, ...cfg } = defaultWidgetConfig('Старый');
        const old = await stack.prisma.assistWidgetDraft.create({
          data: {
            id: `old-${Date.now()}`,
            ipKey: 'x',
            expiresAt: new Date(Date.now() + 60_000),
            config: {
              ...cfg,
              brand: {
                ...cfg.brand,
                logoAssetId: 'asset1',
                avatar: { kind: 'asset', assetId: 'asset2' },
              },
            } as object,
          },
        });
        const o = await request(srv())
          .get(`/assist/widget-drafts/${old.id}`)
          .set(as(f))
          .expect(200);
        expect(o.body.data.config.brand.logoAssetId).toBeNull();
        expect(o.body.data.config.brand.avatar.kind).not.toBe('asset');
        await stack.prisma.assistWidgetDraft.delete({ where: { id: old.id } });
        const anon = await request(srv()).get(`/assist/widget-drafts/${id}`);
        expect([401, 403]).toContain(anon.status);
      });
    });

    describe('пинг загрузчика и картинки бренда', () => {
      it('пинг: GIF всегда; строка — только для хоста сайта (allowed, configFetchOk), счётчик растёт', async () => {
        const d = domain();
        const f = await widgetFixture(stack, [{ host: d }]);
        const ping = (referer: string, c = '1') =>
          request(srv())
            .get(`/widget/v1/ping?pk=${f.pk}&v=1.0.0&c=${c}`)
            .set('Referer', referer)
            .expect(200)
            .expect('Content-Type', 'image/gif');
        const r = await ping(`https://${d}/catalog?x=1`);
        expect(Buffer.from(r.body as Buffer)).toEqual(PIXEL_GIF);
        await ping(`https://${d}/other`, '0');
        await ping(`https://${domain('evil')}/`);
        await request(srv()).get('/widget/v1/ping?pk=nope').expect(200);
        const rows = await stack.prisma.assistSiteInstallPing.findMany({
          where: { siteId: f.siteId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          origin: `https://${d}`,
          allowed: true,
          loaderVersion: '1.0.0',
          configFetchOk: false,
          count: 2,
        });
      });

      it('картинка: байты, mime из колонки, nosniff, CSP default-src none, immutable; не растр — 404', async () => {
        const f = await widgetFixture(stack, [{ host: domain() }]);
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        );
        const sha = createHash('sha256').update(png).digest('hex');
        const a = await stack.prisma.assistSiteAsset.create({
          data: {
            accountId: f.accountId,
            siteId: f.siteId,
            kind: 'logo',
            mime: 'image/png',
            sha256: sha,
            bytes: png,
            width: 1,
            height: 1,
          },
        });
        const r = await request(srv())
          .get(`/widget/v1/asset/${a.id}`)
          .expect(200);
        expect(r.headers['content-type']).toBe('image/png');
        expect(r.headers['x-content-type-options']).toBe('nosniff');
        expect(r.headers['content-security-policy']).toBe("default-src 'none'");
        expect(r.headers['cache-control']).toContain('immutable');
        expect(Buffer.from(r.body as Buffer)).toEqual(png);
        const svg = await stack.prisma.assistSiteAsset.create({
          data: {
            accountId: f.accountId,
            siteId: f.siteId,
            kind: 'logo',
            mime: 'image/svg+xml',
            sha256: 'x',
            bytes: Buffer.from('<svg onload="alert(1)"/>'),
            width: 1,
            height: 1,
          },
        });
        await request(srv()).get(`/widget/v1/asset/${svg.id}`).expect(404);
        await request(srv()).get('/widget/v1/asset/nope').expect(404);
      });
    });
  },
);
