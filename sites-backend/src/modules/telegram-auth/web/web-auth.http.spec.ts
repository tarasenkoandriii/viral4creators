/**
 * Веб-кабинет по настоящему HTTP: глобальный гвард, маршруты входа/выхода,
 * конверт и фильтр приложения (configureApp). База сессий — в памяти.
 *
 * Что доказываем (задача Э0-W, п.6): подпись виджета токеном ИМЕННО бота
 * помощника и срок auth_date; сессия отозвана → 401; CSRF-барьеры
 * (чужой Origin, нет X-Telegram-App) → 403; cookie не открывает QA;
 * initData-путь прежний и приоритетнее cookie.
 */

import {
  Controller,
  Get,
  INestApplication,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../../app.setup';
import { WEB_SESSION_COOKIE } from '../../../brand';
import { loadConfiguration } from '../../../config/configuration';
import { AllowApps } from '../allow-apps.decorator';
import type { IdentifiedRequest } from '../identity';
import { TelegramAuthModule } from '../telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../test-init-data';
import { MemoryWebSessionStore, signWidget } from './testing/web-auth.testing';
import {
  WEB_SESSION_ABSOLUTE_MS,
  WEB_SESSION_TTL_MS,
  hashSessionToken,
} from './web-session.service';
import { WebSessionStore } from './web-session.store';

const ORIGIN = 'https://cabinet.example.com';
/**
 * «Чужой» источник, который CORS при этом ПРОПУСКАЕТ (превью `*.vercel.app`
 * в CORS_ORIGIN): именно здесь работает барьер гварда — совсем чужой домен
 * отсекает ещё CORS-мидлвар (отдельный тест ниже).
 */
const EVIL = 'https://evil-preview.vercel.app';
const DAY = 24 * 60 * 60 * 1000;

function who(req: IdentifiedRequest) {
  const { identity } = req;
  return { ...identity, telegramId: identity.telegramId.toString() };
}

@Controller('p')
class ProbeController {
  @Get('assist')
  @AllowApps('assist')
  assist(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Post('assist')
  @AllowApps('assist')
  assistWrite(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Get('qa')
  @AllowApps('qa')
  qa(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Get('any')
  @AllowApps('any')
  any(@Req() req: IdentifiedRequest) {
    return who(req);
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'WEB_CABINET_ORIGINS',
  'ALLOW_DEV_AUTH',
  'NODE_ENV',
] as const;

/** Значение cookie из Set-Cookie ответа (или undefined). */
function setCookieOf(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${WEB_SESSION_COOKIE}=`));
}

function tokenOf(res: request.Response): string {
  const c = setCookieOf(res);
  if (!c) throw new Error('нет Set-Cookie сессии');
  return c.split(';')[0].slice(WEB_SESSION_COOKIE.length + 1);
}

describe('веб-кабинет: вход виджетом Telegram и cookie-сессия (HTTP)', () => {
  let app: INestApplication;
  let store: MemoryWebSessionStore;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    Logger.overrideLogger(false);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(async () => {
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    process.env.WEB_CABINET_ORIGINS = `${ORIGIN}, https://other-cabinet.example.com/`;
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_DEV_AUTH;
    store = new MemoryWebSessionStore();
    const mod = await Test.createTestingModule({
      imports: [TelegramAuthModule],
      controllers: [ProbeController],
    })
      .overrideProvider(WebSessionStore)
      .useValue(store)
      .compile();
    app = mod.createNestApplication();
    configureApp(
      app,
      loadConfiguration({
        CORS_ORIGIN: '*.vercel.app',
        WEB_CABINET_ORIGINS: process.env.WEB_CABINET_ORIGINS,
      } as NodeJS.ProcessEnv),
    );
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const web = { 'X-Telegram-App': 'assist', Origin: ORIGIN };

  function login(body: Record<string, unknown>, headers = web) {
    return request(server())
      .post('/sites/auth/web-login')
      .set(headers)
      .send(body);
  }

  async function loggedIn(id = 777): Promise<string> {
    const res = await login(signWidget({ botToken: TEST_ASSIST_TOKEN, id }));
    expect(res.status).toBe(200);
    return tokenOf(res);
  }

  const cookie = (token: string) => `${WEB_SESSION_COOKIE}=${token}`;

  describe('POST /sites/auth/web-login', () => {
    it('валидная подпись бота помощника → 200, cookie HttpOnly/Secure/Lax/Path=/, токена нет в теле, в базе только хеш', async () => {
      const res = await login(signWidget({ botToken: TEST_ASSIST_TOKEN }));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toEqual({
        telegramId: '777',
        username: 'tester',
        firstName: 'Андрій',
        lastName: null,
        photoUrl: 'https://t.me/i/userpic/320/x.jpg',
      });
      const exp = Date.parse(res.body.data.expiresAt);
      expect(Math.abs(exp - (Date.now() + WEB_SESSION_TTL_MS))).toBeLessThan(
        5000,
      );

      const c = setCookieOf(res)!;
      expect(c).toMatch(/; HttpOnly/);
      expect(c).toMatch(/; Secure/);
      expect(c).toMatch(/; SameSite=Lax/);
      expect(c).toMatch(/; Path=\//);
      expect(c).toMatch(/; Expires=/);
      expect(c).not.toMatch(/Domain=/);

      const token = tokenOf(res);
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].tokenHash).toBe(hashSessionToken(token));
      expect(store.rows[0].tokenHash).not.toContain(token);
      expect(store.rows[0]).toMatchObject({
        telegramId: 777n,
        app: 'assist',
        revokedAt: null,
      });
      expect(store.rows[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('неверный hash → 401 TELEGRAM_LOGIN_INVALID, сессии нет', async () => {
      const body = signWidget({ botToken: TEST_ASSIST_TOKEN });
      body.hash = 'ab'.repeat(32);
      const res = await login(body).expect(401);
      expect(res.body.error.details).toEqual({
        code: 'TELEGRAM_LOGIN_INVALID',
      });
      expect(setCookieOf(res)).toBeUndefined();
      expect(store.rows).toHaveLength(0);
    });

    it('подмена поля после подписи (чужой id) → 401', async () => {
      const body = signWidget({ botToken: TEST_ASSIST_TOKEN });
      body.id = 1;
      await login(body).expect(401);
    });

    it('просроченный auth_date (больше суток) → 401', async () => {
      const old = Math.floor(Date.now() / 1000) - 86400 - 120;
      await login(
        signWidget({ botToken: TEST_ASSIST_TOKEN, authDate: old }),
      ).expect(401);
      // а свежее суток — проходит (граница не «любой возраст запрещён»)
      const fresh = Math.floor(Date.now() / 1000) - 86400 + 120;
      await login(
        signWidget({ botToken: TEST_ASSIST_TOKEN, authDate: fresh }),
      ).expect(200);
    });

    it('подпись бота QA не подходит (перебора токенов нет) → 401', async () => {
      await login(signWidget({ botToken: TEST_QA_TOKEN })).expect(401);
    });

    it('подпись схемой initData (HMAC "WebAppData") вместо схемы виджета не подходит', async () => {
      const init = new URLSearchParams(
        signInitData({ botToken: TEST_ASSIST_TOKEN }),
      );
      await login({
        id: 777,
        auth_date: Number(init.get('auth_date')),
        hash: init.get('hash'),
      }).expect(401);
    });

    it('мусор вместо тела → 401, не 500', async () => {
      await login({ id: { x: 1 }, hash: 'x' }).expect(401);
      await request(server())
        .post('/sites/auth/web-login')
        .set(web)
        .send([1, 2])
        .expect(401);
    });

    it('нет ASSIST_BOT_TOKEN → 503, токен QA не подставляется', async () => {
      delete process.env.ASSIST_BOT_TOKEN;
      const res = await login(signWidget({ botToken: TEST_QA_TOKEN })).expect(
        503,
      );
      expect(res.body.error.details).toEqual({ code: 'BOT_NOT_CONFIGURED' });
    });

    it('чужой Origin → 403 (login-CSRF), без X-Telegram-App → 403, X-Telegram-App: qa → 403', async () => {
      const body = signWidget({ botToken: TEST_ASSIST_TOKEN });
      const evil = await login(body, {
        'X-Telegram-App': 'assist',
        Origin: EVIL,
      }).expect(403);
      expect(evil.body.error.details).toEqual({ code: 'WEB_CSRF_REJECTED' });
      await login(body, { Origin: ORIGIN } as never).expect(403);
      const qa = await login(body, {
        'X-Telegram-App': 'qa',
        Origin: ORIGIN,
      }).expect(403);
      expect(qa.body.error.details).toEqual({ code: 'WEB_APP_MISMATCH' });
      expect(store.rows).toHaveLength(0);
    });

    it('лимит: 11-я попытка за минуту с одного адреса → 429 с retryAfterMs', async () => {
      const bad = { ...signWidget({ botToken: TEST_ASSIST_TOKEN }) };
      bad.hash = '00'.repeat(32);
      for (let i = 0; i < 10; i++) {
        await login(bad).expect(401);
      }
      const res = await login(bad).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res.body.error.details.code).toBe('LOGIN_RATE_LIMITED');
      expect(res.body.error.details.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('гвард: cookie-сессия', () => {
    it('GET без X-Telegram-App → личность того же формата, app=assist', async () => {
      const t = await loggedIn();
      const res = await request(server())
        .get('/p/any')
        .set('Cookie', cookie(t))
        .expect(200);
      expect(res.body.data).toEqual({
        app: 'assist',
        telegramId: '777',
        username: 'tester',
        firstName: 'Андрій',
        languageCode: null,
      });
    });

    it('GET /sites/auth/me — кто вошёл и до когда', async () => {
      const t = await loggedIn();
      const res = await request(server())
        .get('/sites/auth/me')
        .set('Cookie', cookie(t))
        .expect(200);
      expect(res.body.data).toMatchObject({
        telegramId: '777',
        username: 'tester',
        firstName: 'Андрій',
        app: 'assist',
        via: 'web',
      });
      expect(typeof res.body.data.sessionExpiresAt).toBe('string');
    });

    it('@AllowApps("qa") с веб-сессией → 403 (и с X-Telegram-App: assist, и без)', async () => {
      const t = await loggedIn();
      const res = await request(server())
        .get('/p/qa')
        .set('Cookie', cookie(t))
        .expect(403);
      expect(res.body.error.details).toEqual({ code: 'WEB_APP_MISMATCH' });
      await request(server())
        .get('/p/qa')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .expect(403);
    });

    it('cookie + X-Telegram-App: qa → 403 даже на маршруте `any`', async () => {
      const t = await loggedIn();
      await request(server())
        .get('/p/any')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'qa')
        .expect(403);
    });

    it('POST с cookie и правильными заголовками → 200', async () => {
      const t = await loggedIn();
      await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set(web)
        .expect(201);
    });

    it('POST с cookie и чужим Origin → 403', async () => {
      const t = await loggedIn();
      const res = await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .set('Origin', EVIL)
        .expect(403);
      expect(res.body.error.details).toEqual({ code: 'WEB_CSRF_REJECTED' });
    });

    it('совсем чужой домен (не в CORS) — отсекается до гварда, сессия жива', async () => {
      const t = await loggedIn();
      const res = await request(server())
        .post('/sites/auth/logout-all')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .set('Origin', 'https://evil.example');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(store.rows[0].revokedAt).toBeNull();
    });

    it('POST с cookie без X-Telegram-App (простая форма) → 403', async () => {
      const t = await loggedIn();
      await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set('Origin', ORIGIN)
        .expect(403);
    });

    it('POST с cookie без Origin: Referer своего кабинета — 200, чужой — 403, нет обоих — 403', async () => {
      const t = await loggedIn();
      await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .set('Referer', `${ORIGIN}/sites/123?tab=hosts`)
        .expect(201);
      await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .set('Referer', `${EVIL}/x`)
        .expect(403);
      await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .expect(403);
    });

    it('production без WEB_CABINET_ORIGINS: POST по cookie закрыт (барьер не выключается забытой переменной)', async () => {
      const t = await loggedIn();
      process.env.NODE_ENV = 'production';
      delete process.env.WEB_CABINET_ORIGINS;
      await request(server())
        .post('/p/assist')
        .set('Cookie', cookie(t))
        .set(web)
        .expect(403);
      // GET (безопасный) — работает
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .expect(200);
    });

    it('сессия отозвана (logout) → 401 WEB_SESSION_INVALID и cookie стирается', async () => {
      const t = await loggedIn();
      const out = await request(server())
        .post('/sites/auth/logout')
        .set('Cookie', cookie(t))
        .set(web)
        .expect(200);
      expect(setCookieOf(out)).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(store.rows[0].revokedAt).toBeInstanceOf(Date);
      const res = await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .expect(401);
      expect(res.body.error.details).toEqual({ code: 'WEB_SESSION_INVALID' });
      expect(setCookieOf(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('logout с чужого Origin → 403, сессия жива', async () => {
      const t = await loggedIn();
      await request(server())
        .post('/sites/auth/logout')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .set('Origin', EVIL)
        .expect(403);
      expect(store.rows[0].revokedAt).toBeNull();
    });

    it('logout с мёртвой cookie — 200 (выйти можно всегда)', async () => {
      await request(server())
        .post('/sites/auth/logout')
        .set('Cookie', cookie('x'.repeat(43)))
        .set(web)
        .expect(200);
    });

    it('истёкшая сессия → 401; неизвестный/мусорный токен → 401', async () => {
      const t = await loggedIn();
      store.rows[0].expiresAt = new Date(Date.now() - 1000);
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .expect(401);
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie('A'.repeat(43)))
        .expect(401);
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie('garbage%20token'))
        .expect(401);
    });

    it('logout-all: отзывает все сессии этого человека, чужие — нет', async () => {
      const a1 = await loggedIn(777);
      const a2 = await loggedIn(777);
      const b = await loggedIn(888);
      const res = await request(server())
        .post('/sites/auth/logout-all')
        .set('Cookie', cookie(a1))
        .set(web)
        .expect(200);
      expect(res.body.data).toEqual({ ok: true, revoked: 2 });
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(a2))
        .expect(401);
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(b))
        .expect(200);
    });

    it('logout-all без X-Telegram-App → 403 (CSRF)', async () => {
      const t = await loggedIn();
      await request(server())
        .post('/sites/auth/logout-all')
        .set('Cookie', cookie(t))
        .set('Origin', ORIGIN)
        .expect(403);
      expect(store.rows[0].revokedAt).toBeNull();
    });

    it('скользящее продление: не чаще раза в сутки, с потолком 30 дней от входа', async () => {
      const t = await loggedIn();
      const row = store.rows[0];
      // Свежая сессия — продлевать незачем: ни записи, ни Set-Cookie.
      const before = row.expiresAt.getTime();
      const r0 = await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .expect(200);
      expect(setCookieOf(r0)).toBeUndefined();
      expect(row.expiresAt.getTime()).toBe(before);

      // Прошло 2 суток → продлили до «сейчас + 7 дней», cookie переставлена.
      row.createdAt = new Date(Date.now() - 2 * DAY);
      row.expiresAt = new Date(Date.now() + 5 * DAY);
      const r1 = await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .expect(200);
      expect(setCookieOf(r1)).toMatch(
        new RegExp(`^${WEB_SESSION_COOKIE}=${t};`),
      );
      expect(
        Math.abs(row.expiresAt.getTime() - (Date.now() + WEB_SESSION_TTL_MS)),
      ).toBeLessThan(5000);

      // Около потолка: продление не выходит за createdAt + 30 дней.
      row.createdAt = new Date(Date.now() - 27 * DAY);
      row.expiresAt = new Date(Date.now() + 1 * DAY);
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .expect(200);
      expect(row.expiresAt.getTime()).toBe(
        row.createdAt.getTime() + WEB_SESSION_ABSOLUTE_MS,
      );
    });
  });

  describe('initData-путь не сломан и приоритетнее cookie', () => {
    it('initData без cookie — как раньше', async () => {
      const res = await request(server())
        .get('/p/qa')
        .set('X-Telegram-App', 'qa')
        .set(
          'X-Telegram-Init-Data',
          signInitData({ botToken: TEST_QA_TOKEN, userId: 888 }),
        )
        .expect(200);
      expect(res.body.data).toMatchObject({ app: 'qa', telegramId: '888' });
    });

    it('initData QA + живая cookie помощника → решает initData (QA-маршрут открыт как qa)', async () => {
      const t = await loggedIn(777);
      const res = await request(server())
        .get('/p/qa')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'qa')
        .set(
          'X-Telegram-Init-Data',
          signInitData({ botToken: TEST_QA_TOKEN, userId: 888 }),
        )
        .expect(200);
      expect(res.body.data).toMatchObject({ app: 'qa', telegramId: '888' });
    });

    it('плохая initData + живая cookie → 401: cookie не «спасает» неверную подпись', async () => {
      const t = await loggedIn(777);
      const init = new URLSearchParams(
        signInitData({ botToken: TEST_ASSIST_TOKEN }),
      );
      init.set('hash', 'ab'.repeat(32));
      await request(server())
        .get('/p/assist')
        .set('Cookie', cookie(t))
        .set('X-Telegram-App', 'assist')
        .set('X-Telegram-Init-Data', init.toString())
        .expect(401);
    });

    it('/sites/auth/me по initData помощника → via=telegram', async () => {
      const res = await request(server())
        .get('/sites/auth/me')
        .set('X-Telegram-App', 'assist')
        .set(
          'X-Telegram-Init-Data',
          signInitData({ botToken: TEST_ASSIST_TOKEN }),
        )
        .expect(200);
      expect(res.body.data).toMatchObject({
        via: 'telegram',
        sessionExpiresAt: null,
      });
    });

    it('без initData и без cookie — прежний 401', async () => {
      await request(server())
        .get('/p/assist')
        .set('X-Telegram-App', 'assist')
        .expect(401);
    });
  });

  describe('dev-вход веб-кабинета', () => {
    it('без ALLOW_DEV_AUTH — 404', async () => {
      await request(server())
        .post('/sites/auth/web-dev-login')
        .set(web)
        .send({ devUserId: '123' })
        .expect(404);
    });

    it('ALLOW_DEV_AUTH=true вне production — сессия, cookie без Secure', async () => {
      process.env.ALLOW_DEV_AUTH = 'true';
      const res = await request(server())
        .post('/sites/auth/web-dev-login')
        .set(web)
        .send({ devUserId: '123' })
        .expect(200);
      expect(setCookieOf(res)).not.toMatch(/Secure/);
      const me = await request(server())
        .get('/sites/auth/me')
        .set('Cookie', cookie(tokenOf(res)))
        .expect(200);
      expect(me.body.data.telegramId).toBe('123');
    });

    it('ALLOW_DEV_AUTH=true в production — 404', async () => {
      process.env.ALLOW_DEV_AUTH = 'true';
      process.env.NODE_ENV = 'production';
      await request(server())
        .post('/sites/auth/web-dev-login')
        .set(web)
        .send({})
        .expect(404);
    });
  });
});
