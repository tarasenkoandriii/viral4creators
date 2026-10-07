/**
 * Ш5 (11): общий лимит по IP на `/assist/v1/sites/*` (API знаний + вебхук
 * целей) — по HTTP через настоящее приложение (app.setup, глобальный гвард
 * @PublicRoute, настоящие контроллеры и лимитер на настоящем Postgres).
 * Сервисы — подделки, которые считают вызовы: вызов сервиса = чтение и
 * расшифровка секрета сайта, его лимитер и должен не допускать.
 *  - не прошедших подпись (401) с адреса — не больше `unsignedPerMinute` в
 *    окне; дальше — 429 с Retry-After ДО сервиса, в том числе подписанным
 *    с того же адреса; другой адрес — не задет; окно общее для обоих API;
 *  - все запросы с адреса — не больше `perMinute` (общий счёт двух API);
 *  - адрес — первый `x-forwarded-for` (как у остальных публичных маршрутов),
 *    IPv6 — по /64; в базе — только хеш (сырого адреса нет);
 *  - сбой счётчика — маршрут работает (подпись и лимиты сайта остаются).
 */
import {
  DynamicModule,
  Global,
  HttpException,
  HttpStatus,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { GOAL_WEBHOOK_SIGNATURE_HEADER } from '../../brand';
import {
  ASSIST_V1_IP_LIMITS,
  AssistV1IpLimit,
} from '../../common/assist-v1-ip-limit';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { GoalWebhookController } from '../../modules/assist-analytics/goal-webhook.controller';
import { GoalWebhookService } from '../../modules/assist-analytics/goal-webhook.service';
import {
  describeDb,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { KnowledgeApiController } from '../../modules/assist-site-knowledge-api/knowledge-api.controller';
import { KnowledgeApiService } from '../../modules/assist-site-knowledge-api/knowledge-api.service';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import { TEST_ASSIST_TOKEN } from '../../modules/telegram-auth/test-init-data';
import { awaitMinuteHeadroom } from '../window-headroom';

jest.setTimeout(120_000);

@Global()
@Module({})
class IpInfra {
  static with(prisma: PrismaService): DynamicModule {
    return {
      module: IpInfra,
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: SitesDb, useValue: new SitesDb(prisma) },
      ],
      exports: [PrismaService, SitesDb],
    };
  }
}

const GOOD = 't=1,v1=good';

function unauthorized(): HttpException {
  return new HttpException(
    { error: 'SIGNATURE_INVALID', code: 'SIGNATURE_INVALID' },
    HttpStatus.UNAUTHORIZED,
  );
}

/** Подделка сервиса: «подпись» верна только `GOOD`; считает вызовы. */
class FakeSigned {
  calls = 0;
  private check(signature: string | undefined): void {
    this.calls++;
    if (signature !== GOOD) throw unauthorized();
  }
  async list(r: { siteId: string; signature?: string }) {
    this.check(r.signature);
    return { siteId: r.siteId, documents: [] };
  }
  async put(r: { key: string; signature?: string }) {
    this.check(r.signature);
    return { key: r.key, status: 'unchanged', version: null, hash: 'h' };
  }
  async remove(r: { key: string; signature?: string }) {
    this.check(r.signature);
    return { key: r.key, status: 'absent', version: null };
  }
  async receive(r: { signature?: string }) {
    this.check(r.signature);
    return { status: 'accepted' };
  }
}

const ENV_KEYS = ['ASSIST_BOT_TOKEN', 'ASSIST_SECRETS_KEY'] as const;

describeDb('Ш5 (11): лимит по IP на /assist/v1/sites/* (HTTP)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: AssistV1IpLimit;
  const knowledge = new FakeSigned();
  const goals = new FakeSigned();
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    Logger.overrideLogger(false);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    // Своя соль хеша адреса: счётчики спеки не пересекаются с другими.
    process.env.ASSIST_SECRETS_KEY = `sh5-ip-limit-${randomUUID()}`;
    prisma = ownerPrisma();
    const mod = await Test.createTestingModule({
      imports: [IpInfra.with(prisma), TelegramAuthModule],
      controllers: [KnowledgeApiController, GoalWebhookController],
      providers: [
        AssistV1IpLimit,
        { provide: KnowledgeApiService, useValue: knowledge },
        { provide: GoalWebhookService, useValue: goals },
      ],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
    limiter = app.get(AssistV1IpLimit);
    limiter.env = process.env;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(async () => {
    // Серия теста — в одном минутном окне (и в одних сутках соли хеша).
    await awaitMinuteHeadroom(10_000);
    limiter.limits = { ...ASSIST_V1_IP_LIMITS };
    knowledge.calls = 0;
    goals.calls = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  const srv = () => app.getHttpServer();
  /** Уникальный адрес теста (TEST-NET-3 + случайный хвост). */
  const ipv4 = () =>
    `203.0.113.${Math.floor(Math.random() * 250) + 1}, 10.0.0.${Math.floor(Math.random() * 250)}`;
  let v4seq = 0;
  const freshIp = () => `198.51.${100 + (v4seq++ % 100)}.${Date.now() % 250}`;

  function getDocs(ip: string, sig?: string) {
    const r = request(srv())
      .get('/assist/v1/sites/site_a/knowledge/site/documents')
      .set('X-Forwarded-For', ip);
    return sig ? r.set(GOAL_WEBHOOK_SIGNATURE_HEADER, sig) : r;
  }
  function putDoc(ip: string, sig?: string) {
    const r = request(srv())
      .put('/assist/v1/sites/site_a/knowledge/site/documents/kb')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json');
    if (sig) r.set(GOAL_WEBHOOK_SIGNATURE_HEADER, sig);
    return r.send('{"title":"t","content":"c"}');
  }
  function goal(ip: string, sig?: string) {
    const r = request(srv())
      .post('/assist/v1/sites/site_b/goal-events')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'o-1');
    if (sig) r.set(GOAL_WEBHOOK_SIGNATURE_HEADER, sig);
    return r.send('{"orderId":"o-1"}');
  }

  it('неподписанные: окно на адрес общее для двух API; дальше 429 до сервиса, и подписанным с того же адреса тоже', async () => {
    limiter.limits = { ...ASSIST_V1_IP_LIMITS, unsignedPerMinute: 6 };
    const ip = freshIp();
    for (let i = 0; i < 6; i++) {
      const r =
        i % 3 === 0
          ? await getDocs(ip)
          : i % 3 === 1
            ? await putDoc(ip, 't=1,v1=forged')
            : await goal(ip, 't=1,v1=forged');
      expect(r.status).toBe(401);
    }
    expect(knowledge.calls + goals.calls).toBe(6);
    const blocked = await goal(ip, 't=1,v1=forged');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    // Подписанный с того же адреса — тоже 429, сервис (секрет) не тронут.
    expect((await getDocs(ip, GOOD)).status).toBe(429);
    expect(knowledge.calls + goals.calls).toBe(6);
    // Другой адрес — не задет.
    expect((await getDocs(freshIp(), GOOD)).status).toBe(200);
    expect((await goal(freshIp(), GOOD)).status).toBe(200);
  });

  it('боевой потолок неподписанных — 30 в минуту (31-й — 429 без сервиса)', async () => {
    const ip = freshIp();
    for (let i = 0; i < ASSIST_V1_IP_LIMITS.unsignedPerMinute; i++) {
      expect((await getDocs(ip, 't=1,v1=forged')).status).toBe(401);
    }
    const before = knowledge.calls;
    expect((await getDocs(ip)).status).toBe(429);
    expect(knowledge.calls).toBe(before);
  });

  it('все запросы адреса: общий потолок двух API в минуту — 429 и для подписанных', async () => {
    limiter.limits = { ...ASSIST_V1_IP_LIMITS, perMinute: 5 };
    const ip = freshIp();
    for (let i = 0; i < 3; i++)
      expect((await getDocs(ip, GOOD)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await goal(ip, GOOD)).status).toBe(200);
    expect((await putDoc(ip, GOOD)).status).toBe(429);
    expect((await goal(ip, GOOD)).status).toBe(429);
    expect(knowledge.calls + goals.calls).toBe(5);
    expect((await goal(freshIp(), GOOD)).status).toBe(200);
  });

  it('адрес — первый x-forwarded-for; IPv6 — по /64; в базе только хеш', async () => {
    limiter.limits = { ...ASSIST_V1_IP_LIMITS, unsignedPerMinute: 2 };
    // Хвост цепочки прокси не делает адрес новым.
    const head = ipv4().split(',')[0];
    expect((await getDocs(`${head}, 10.1.1.1`)).status).toBe(401);
    expect((await getDocs(`${head}, 10.2.2.2`)).status).toBe(401);
    expect((await getDocs(`${head}, 10.3.3.3`)).status).toBe(429);
    // Один /64 — один счётчик (смена адреса внутри подсети не обходит).
    const p = `2001:db8:${(Date.now() % 65535).toString(16)}:${Math.floor(Math.random() * 65535).toString(16)}`;
    expect((await goal(`${p}::1`)).status).toBe(401);
    expect((await goal(`${p}:ffff::2`)).status).toBe(401);
    expect((await goal(`${p}::3`)).status).toBe(429);
    const rows = await prisma.$queryRawUnsafe<Array<{ key: string }>>(
      `SELECT "key" FROM "sites"."assist_rate_buckets" WHERE "scope" LIKE 'assist-v1-%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.key).toMatch(/^[0-9a-f]{64}$/);
      expect(r.key).not.toContain(head);
    }
  });

  it('сбой счётчика — маршрут не падает в 500 (подпись решает)', async () => {
    jest
      .spyOn(prisma, '$queryRawUnsafe')
      .mockRejectedValue(new Error('db down'));
    expect((await getDocs(freshIp(), GOOD)).status).toBe(200);
    expect((await goal(freshIp())).status).toBe(401);
  });
});
