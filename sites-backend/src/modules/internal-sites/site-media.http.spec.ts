/**
 * Внутренний API Э6 (ролики, привязка, карта) по HTTP: настоящий
 * configureApp (сырое тело ≤ 8 КБ на /internal/sites), глобальный гвард
 * Telegram (маршрут открыт @PublicRoute), тот же гвард HMAC Ш1, строгий
 * разбор тела. Логика сервиса — на реальной базе (acceptance/e6/media.spec.ts).
 */
import {
  DynamicModule,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  SITES_CALLER_TUTORIAL,
  sitesSignatureHeaders,
} from '../../shared/sites-internal-signature';
import { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import { FakeStore } from '../site-core/testing/fake-sites-db.testing';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
} from '../telegram-auth/test-init-data';
import { InternalRequestLedger } from './request-ledger';
import { InternalSiteMediaModule } from './site-media.module';
import { InternalSiteMediaService } from './site-media.service';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({})
class FakeDbModule {
  static with(store: FakeStore): DynamicModule {
    return {
      module: FakeDbModule,
      global: true,
      providers: [{ provide: SitesDb, useValue: store.sitesDb() }],
      exports: [SitesDb],
    };
  }
}

const SECRET = 's'.repeat(48);
const LINK = '/internal/sites/tutorial/site-link';
const VIDEOS = '/internal/sites/tutorial/site-videos';
const MAP = '/internal/sites/tutorial/ui-map';

const video = (over: Record<string, unknown> = {}) => ({
  externalId: 'asset1',
  draftId: 'draft1',
  ownerTelegramId: '4242',
  title: 'Как оформить заказ',
  locale: 'ru',
  durationMs: 30000,
  url: 'https://a.public.blob.vercel-storage.com/v.mp4',
  requiresLogin: false,
  stepHosts: ['shop.example.com'],
  ...over,
});

describe('internal-sites Э6 по HTTP (ролики, привязка, карта)', () => {
  let app: INestApplication;
  const calls: Array<[string, unknown[]]> = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    Logger.overrideLogger(false);
    for (const k of ['ASSIST_BOT_TOKEN', 'QA_BOT_TOKEN', 'ALLOW_DEV_AUTH'])
      saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    delete process.env.ALLOW_DEV_AUTH;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    calls.length = 0;
    const seen = new Set<string>();
    const fake = {
      link: (...a: unknown[]) => (calls.push(['link', a]), { siteId: a[1] }),
      syncVideos: (...a: unknown[]) => (
        calls.push(['syncVideos', a]),
        { siteId: a[0], accepted: 1, removed: 0, rejected: [] }
      ),
      uiMap: (...a: unknown[]) => (
        calls.push(['uiMap', a]),
        { siteId: a[1], path: '/', elements: 1 }
      ),
    };
    const mod = await Test.createTestingModule({
      imports: [
        FakeDbModule.with(new FakeStore()),
        TelegramAuthModule,
        InternalSiteMediaModule,
      ],
    })
      .overrideProvider(OwnershipChecker)
      .useValue({})
      .overrideProvider(InternalSiteMediaService)
      .useValue(fake)
      .overrideProvider(InternalRequestLedger)
      .useValue({
        claim: (id: string) => {
          if (seen.has(id)) return Promise.resolve(false);
          seen.add(id);
          return Promise.resolve(true);
        },
      })
      .compile();
    mod.get(TutorialHmacGuard).env = { SITES_TUTORIAL_HMAC_SECRET: SECRET };
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  function post(path: string, body: string, sign = true) {
    const h = sign
      ? sitesSignatureHeaders(SECRET, {
          caller: SITES_CALLER_TUTORIAL,
          method: 'POST',
          path,
          body,
          unixSeconds: Math.floor(Date.now() / 1000),
          requestId: randomUUID(),
        })
      : {};
    return request(app.getHttpServer())
      .post(path)
      .set('Content-Type', 'application/json')
      .set(h)
      .send(body);
  }

  it('без подписи — 401, сервис не зовётся (все три маршрута)', async () => {
    for (const p of [LINK, VIDEOS, MAP]) {
      const r = await post(p, '{}', false).expect(401);
      expect(r.body.error.code).toBe('INTERNAL_SIGNATURE_MISSING');
    }
    expect(calls).toEqual([]);
  });

  it('привязка: telegramId → bigint, siteId — id', async () => {
    const b = JSON.stringify({ telegramId: '4242', siteId: 'site_1' });
    await post(LINK, b).expect(200);
    expect(calls).toEqual([['link', [BigInt(4242), 'site_1']]]);
    const bad = JSON.stringify({ telegramId: '4242', siteId: '../x' });
    await post(LINK, bad).expect(400);
    const extra = JSON.stringify({ telegramId: '1', siteId: 's', role: 'x' });
    await post(LINK, extra).expect(400);
  });

  it('ролики: строгий разбор каждого (поля, типы, хосты шагов, дубли id)', async () => {
    const ok = JSON.stringify({
      siteId: 'site_1',
      asOf: 1_790_000_000_123,
      videos: [video()],
    });
    await post(VIDEOS, ok).expect(200);
    expect(calls[0][0]).toBe('syncVideos');
    expect(calls[0][1][2]).toBe(1_790_000_000_123);
    expect(
      (calls[0][1][1] as Array<{ ownerTelegramId: bigint }>)[0].ownerTelegramId,
    ).toBe(BigInt(4242));
    for (const v of [
      video({ extra: 1 }),
      video({ requiresLogin: 'no' }),
      video({ stepHosts: ['evil host'] }),
      video({ durationMs: -1 }),
      video({ locale: 'русский' }),
      video({ ownerTelegramId: 'dev-1' }),
    ]) {
      const b = JSON.stringify({ siteId: 'site_1', asOf: 1, videos: [v] });
      const r = await post(VIDEOS, b);
      expect([400, 403]).toContain(r.status);
    }
    const dup = JSON.stringify({
      siteId: 's',
      asOf: 1,
      videos: [video(), video()],
    });
    await post(VIDEOS, dup).expect(400);
    // Аудит Э6 (гонка): отметка набора обязательна — целое мс > 0.
    for (const asOf of [undefined, '1', 0, -5, 1.5, 2 ** 60]) {
      const b = JSON.stringify({ siteId: 's', asOf, videos: [video()] });
      await post(VIDEOS, b).expect(400);
    }
    // 16 правильных роликов (тело < 8 КБ) — отказ именно по потолку.
    const many = JSON.stringify({
      siteId: 's',
      asOf: 1,
      videos: Array.from({ length: 16 }, (_, i) =>
        video({ externalId: `a${i}`, title: 'T', stepHosts: [] }),
      ),
    });
    expect(Buffer.byteLength(many)).toBeLessThan(8 * 1024);
    await post(VIDEOS, many).expect(400);
    expect(calls).toHaveLength(1);
  });

  it('тело больше 8 КБ — отказ до сервиса', async () => {
    const big = JSON.stringify({
      telegramId: '1',
      siteId: 's',
      url: 'https://shop.example.com/',
      elements: Array.from({ length: 90 }, (_, i) => ({
        selector: `#b${i}${'x'.repeat(80)}`,
        tag: 'button',
        label: 'Кнопка'.repeat(5),
      })),
    });
    expect(Buffer.byteLength(big)).toBeGreaterThan(8 * 1024);
    const r = await post(MAP, big);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it('карта: url и массив элементов — дальше чистит сервис', async () => {
    const b = JSON.stringify({
      telegramId: '4242',
      siteId: 'site_1',
      url: 'https://shop.example.com/cart',
      elements: [{ selector: '#buy', tag: 'button', label: 'Купить' }],
    });
    await post(MAP, b).expect(200);
    expect(calls[0][0]).toBe('uiMap');
    const bad = JSON.stringify({
      telegramId: '1',
      siteId: 's',
      url: 5,
      elements: [],
    });
    await post(MAP, bad).expect(400);
  });
});
