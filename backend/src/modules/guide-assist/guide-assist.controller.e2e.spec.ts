/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
/**
 * Контракт маршрутов Ш6 по HTTP: настоящий Nest, настоящий сервис и
 * гвард коннектора, Prisma — двойник. Проверяется то, чего не видит
 * модульный тест: гварды на месте, конверт у TMA-маршрутов и его ОТСУТСТВИЕ
 * у маршрутов коннектора, коды отказов.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import {
  GUIDE_ASSIST_DISABLED,
  GUIDE_FACTS_RATE_LIMIT,
  GuideAssistController,
  GuideFactsController,
} from './guide-assist.controller';
import { GuideAssistService } from './guide-assist.service';
import { GuideConnectorGuard } from './guide-connector.guard';
import { actorOf } from './guide-assist-jwt';
import type { GuideAssistEnv } from './guide-assist-config';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../../common/rate-limit';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';

const SECRET = 'j'.repeat(40);
const KEY = 'k'.repeat(40);
let env: GuideAssistEnv = {};

class EnvService extends GuideAssistService {
  protected env(): GuideAssistEnv {
    return env;
  }
}

const prisma = {
  user: {
    findUnique: jest.fn(async ({ where }: any) =>
      ['u1', 'u2'].includes(where.id)
        ? { id: where.id, telegramId: '1' }
        : null,
    ),
  },
  project: {
    findFirst: jest.fn(
      async ({ where }: any) =>
        [{ id: 'p1', userId: 'u1', deletedAt: null, type: 'SINGLE' }]
          .filter((r: any) =>
            Object.entries(where).every(([k, v]) => r[k] === v),
          )
          .map((r) => ({ type: r.type }))[0] ?? null,
    ),
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  },
  session: { findFirst: jest.fn(async () => null) },
  clientSiteTutorialDraft: { findUnique: jest.fn(async () => null) },
};
const plan = { planOfUser: jest.fn(async () => 'LITE') };
/** Чей id видел гвард лимита (ключ окна `by: 'user'`). */
const limited: Array<string | undefined> = [];

async function boot(): Promise<INestApplication> {
  const svc = new EnvService(prisma as any, plan as any);
  const moduleRef = await Test.createTestingModule({
    controllers: [GuideAssistController, GuideFactsController],
    providers: [
      { provide: GuideAssistService, useValue: svc },
      GuideConnectorGuard,
    ],
  })
    .overrideGuard(TelegramIdentityGuard)
    .useValue({
      canActivate: (ctx: any) =>
        !!ctx.switchToHttp().getRequest().telegramUserId,
    })
    .overrideGuard(RateLimitGuard)
    .useValue({
      canActivate: (ctx: any) => {
        limited.push(ctx.switchToHttp().getRequest().telegramUserId);
        return true;
      },
    })
    .compile();
  const app = moduleRef.createNestApplication();
  // Вместо TelegramIdentityMiddleware: личность — из тестового заголовка.
  app.use((req: any, _res: any, next: () => void) => {
    const u = req.headers['x-test-user'];
    if (typeof u === 'string') req.telegramUserId = u;
    next();
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

const ON: GuideAssistEnv = {
  WIZARD_GUIDE_ENGINE: 'assist',
  WIZARD_GUIDE_ASSIST_SITE_ID: 'site_v4c',
  WIZARD_GUIDE_ASSIST_PK: 'pk_live_v4c',
  WIZARD_GUIDE_ASSIST_ORIGIN: 'https://assist-wa.viral4creators.app',
  WIZARD_GUIDE_ASSIST_JWT_SECRET: SECRET,
  WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: KEY,
};

describe('Ш6 — маршруты гида «Админка» (e2e)', () => {
  let app: INestApplication;
  const prevApi = process.env.API_PUBLIC_URL;
  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    process.env.API_PUBLIC_URL = prevApi;
    await app.close();
  });
  beforeEach(() => {
    env = { ...ON };
    jest.clearAllMocks();
  });

  it('config: аноним — legacy в конверте, без 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/guide-assist/config')
      .expect(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { engine: 'legacy' },
    });
  });

  it('config: вошедший при assist — pk и origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/guide-assist/config')
      .set('x-test-user', 'u1')
      .expect(200);
    expect(res.body.data).toEqual({
      engine: 'assist',
      pk: 'pk_live_v4c',
      origin: 'https://assist-wa.viral4creators.app',
    });
  });

  it('identity: без входа — отказ гварда; флаг выключен — 404 с кодом', async () => {
    await request(app.getHttpServer())
      .post('/api/guide-assist/identity')
      .expect(403);
    env = {};
    const res = await request(app.getHttpServer())
      .post('/api/guide-assist/identity')
      .set('x-test-user', 'u1')
      .expect(404);
    expect(JSON.stringify(res.body)).toContain(GUIDE_ASSIST_DISABLED);
  });

  it('identity: JWT в конверте, no-store', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/guide-assist/identity')
      .set('x-test-user', 'u1')
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.jwt.split('.')).toHaveLength(3);
    expect(typeof res.body.data.exp).toBe('number');
  });

  const actor = () => actorOf('u1', SECRET);

  it('факты: без ключа коннектора / чужой ключ — 401 с WWW-Authenticate (Н-3)', async () => {
    const s = request(app.getHttpServer());
    const none = await s.get('/api/guide-assist/v1/projects').expect(401);
    expect(none.headers['www-authenticate']).toBe(
      'Bearer error="invalid_token"',
    );
    const wrong = await s
      .get('/api/guide-assist/v1/projects')
      .set('authorization', `Bearer ${'x'.repeat(40)}`)
      .set('x-v4c-actor', actor())
      .expect(401);
    expect(wrong.headers['www-authenticate']).toBe(
      'Bearer error="invalid_token"',
    );
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('факты: верный ключ, плохой актор — 403 ACTOR_INVALID, не 401 (Н-3)', async () => {
    const s = request(app.getHttpServer());
    const bad: Array<string | undefined> = [
      undefined, // нет заголовка
      'u1', // не псевдоним
      actorOf('u1', 'z'.repeat(40)), // чужая подпись
      ((t) => t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))(actor()), // испорченная подпись
      actorOf('ghost', SECRET), // подпись наша, пользователя нет
    ];
    for (const a of bad) {
      let r = s
        .get('/api/guide-assist/v1/projects')
        .set('authorization', `Bearer ${KEY}`);
      if (a !== undefined) r = r.set('x-v4c-actor', a);
      const res = await r.expect(403);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.body.error.code).toBe('ACTOR_INVALID');
      expect(res.body.error.details).toEqual({ code: 'ACTOR_INVALID' });
    }
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('факты: API выключен — 404 даже с верным ключом', async () => {
    env = { ...ON, WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: '' };
    await request(app.getHttpServer())
      .get('/api/guide-assist/v1/projects')
      .set('authorization', `Bearer ${KEY}`)
      .set('x-v4c-actor', actor())
      .expect(404);
  });

  it('факты: сырой JSON без конверта; чужой проект — 404', async () => {
    const s = request(app.getHttpServer());
    const ok = await s
      .get('/api/guide-assist/v1/projects/p1/facts')
      .set('authorization', `Bearer ${KEY}`)
      .set('x-v4c-actor', actor())
      .expect(200);
    expect(ok.body.success).toBeUndefined();
    expect(ok.body).toMatchObject({
      projectId: 'p1',
      scenario: 'PRODUCT_VIDEO',
    });
    expect(ok.body.facts).toContain('прогон ещё не начат');
    await s
      .get('/api/guide-assist/v1/projects/p1/facts')
      .set('authorization', `Bearer ${KEY}`)
      .set('x-v4c-actor', actorOf('u2', SECRET))
      .expect(404);
  });

  it('факты: лимит частоты — окно на человека из X-V4C-Actor, не на адрес платформы', async () => {
    limited.length = 0;
    await request(app.getHttpServer())
      .get('/api/guide-assist/v1/projects')
      .set('authorization', `Bearer ${KEY}`)
      .set('x-v4c-actor', actorOf('u2', SECRET))
      .expect(200);
    expect(limited).toEqual(['u2']);
    for (const h of ['projects', 'facts', 'account'] as const) {
      const rules = Reflect.getMetadata(
        RATE_LIMIT_KEY,
        GuideFactsController.prototype[h],
      );
      expect(rules).toBe(GUIDE_FACTS_RATE_LIMIT);
    }
    expect(GUIDE_FACTS_RATE_LIMIT).toContainEqual(
      expect.objectContaining({ by: 'user' }),
    );
  });

  it('сводка аккаунта — тариф этого человека', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/guide-assist/v1/account')
      .set('authorization', `Bearer ${KEY}`)
      .set('x-v4c-actor', actor())
      .expect(200);
    expect(res.body).toEqual({ plan: 'LITE', projects: 0 });
  });

  it('openapi.json — без ключа виден, но только при включённом API и API_PUBLIC_URL', async () => {
    process.env.API_PUBLIC_URL = 'https://api.example.app/api';
    const res = await request(app.getHttpServer())
      .get('/api/guide-assist/v1/openapi.json')
      .expect(200);
    expect(res.body.servers[0].url).toBe(
      'https://api.example.app/api/guide-assist/v1',
    );
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    env = {};
    await request(app.getHttpServer())
      .get('/api/guide-assist/v1/openapi.json')
      .expect(404);
  });

  it('knowledge.md — markdown с ETag, повтор — 304', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/guide-assist/v1/knowledge.md')
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.text).toMatch(/^# Мастер Viral4Creators/);
    await request(app.getHttpServer())
      .get('/api/guide-assist/v1/knowledge.md')
      .set('if-none-match', res.headers.etag)
      .expect(304);
  });

  it('knowledge.md — 404, пока не задан ключ коннектора (при любом флаге); с ключом — и при legacy', async () => {
    for (const e of [
      {},
      { WIZARD_GUIDE_ENGINE: 'legacy' },
      { ...ON, WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: '' },
      { ...ON, WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: '   ' },
    ]) {
      env = e;
      const res = await request(app.getHttpServer())
        .get('/api/guide-assist/v1/knowledge.md')
        .expect(404);
      expect(res.text).not.toMatch(/Мастер Viral4Creators/);
      // ETag прежнего ответа не превращает 404 в 304.
      await request(app.getHttpServer())
        .get('/api/guide-assist/v1/knowledge.md')
        .set('if-none-match', '"x"')
        .expect(404);
    }
    env = {
      WIZARD_GUIDE_ENGINE: 'legacy',
      WIZARD_GUIDE_ASSIST_JWT_SECRET: SECRET,
      WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: KEY,
    };
    const ok = await request(app.getHttpServer())
      .get('/api/guide-assist/v1/knowledge.md')
      .expect(200);
    expect(ok.text).toMatch(/^# Мастер Viral4Creators/);
  });
});
