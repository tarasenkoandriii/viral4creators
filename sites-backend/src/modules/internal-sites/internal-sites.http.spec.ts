/**
 * Внутренний API обучалки по HTTP (П-С3): настоящий configureApp (сырое
 * тело на /internal/sites), глобальный гвард Telegram (маршрут открыт
 * через @PublicRoute), гвард HMAC, конверт ошибок. База — поддельная,
 * журнал id запросов — в памяти (на настоящей базе — internal-sites.db.spec.ts).
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
  SITES_HMAC_HEADERS,
  sitesSignatureHeaders,
} from '../../shared/sites-internal-signature';
import { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import { FakeStore } from '../site-core/testing/fake-sites-db.testing';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
} from '../telegram-auth/test-init-data';
import { InternalSitesModule } from './internal-sites.module';
import { InternalRequestLedger } from './request-ledger';
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

class MemoryLedger {
  readonly seen = new Set<string>();
  claim(requestId: string): Promise<boolean> {
    if (this.seen.has(requestId)) return Promise.resolve(false);
    this.seen.add(requestId);
    return Promise.resolve(true);
  }
}

const SECRET = 's'.repeat(48);
const STATUS = '/internal/sites/tutorial/host-status';
const REGISTER = '/internal/sites/tutorial/register-host';
const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
  'SITES_TUTORIAL_HMAC_SECRET',
] as const;

describe('internal-sites по HTTP (П-С3)', () => {
  let app: INestApplication;
  let store: FakeStore;
  let ledger: MemoryLedger;
  let guard: TutorialHmacGuard;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    Logger.overrideLogger(false);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    delete process.env.ALLOW_DEV_AUTH;
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(async () => {
    store = new FakeStore();
    ledger = new MemoryLedger();
    const mod = await Test.createTestingModule({
      imports: [
        FakeDbModule.with(store),
        TelegramAuthModule,
        InternalSitesModule,
      ],
    })
      .overrideProvider(OwnershipChecker)
      .useValue({})
      .overrideProvider(InternalRequestLedger)
      .useValue(ledger)
      .compile();
    guard = mod.get(TutorialHmacGuard);
    guard.env = { SITES_TUTORIAL_HMAC_SECRET: SECRET };
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  function signed(
    path: string,
    body: string,
    o: { secret?: string; at?: number; requestId?: string } = {},
  ) {
    return sitesSignatureHeaders(o.secret ?? SECRET, {
      caller: SITES_CALLER_TUTORIAL,
      method: 'POST',
      path,
      body,
      unixSeconds: o.at ?? Math.floor(Date.now() / 1000),
      requestId: o.requestId ?? randomUUID(),
    });
  }

  function post(path: string, body: string, headers: Record<string, string>) {
    return request(app.getHttpServer())
      .post(path)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(body);
  }

  const body = JSON.stringify({
    telegramId: '4242',
    url: 'https://shop.example.com',
  });

  it('подписанный запрос без initData Telegram — 200, режим B, кабинет не создан', async () => {
    const res = await post(STATUS, body, signed(STATUS, body)).expect(200);
    expect(res.body.data).toMatchObject({
      mode: 'B',
      host: 'shop.example.com',
      reason: 'no_account',
    });
    expect(store.rows('SiteAccount')).toHaveLength(0);
  });

  it('регистрация → кабинет и хост pending; статус после — тот же хост', async () => {
    const res = await post(REGISTER, body, signed(REGISTER, body)).expect(200);
    expect(res.body.data).toMatchObject({ created: true, status: 'pending' });
    const st = await post(STATUS, body, signed(STATUS, body)).expect(200);
    expect(st.body.data.hostId).toBe(res.body.data.hostId);
  });

  it('повтор того же запроса (тот же id) — 401 INTERNAL_REPLAY', async () => {
    const h = signed(STATUS, body);
    await post(STATUS, body, h).expect(200);
    const res = await post(STATUS, body, h).expect(401);
    expect(res.body.error.code).toBe('INTERNAL_REPLAY');
  });

  it('тело подменено по дороге — 401, id в журнал не попал', async () => {
    const h = signed(STATUS, body);
    const evil = body.replace('4242', '1');
    const res = await post(STATUS, evil, h).expect(401);
    expect(res.body.error.code).toBe('INTERNAL_SIGNATURE_MISMATCH');
    expect(ledger.seen.size).toBe(0);
  });

  it('подпись одного маршрута не подходит к другому', async () => {
    const res = await post(REGISTER, body, signed(STATUS, body)).expect(401);
    expect(res.body.error.code).toBe('INTERNAL_SIGNATURE_MISMATCH');
    expect(store.rows('SiteHost')).toHaveLength(0);
  });

  it('метка старше 5 мин — 401 STALE', async () => {
    const at = Math.floor(Date.now() / 1000) - 301;
    const res = await post(STATUS, body, signed(STATUS, body, { at })).expect(
      401,
    );
    expect(res.body.error.code).toBe('INTERNAL_SIGNATURE_STALE');
  });

  it('чужой секрет — 401; без подписи — 401 MISSING', async () => {
    const r1 = await post(
      STATUS,
      body,
      signed(STATUS, body, { secret: 'z'.repeat(48) }),
    ).expect(401);
    expect(r1.body.error.code).toBe('INTERNAL_SIGNATURE_MISMATCH');
    const h = signed(STATUS, body);
    delete (h as Record<string, string>)[SITES_HMAC_HEADERS.signature];
    const r2 = await post(STATUS, body, h).expect(401);
    expect(r2.body.error.code).toBe('INTERNAL_SIGNATURE_MISSING');
  });

  it('секрет не задан у sites-backend — 503 (закрыто, а не открыто)', async () => {
    guard.env = {};
    const res = await post(STATUS, body, signed(STATUS, body)).expect(503);
    expect(res.body.error.code).toBe('INTERNAL_NOT_CONFIGURED');
  });

  it('лишнее поле и не-JSON — 400', async () => {
    const extra = JSON.stringify({
      telegramId: '1',
      url: 'https://a.example.com',
      role: 'owner',
    });
    await post(STATUS, extra, signed(STATUS, extra)).expect(400);
    const junk = 'not json';
    await post(STATUS, junk, signed(STATUS, junk)).expect(400);
  });

  it('telegramId не числовой (dev-пользователь) — 403 ACCOUNT_REQUIRED', async () => {
    const dev = JSON.stringify({
      telegramId: 'dev-1',
      url: 'https://a.example.com',
    });
    const res = await post(STATUS, dev, signed(STATUS, dev)).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_REQUIRED');
  });
});
