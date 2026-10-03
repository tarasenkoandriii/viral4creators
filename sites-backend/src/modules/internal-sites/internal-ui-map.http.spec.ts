/**
 * Э-С Ш4: внутренний API карты интерфейса по HTTP — Flow-QA (`qa/ui-map`)
 * со СВОИМ секретом и вызывающим (`QaHmacGuard`), потолок тела 64 КБ, и
 * вид вёрстки в маршруте обучалки `tutorial/ui-map`. Логика сервиса — на
 * реальной базе (acceptance/sh4/ui-map.spec.ts).
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
import { InternalUiMapService } from './internal-ui-map.service';
import { QaHmacGuard, SITES_CALLER_QA } from './qa-hmac.guard';
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

const QA_SECRET = 'q'.repeat(48);
const TUTORIAL_SECRET = 's'.repeat(48);
const READ = '/internal/sites/qa/ui-map/read';
const WRITE = '/internal/sites/qa/ui-map/write';
const TUTORIAL_MAP = '/internal/sites/tutorial/ui-map';

describe('internal-sites Ш4 по HTTP (карта интерфейса для Flow-QA)', () => {
  let app: INestApplication;
  let qaGuard: QaHmacGuard;
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
      .useValue({
        uiMap: (...a: unknown[]) => (
          calls.push(['tutorialUiMap', a]),
          { siteId: a[1], path: '/', elements: 1 }
        ),
      })
      .overrideProvider(InternalUiMapService)
      .useValue({
        read: (...a: unknown[]) => (calls.push(['read', a]), { ok: 1 }),
        write: (...a: unknown[]) => (calls.push(['write', a]), { ok: 1 }),
      })
      .overrideProvider(InternalRequestLedger)
      .useValue({
        claim: (id: string) => {
          if (seen.has(id)) return Promise.resolve(false);
          seen.add(id);
          return Promise.resolve(true);
        },
      })
      .compile();
    qaGuard = mod.get(QaHmacGuard);
    qaGuard.env = { SITES_QA_HMAC_SECRET: QA_SECRET };
    mod.get(TutorialHmacGuard).env = {
      SITES_TUTORIAL_HMAC_SECRET: TUTORIAL_SECRET,
    };
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  function post(
    path: string,
    body: string,
    signer: { secret: string; caller: string } | null = {
      secret: QA_SECRET,
      caller: SITES_CALLER_QA,
    },
  ) {
    const h = signer
      ? sitesSignatureHeaders(signer.secret, {
          caller: signer.caller,
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

  const readBody = JSON.stringify({ telegramId: '4242', siteId: 'site_1' });

  it('подпись QA — свой секрет и свой вызывающий: подпись обучалки (её секрет или вызывающий) не принимается', async () => {
    await post(READ, readBody).expect(200);
    const foreignSecret = await post(READ, readBody, {
      secret: TUTORIAL_SECRET,
      caller: SITES_CALLER_QA,
    }).expect(401);
    expect(foreignSecret.body.error.code).toBe('INTERNAL_SIGNATURE_MISMATCH');
    const foreignCaller = await post(READ, readBody, {
      secret: QA_SECRET,
      caller: SITES_CALLER_TUTORIAL,
    }).expect(401);
    expect(foreignCaller.body.error.code).toBe('INTERNAL_SIGNATURE_CALLER');
    const none = await post(READ, readBody, null).expect(401);
    expect(none.body.error.code).toBe('INTERNAL_SIGNATURE_MISSING');
    // И наоборот: подпись QA маршрут обучалки не открывает.
    const b = JSON.stringify({
      telegramId: '1',
      siteId: 's',
      url: 'https://shop.example.com/',
      elements: [],
    });
    await post(TUTORIAL_MAP, b).expect(401);
    expect(calls.map((c) => c[0])).toEqual(['read']);
  });

  it('без секрета QA — 503 (закрыто, а не открыто)', async () => {
    qaGuard.env = {};
    const r = await post(READ, readBody).expect(503);
    expect(r.body.error.code).toBe('INTERNAL_NOT_CONFIGURED');
    expect(calls).toEqual([]);
  });

  it('аудит Ш4: секрет QA совпал с секретом обучалки — 503 (направления не разделены)', async () => {
    qaGuard.env = {
      SITES_QA_HMAC_SECRET: QA_SECRET,
      SITES_TUTORIAL_HMAC_SECRET: ` ${QA_SECRET} `,
    };
    const r = await post(READ, readBody).expect(503);
    expect(r.body.error.code).toBe('INTERNAL_NOT_CONFIGURED');
    qaGuard.env = {
      SITES_QA_HMAC_SECRET: QA_SECRET,
      SITES_TUTORIAL_HMAC_SECRET: TUTORIAL_SECRET,
    };
    await post(READ, readBody).expect(200);
    expect(calls.map((c) => c[0])).toEqual(['read']);
  });

  it('чтение: url и вид по желанию; строгий разбор', async () => {
    await post(
      READ,
      JSON.stringify({
        telegramId: '4242',
        siteId: 'site_1',
        url: 'https://shop.example.com/cart',
        viewport: 'mobile',
      }),
    ).expect(200);
    expect(calls[0]).toEqual([
      'read',
      [BigInt(4242), 'site_1', 'https://shop.example.com/cart', 'mobile'],
    ]);
    for (const bad of [
      { telegramId: '1', siteId: '../x' },
      { telegramId: '1', siteId: 's', viewport: 'tablet' },
      { telegramId: '1', siteId: 's', url: 5 },
      { telegramId: '1', siteId: 's', extra: true },
    ]) {
      await post(READ, JSON.stringify(bad)).expect(400);
    }
    expect(calls).toHaveLength(1);
  });

  it('запись: вид обязателен, ≤ 100 элементов; тело больше 8 КБ (до 64 КБ) — принимается', async () => {
    const elements = Array.from({ length: 60 }, (_, i) => ({
      tag: 'button',
      label: `Кнопка ${i} з довгою підписом`,
      selector: `#b${i}`,
      candidates: [
        { kind: 'test-id', selector: `button[data-testid="buy-${i}-long"]` },
        { kind: 'role-name', role: 'button', name: `Кнопка ${i}` },
        { kind: 'css', selector: `main > div:nth-of-type(${i + 1}) > button` },
      ],
    }));
    const big = JSON.stringify({
      telegramId: '4242',
      siteId: 'site_1',
      url: 'https://shop.example.com/',
      viewport: 'desktop',
      elements,
    });
    expect(Buffer.byteLength(big)).toBeGreaterThan(8 * 1024);
    expect(Buffer.byteLength(big)).toBeLessThan(64 * 1024);
    await post(WRITE, big).expect(200);
    expect(calls[0][0]).toBe('write');
    expect(calls[0][1].slice(0, 4)).toEqual([
      BigInt(4242),
      'site_1',
      'https://shop.example.com/',
      'desktop',
    ]);
    const base = {
      telegramId: '1',
      siteId: 's',
      url: 'https://shop.example.com/',
    };
    for (const bad of [
      { ...base, elements: [] },
      { ...base, viewport: 'tv', elements: [] },
      { ...base, viewport: 'any', elements: 'x' },
      {
        ...base,
        viewport: 'any',
        elements: Array.from({ length: 101 }, () => ({})),
      },
    ]) {
      await post(WRITE, JSON.stringify(bad)).expect(400);
    }
    // Больше 64 КБ — отказ до сервиса.
    const huge = JSON.stringify({
      ...base,
      viewport: 'any',
      elements: Array.from({ length: 100 }, () => ({
        tag: 'a',
        label: 'x'.repeat(700),
      })),
    });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(64 * 1024);
    const r = await post(WRITE, huge);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(1);
  });

  it('маршрут обучалки: вид вёрстки — по желанию и из перечня', async () => {
    const tutorial = { secret: TUTORIAL_SECRET, caller: SITES_CALLER_TUTORIAL };
    const body = (viewport?: unknown) =>
      JSON.stringify({
        telegramId: '4242',
        siteId: 'site_1',
        url: 'https://shop.example.com/cart',
        elements: [{ selector: '#buy', tag: 'button', label: 'Купить' }],
        ...(viewport === undefined ? {} : { viewport }),
      });
    await post(TUTORIAL_MAP, body(), tutorial).expect(200);
    await post(TUTORIAL_MAP, body('desktop'), tutorial).expect(200);
    await post(TUTORIAL_MAP, body('tablet'), tutorial).expect(400);
    expect(calls.map((c) => c[1][5])).toEqual([undefined, 'desktop']);
  });

  it('аудит Ш4: потолок 64 КБ — только на пути QA; обучалка и QA-путь в другом регистре — 8 КБ', async () => {
    const tutorial = { secret: TUTORIAL_SECRET, caller: SITES_CALLER_TUTORIAL };
    const elements = Array.from({ length: 60 }, (_, i) => ({
      tag: 'button',
      label: `Кнопка ${i} з довгою підписом для перевірки`,
      selector: `main > div:nth-of-type(${i + 1}) > button`,
    }));
    const body = (viewport: string) =>
      JSON.stringify({
        telegramId: '4242',
        siteId: 'site_1',
        url: 'https://shop.example.com/cart',
        viewport,
        elements,
      });
    expect(Buffer.byteLength(body('any'))).toBeGreaterThan(8 * 1024);
    const r1 = await post(TUTORIAL_MAP, body('any'), tutorial);
    expect([400, 413]).toContain(r1.status);
    const r2 = await post('/internal/sites/QA/ui-map/write', body('any'));
    expect([400, 413]).toContain(r2.status);
    expect(calls).toEqual([]);
    await post(WRITE, body('any')).expect(200);
  });
});
