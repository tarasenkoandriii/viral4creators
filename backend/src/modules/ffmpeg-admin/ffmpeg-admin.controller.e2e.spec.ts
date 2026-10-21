/**
 * Контракт `/api/admin/ffmpeg/*` (ТЗ FFmpeg-server v1.1 §13.1).
 *
 * Настоящий Nest, настоящие `AdminSessionGuard` (cookie + Origin/CSRF),
 * права, сервис, журнал, ops-клиент и `FfmpegApiService`; подменены
 * только БД (в памяти) и сеть до ffmpeg-server (`fetch`).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { FfmpegAdminController } from './ffmpeg-admin.controller';
import { FfmpegAdminService } from './ffmpeg-admin.service';
import { FfmpegAdminAccess } from './ffmpeg-admin-access';
import { FfmpegOperatorJournal } from './ffmpeg-operator-journal';
import { FfmpegOpsClient } from './ffmpeg-ops.client';

const BASE = 'https://ffmpeg-self.test/api';
const ORIGIN = 'https://admin.test';
const SECRETS = ['client-secret-key', 'ops-secret-key', 'hosted-secret-key'];
const SIGNED = 'https://storage.test/in.mp4?token=SIGNED-INPUT';

const SESSIONS: Record<string, { userId: string; expiresAt: Date }> = {
  tok_owner: { userId: 'usr_owner', expiresAt: new Date(Date.now() + 3600e3) },
  tok_qa: { userId: 'usr_qa', expiresAt: new Date(Date.now() + 3600e3) },
  tok_user: { userId: 'usr_plain', expiresAt: new Date(Date.now() + 3600e3) },
};
const USERS: Record<string, { isOperator: boolean; telegramId: string }> = {
  usr_owner: { isOperator: true, telegramId: '1001' },
  // Оператор/QA viewer: isOperator, но не владелец.
  usr_qa: { isOperator: true, telegramId: '2002' },
  usr_plain: { isOperator: false, telegramId: '1001x' },
};

type Row = Record<string, unknown> & {
  operationId: string;
  phase: string;
  createdAt: Date;
};

function freshDb() {
  const journal: Row[] = [];
  const routing = {
    id: 'default',
    revision: 1,
    defaultProvider: 'hosted',
    canaryProducts: [] as string[],
    updatedAt: new Date(),
    updatedBy: null as string | null,
    breakerFailures: 3,
    breakerOpenUntil: new Date(Date.now() + 5 * 60_000) as Date | null,
    breakerCountedJobs: [] as string[],
  };
  return {
    journal,
    routing,
    adminSession: {
      findUnique: jest.fn(
        async (a: { where: { token: string } }) =>
          SESSIONS[a.where.token] ?? null,
      ),
    },
    user: {
      findUnique: jest.fn(
        async (a: { where: { id: string } }) => USERS[a.where.id] ?? null,
      ),
    },
    ffmpegRouting: {
      findUnique: jest.fn(async () => ({ ...routing })),
      updateMany: jest.fn(
        async (a: {
          where: { revision: number };
          data: {
            defaultProvider: string;
            canaryProducts: string[];
            updatedBy: string;
          };
        }) => {
          if (a.where.revision !== routing.revision) return { count: 0 };
          routing.revision += 1;
          routing.defaultProvider = a.data.defaultProvider;
          routing.canaryProducts = a.data.canaryProducts;
          routing.updatedBy = a.data.updatedBy;
          return { count: 1 };
        },
      ),
    },
    ffmpegOperatorAction: {
      create: jest.fn(
        async (a: {
          data: Record<string, unknown> & {
            operationId: string;
            phase: string;
          };
        }) => {
          if (
            journal.some(
              (r) =>
                r.operationId === a.data.operationId &&
                r.phase === a.data.phase,
            )
          )
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          const row: Row = {
            id: randomUUID(),
            ...a.data,
            createdAt: new Date(),
          };
          journal.push(row);
          return row;
        },
      ),
      findMany: jest.fn(
        async (a: { where: { operationId?: string; jobId?: string } }) =>
          journal.filter(
            (r) =>
              (!a.where.operationId || r.operationId === a.where.operationId) &&
              (!a.where.jobId || r.jobId === a.where.jobId),
          ),
      ),
    },
    aiUsage: { count: jest.fn(async () => 0) },
    ffmpegFallbackEvent: { count: jest.fn(async () => 4) },
    storyVideoRender: {
      findFirst: jest.fn(async (a: { where: { jobId: string } }) =>
        a.where.jobId === 'selfhosted:job-1'
          ? { id: 'r1', giftId: 'g1' }
          : null,
      ),
    },
    tutorialVideoAsset: { findFirst: jest.fn(async () => null) },
    tutorialVideoVersion: { findFirst: jest.fn(async () => null) },
    tutorialDemoQualityCheck: { findFirst: jest.fn(async () => null) },
    portfolioItem: { findFirst: jest.fn(async () => null) },
    videoAudioTrack: { findFirst: jest.fn(async () => null) },
  };
}

let db = freshDb();
const prismaProxy = new Proxy(
  {},
  { get: (_t, key: string) => (db as Record<string, unknown>)[key] },
);

type Handler = (
  init: RequestInit,
  url: URL,
) =>
  | { status: number; body: unknown }
  | Promise<{ status: number; body: unknown }>;
let routes: Record<string, Handler> = {};
let offline = false;
const calls: Array<{
  method: string;
  path: string;
  headers: Record<string, string>;
  journalAtSend: string[];
}> = [];
const realFetch = global.fetch;
const fetchMock = jest.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  const method = (init.method ?? 'GET').toUpperCase();
  const path = url.pathname.replace('/api', '');
  calls.push({
    method,
    path,
    headers: init.headers as Record<string, string>,
    journalAtSend: db.journal.map((r) => `${r.action}:${r.phase}`),
  });
  if (offline)
    throw Object.assign(new Error('connect ECONNREFUSED'), {
      name: 'TypeError',
    });
  const h = routes[`${method} ${path}`];
  const res = h
    ? await h(init, url)
    : { status: 404, body: { error: { code: 'NOT_FOUND' } } };
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => JSON.stringify(res.body),
  } as unknown as Response;
});

const OVERVIEW = {
  data: {
    accept: 'open',
    worker: 'running',
    ready: { ok: true, reason: null },
    queue: { active: 1, queued: 2, failed: 0, oldest_age_sec: 30 },
    disk: { free_bytes: 20e9 },
    image_digest: 'sha256:abc',
    // Лишнее, что сервер мог бы по ошибке отдать, — наружу не уходит.
    ops_key: 'ops-secret-key',
    last_input_url: SIGNED,
  },
};

describe('/api/admin/ffmpeg (e2e)', () => {
  let app: INestApplication;
  const env = { ...process.env };

  beforeAll(async () => {
    global.fetch = fetchMock as unknown as typeof fetch;
    const moduleRef = await Test.createTestingModule({
      controllers: [FfmpegAdminController],
      providers: [
        AdminSessionGuard,
        FfmpegAdminService,
        FfmpegAdminAccess,
        FfmpegOperatorJournal,
        FfmpegOpsClient,
        FfmpegApiService,
        { provide: PrismaService, useValue: prismaProxy },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(async () => {
    global.fetch = realFetch;
    process.env = env;
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
    // Кэш «последних удачных данных» живёт в сервисе-синглтоне.
    (
      app.get(FfmpegAdminService) as unknown as {
        lastGood: Map<string, unknown>;
      }
    ).lastGood.clear();
    offline = false;
    calls.length = 0;
    process.env.ADMIN_OWNER_TELEGRAM_IDS = ' 1001 , 3003';
    process.env.CORS_ORIGIN = ORIGIN;
    process.env.FFMPEG_SELFHOSTED_BASE_URL = BASE;
    process.env.FFMPEG_SELFHOSTED_KEY = 'client-secret-key';
    process.env.FFMPEG_SELFHOSTED_OPS_KEY = 'ops-secret-key';
    process.env.FFMPEG_API_KEY = 'hosted-secret-key';
    process.env.FFMPEG_SELFHOSTED_ENABLED = 'true';
    routes = {
      'GET /ops/overview': () => ({ status: 200, body: OVERVIEW }),
      'GET /ops/limits': () => ({
        status: 200,
        body: { data: { revision: 4, maxInputs: 20, maxThreads: 2 } },
      }),
      'GET /ops/jobs': () => ({
        status: 200,
        body: {
          data: {
            items: [
              {
                id: 'job-1',
                state: 'running',
                status: 'processing',
                client_operation_id: 'story:story-video:r1',
                input_files: { base: SIGNED },
                ffmpeg_commands: ['ffmpeg -i {{base}} secret-text'],
              },
              {
                id: 'job-2',
                status: 'failed',
                client_operation_id: 'postprod:abc',
                error_code: 'TIMEOUT',
              },
            ],
            next_cursor: 'c2',
          },
        },
      }),
      'GET /ops/jobs/job-1': () => ({
        status: 200,
        body: {
          data: {
            id: 'job-1',
            status: 'succeeded',
            client_operation_id: 'story:story-video:r1',
            output_files: {
              'out.mp4': `${BASE}/files/job-1/out.mp4?token=OUT-TOKEN`,
            },
            stderr: `Input #0 from '${SIGNED}'\n` + 'x'.repeat(70 * 1024),
            timeline: [{ state: 'queued', at: '2026-10-21T10:00:00Z' }],
          },
        },
      }),
      'POST /control/pause': () => ({
        status: 200,
        body: { data: { worker: 'paused' } },
      }),
      'POST /control/drain': () => ({
        status: 200,
        body: { data: { accept: 'draining' } },
      }),
      'POST /control/resume': () => ({
        status: 409,
        body: {
          error: { code: 'NOT_READY', message: 'readiness не пройдена: disk' },
        },
      }),
      'POST /jobs/job-1/cancel': () => ({
        status: 200,
        body: { data: { id: 'job-1', status: 'canceled' } },
      }),
      'DELETE /jobs/job-1/artifacts': () => ({
        status: 202,
        body: { data: { id: 'job-1', revoked: true } },
      }),
      'GET /jobs/job-1': () => ({
        status: 200,
        body: { data: { id: 'job-1', status: 'processing', stage: 'running' } },
      }),
      'POST /ops/limits': (init) => {
        const body = JSON.parse(init.body as string);
        return body.expected_revision === 4
          ? {
              status: 200,
              body: { data: { revision: 5, maxInputs: body.limits.maxInputs } },
            }
          : {
              status: 409,
              body: {
                error: { code: 'STALE_REVISION', message: 'revision 4' },
              },
            };
      },
      'POST /ops/jobs/job-1/download-link': () => ({
        status: 200,
        body: {
          data: {
            url: `${BASE}/files/job-1/out.mp4?token=DL-TOKEN`,
            expires_at: '2026-10-21T11:00:00Z',
            mime: 'video/mp4',
          },
        },
      }),
    };
  });

  const as = (tok?: string) => (r: request.Test) =>
    tok ? r.set('Cookie', `admin_session=${tok}`) : r;
  const get = (path: string, tok = 'tok_owner') =>
    as(tok)(request(app.getHttpServer()).get(`/api/admin/ffmpeg${path}`));
  const post = (
    path: string,
    body: object,
    tok = 'tok_owner',
    origin = ORIGIN,
  ) =>
    as(tok)(
      request(app.getHttpServer())
        .post(`/api/admin/ffmpeg${path}`)
        .set('Origin', origin)
        .send(body),
    );
  const op = () => randomUUID();
  const noSecrets = (text: string) => {
    for (const s of [...SECRETS, 'SIGNED-INPUT', 'OUT-TOKEN', 'secret-text'])
      expect(text).not.toContain(s);
  };

  describe('доступ', () => {
    const reads = ['/overview', '/jobs', '/jobs/selfhosted:job-1', '/limits'];
    const mutations: Array<[string, object]> = [
      ['/pause', {}],
      ['/drain', {}],
      ['/resume', {}],
      ['/jobs/selfhosted:job-1/cancel', { reason: 'проверка' }],
      [
        '/jobs/selfhosted:job-1/purge',
        { reason: 'проверка', confirmIrreversible: true },
      ],
      ['/jobs/selfhosted:job-1/reconcile', {}],
      ['/jobs/selfhosted:job-1/download-link', { file: 'out.mp4' }],
      ['/limits', { expectedRevision: 4, limits: { maxInputs: 10 } }],
      [
        '/routing',
        {
          expectedRevision: 1,
          defaultProvider: 'hosted',
          canaryProducts: ['story'],
        },
      ],
    ];

    it('без сессии — 401 на всё', async () => {
      for (const p of reads) await get(p, '').expect(401);
      for (const [p, b] of mutations)
        await post(p, { operationId: op(), ...b }, '').expect(401);
    });

    it('оператор без права владельца (QA viewer) и обычный пользователь — 403, сервер не вызывается', async () => {
      for (const tok of ['tok_qa', 'tok_user']) {
        for (const p of reads) await get(p, tok).expect(403);
        for (const [p, b] of mutations)
          await post(p, { operationId: op(), ...b }, tok).expect(403);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.journal).toHaveLength(0);
    });

    it('без ADMIN_OWNER_TELEGRAM_IDS — запрет и владельцу (по умолчанию закрыто)', async () => {
      delete process.env.ADMIN_OWNER_TELEGRAM_IDS;
      await get('/overview').expect(403);
    });

    it('владелец получает все четыре права', async () => {
      const res = await get('/overview').expect(200);
      expect(res.body.data.permissions).toEqual([
        'ffmpeg.read',
        'ffmpeg.operate',
        'ffmpeg.configure',
        'ffmpeg.media.read',
      ]);
    });

    it('CSRF: мутация с чужого Origin — 403 до проверки прав и без вызова сервера', async () => {
      for (const [p, b] of mutations)
        await post(
          p,
          { operationId: op(), ...b },
          'tok_owner',
          'https://evil.test',
        ).expect(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.journal).toHaveLength(0);
    });
  });

  describe('review draft', () => {
    const path = '/jobs/selfhosted:job-1/review-draft';
    const sourceSha = 'a'.repeat(64);
    const outputSha = 'b'.repeat(64);
    const document = {
      sourceInputKey: 'source',
      sourceSha256: sourceSha,
      outputSha256: outputSha,
      recipe: {},
      suggestions: [],
      selectedParameters: [],
    };
    it('requires owner session and same-origin CSRF', async () => {
      const body = { file: 'out.mp4', document };
      await post(path, body, '').expect(401);
      await post(path, body, 'tok_qa').expect(403);
      await post(path, body, 'tok_user').expect(403);
      await post(path, body, 'tok_owner', 'https://evil.test').expect(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('binds fresh metadata without render, journal mutation or paid call', async () => {
      routes['GET /ops/jobs/job-1'] = () => ({
        status: 200,
        body: {
          data: {
            execution_status: 'succeeded',
            expires_at: '2030-01-01',
            inputs_metadata: [
              {
                key: 'source',
                mime: 'video/mp4',
                sha256: sourceSha,
                streams: [{ type: 'video' }],
              },
            ],
            artifacts: [
              { name: 'out.mp4', sha256: outputSha, mime: 'video/mp4' },
            ],
          },
        },
      });
      const res = await post(path, { file: 'out.mp4', document }).expect(200);
      expect(res.body.data.manifest.reviewedOutput.sha256).toBe(outputSha);
      expect(res.body.data.manifest.plan).toBeNull();
      await post(path, {
        file: 'out.mp4',
        document: { ...document, outputSha256: sourceSha },
      }).expect(400);
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(db.journal).toHaveLength(0);
      noSecrets(JSON.stringify(res.body));
      routes['GET /ops/jobs/job-1'] = () => {
        throw new Error('ops-secret-key');
      };
      const unavailable = await post(path, {
        file: 'out.mp4',
        document,
      }).expect(503);
      noSecrets(JSON.stringify(unavailable.body));
    });
  });

  describe('чтение', () => {
    it('overview: данные сервера + маршрутизация backend, без секретов', async () => {
      const res = await get('/overview').expect(200);
      const d = res.body.data;
      expect(d.selfhosted.state).toBe('ok');
      expect(d.selfhosted.fetchedAt).toEqual(expect.any(String));
      expect(d.selfhosted.data.queue.queued).toBe(2);
      expect(d.selfhosted.configuration).toEqual({
        baseUrl: true,
        opsKey: true,
        clientKey: true,
      });
      expect(d.routing).toMatchObject({
        revision: 1,
        defaultProvider: 'hosted',
        effectiveDefaultProvider: 'hosted',
        selfhostedGateEnabled: true,
      });
      expect(d.hosted.configured).toBe(true);
      expect(d.fallbacks24h).toBe(4);
      expect(d.routing.breaker).toMatchObject({
        failures: 3,
        threshold: 3,
        open: true,
        openUntil: expect.any(String),
      });
      expect(d.routing.fallbackToHosted).toBe(true);
      expect(calls[0].headers.Authorization).toBe('Bearer ops-secret-key');
      noSecrets(res.text);
      expect(res.text).not.toContain('ffmpeg-self.test');
    });

    it('VPS offline: overview — stale с прежними данными и временем, а не пустая очередь', async () => {
      await get('/overview').expect(200);
      offline = true;
      const res = await get('/overview').expect(200);
      expect(res.body.data.selfhosted).toMatchObject({
        state: 'stale',
        error: expect.stringMatching(/недоступен/),
        data: { queue: { queued: 2 } },
      });
      expect(res.body.data.selfhosted.fetchedAt).toEqual(expect.any(String));
    });

    it('VPS offline без прежних данных: error и data = null; список задач — items: null', async () => {
      offline = true;
      const o = await get('/overview').expect(200);
      expect(o.body.data.selfhosted).toMatchObject({
        state: 'error',
        data: null,
      });
      const j = await get('/jobs').expect(200);
      expect(j.body.data).toMatchObject({ state: 'error', items: null });
    });

    it('тайм-аут запроса к серверу — 5 с', async () => {
      const spy = jest.spyOn(AbortSignal, 'timeout');
      offline = true; // реального таймаута не ждём: проверяем сам лимит
      await get('/overview').expect(200);
      expect(spy).toHaveBeenCalledWith(5000);
      spy.mockRestore();
    });

    it('jobs: страница 25, период по умолчанию 24h, id с префиксом, продукт из client_operation_id; без URL и команд', async () => {
      const res = await get(
        '/jobs?state=processing&clientOperationId=story:x',
      ).expect(200);
      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.searchParams.get('limit')).toBe('25');
      expect(url.searchParams.get('period')).toBe('24h');
      expect(url.searchParams.get('state')).toBe('processing');
      expect(url.searchParams.get('client_operation_id')).toBe('story:x');
      const items = res.body.data.items;
      expect(items[0]).toMatchObject({
        jobId: 'selfhosted:job-1',
        providerJobId: 'job-1',
        provider: 'selfhosted',
        product: 'story',
        input_names: ['base'],
      });
      expect(res.body.data.nextCursor).toBe('c2');
      noSecrets(res.text);
    });

    it('jobs: фильтр продукта сужает страницу; неизвестный продукт — 400', async () => {
      const res = await get('/jobs?product=postprod').expect(200);
      expect(
        res.body.data.items.map((i: { jobId: string }) => i.jobId),
      ).toEqual(['selfhosted:job-2']);
      await get('/jobs?product=nova').expect(400);
    });

    it('jobs/:id: карточка без токенов, stderr ≤ 64 KiB, ссылка на исходную операцию и журнал', async () => {
      const res = await get('/jobs/selfhosted:job-1').expect(200);
      const d = res.body.data;
      expect(d.provider).toBe('selfhosted');
      expect(d.data.output_names).toEqual(['out.mp4']);
      expect(Buffer.byteLength(d.data.stderr)).toBeLessThanOrEqual(
        64 * 1024 + 100,
      );
      expect(d.owners).toEqual([
        expect.objectContaining({
          kind: 'story-render',
          href: '/story-tales?gift=g1',
        }),
      ]);
      expect(d.data.product).toBe('story');
      noSecrets(res.text);
    });

    it('jobs/:id hosted-id: статус у hosted без префикса, без своего сервера', async () => {
      routes['GET /jobs/legacy-1'] = () => ({
        status: 200,
        body: {
          data: { status: 'succeeded', output_files: { 'a.mp4': SIGNED } },
        },
      });
      process.env.FFMPEG_API_BASE_URL = BASE; // тот же фейк, но ключ hosted
      const res = await get('/jobs/legacy-1').expect(200);
      expect(res.body.data).toMatchObject({
        provider: 'hosted',
        state: 'ok',
        data: { status: 'completed', outputNames: ['a.mp4'] },
      });
      expect(calls[0].headers.Authorization).toBe('Bearer hosted-secret-key');
      noSecrets(res.text);
      delete process.env.FFMPEG_API_BASE_URL;
    });

    it('GET не меняет очередь и журнал', async () => {
      for (const p of [
        '/overview',
        '/jobs',
        '/jobs/selfhosted:job-1',
        '/limits',
      ])
        await get(p).expect(200);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
      expect(db.journal).toHaveLength(0);
      expect(db.ffmpegRouting.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('мутации', () => {
    it('журнал: запрос записан ДО отправки, исход — после; ключи — operationId', async () => {
      const operationId = op();
      const res = await post('/pause', {
        operationId,
        reason: 'обслуживание',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        outcome: 'succeeded',
        replayed: false,
        operationId,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].journalAtSend).toEqual(['pause:requested']);
      expect(calls[0].headers['Idempotency-Key']).toBe(operationId);
      expect(calls[0].headers.Authorization).toBe('Bearer ops-secret-key');
      expect(db.journal.map((r) => r.phase)).toEqual([
        'requested',
        'succeeded',
      ]);
      const [req, done] = db.journal;
      expect(req).toMatchObject({
        actorUserId: 'usr_owner',
        action: 'pause',
        reason: 'обслуживание',
      });
      expect(done.correlationId).toBe(req.correlationId);
      expect(calls[0].headers['X-Correlation-Id']).toBe(req.correlationId);
    });

    it('повтор клика с тем же operationId не выполняет действие второй раз', async () => {
      const operationId = op();
      await post('/drain', { operationId }).expect(200);
      const again = await post('/drain', { operationId }).expect(200);
      expect(again.body.data).toMatchObject({
        replayed: true,
        outcome: 'succeeded',
      });
      expect(calls).toHaveLength(1);
    });

    it('тот же operationId для другого действия — 409', async () => {
      const operationId = op();
      await post('/drain', { operationId }).expect(200);
      await post('/pause', { operationId }).expect(409);
    });

    it('VPS offline на мутации — outcome unknown; повтор того же id сверяет состояние и (если не применено) выполняет один раз (FF-INT-06)', async () => {
      offline = true;
      const operationId = op();
      const res = await post('/jobs/selfhosted:job-1/cancel', {
        operationId,
        reason: 'зависла',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        outcome: 'unknown',
        message: expect.stringMatching(/сверяем/),
      });
      expect(db.journal.map((r) => r.phase)).toEqual(['requested', 'unknown']);
      offline = false;
      const n = calls.length;
      // Задача ещё идёт (status processing) — отмена не применена: выполняется.
      const again = await post('/jobs/selfhosted:job-1/cancel', {
        operationId,
        reason: 'зависла',
      }).expect(200);
      expect(again.body.data).toMatchObject({ outcome: 'succeeded' });
      expect(calls.slice(n).map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /jobs/job-1',
        'POST /jobs/job-1/cancel',
      ]);
      expect(db.journal.map((r) => r.phase)).toEqual([
        'requested',
        'unknown',
        'succeeded',
      ]);
    });

    it('FF-INT-06: pause после unknown — режим уже paused → «сверено», повторно не выполняется', async () => {
      const operationId = op();
      offline = true;
      await post('/pause', { operationId }).expect(200);
      offline = false;
      routes['GET /ops/overview'] = () => ({
        status: 200,
        body: {
          data: { ...OVERVIEW.data, control: { mode: 'paused', revision: 2 } },
        },
      });
      const n = calls.length;
      const again = await post('/pause', { operationId }).expect(200);
      expect(again.body.data).toMatchObject({
        outcome: 'succeeded',
        message: expect.stringMatching(/Сверено/),
      });
      expect(calls.slice(n).map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /ops/overview',
      ]);
      expect(db.journal.at(-1)).toMatchObject({
        phase: 'succeeded',
        result: expect.objectContaining({ verified: true, mode: 'paused' }),
      });
    });

    it('FF-INT-06: cancel после unknown, а задача уже завершилась — 409, без отмены', async () => {
      const operationId = op();
      offline = true;
      await post('/jobs/selfhosted:job-1/cancel', {
        operationId,
        reason: 'зависла',
      }).expect(200);
      offline = false;
      routes['GET /jobs/job-1'] = () => ({
        status: 200,
        body: { data: { id: 'job-1', status: 'succeeded' } },
      });
      const n = calls.length;
      const again = await post('/jobs/selfhosted:job-1/cancel', {
        operationId,
        reason: 'зависла',
      }).expect(409);
      expect(again.text).toContain('FFMPEG_JOB_TERMINAL');
      expect(calls.slice(n).some((c) => c.method === 'POST')).toBe(false);
    });

    it('FF-INT-06: limits после unknown — ревизия уже выросла и значения совпали → «сверено»; не выросла → выполняется', async () => {
      const operationId = op();
      offline = true;
      await post('/limits', {
        operationId,
        expectedRevision: 4,
        limits: { maxInputs: 10 },
      }).expect(200);
      offline = false;
      routes['GET /ops/limits'] = () => ({
        status: 200,
        body: { data: { revision: 5, maxInputs: 10 } },
      });
      const n = calls.length;
      const again = await post('/limits', {
        operationId,
        expectedRevision: 4,
        limits: { maxInputs: 10 },
      }).expect(200);
      expect(again.body.data.outcome).toBe('succeeded');
      expect(calls.slice(n).some((c) => c.method === 'POST')).toBe(false);
      expect(db.journal.at(-1)).toMatchObject({ newRevision: 5 });

      const op2 = op();
      offline = true;
      await post('/limits', {
        operationId: op2,
        expectedRevision: 4,
        limits: { maxInputs: 12 },
      }).expect(200);
      offline = false;
      routes['GET /ops/limits'] = () => ({
        status: 200,
        body: { data: { revision: 4, maxInputs: 20 } },
      });
      const m = calls.length;
      await post('/limits', {
        operationId: op2,
        expectedRevision: 4,
        limits: { maxInputs: 12 },
      }).expect(200);
      expect(calls.slice(m).map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /ops/limits',
        'POST /ops/limits',
      ]);
    });

    it('cancel/purge идут ключом клиента; purge требует подтверждения и отдаёт 202 как «удаление идёт»', async () => {
      await post('/jobs/selfhosted:job-1/cancel', {
        operationId: op(),
        reason: 'зависла',
      }).expect(200);
      expect(calls[0]).toMatchObject({
        method: 'POST',
        path: '/jobs/job-1/cancel',
      });
      expect(calls[0].headers.Authorization).toBe('Bearer client-secret-key');
      await post('/jobs/selfhosted:job-1/purge', {
        operationId: op(),
        reason: 'отзыв',
      }).expect(400);
      const res = await post('/jobs/selfhosted:job-1/purge', {
        operationId: op(),
        reason: 'отзыв согласия',
        confirmIrreversible: true,
      }).expect(200);
      expect(res.body.data.result).toMatchObject({
        revoked: true,
        deletionConfirmed: false,
      });
      expect(calls.at(-1)).toMatchObject({
        method: 'DELETE',
        path: '/jobs/job-1/artifacts',
      });
    });

    it('cancel без причины — 400; hosted-задача — 400 без вызова сервера', async () => {
      await post('/jobs/selfhosted:job-1/cancel', { operationId: op() }).expect(
        400,
      );
      await post('/jobs/legacy-1/cancel', {
        operationId: op(),
        reason: 'зависла',
      }).expect(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resume, отклонённый сервером (readiness), — 409 с кодом, исход failed в журнале', async () => {
      const res = await post('/resume', { operationId: op() }).expect(409);
      expect(res.text).toContain('NOT_READY');
      expect(db.journal.map((r) => r.phase)).toEqual(['requested', 'failed']);
    });

    it('reconcile — только чтение status / by-key; 404 по ключу не создаёт задачу', async () => {
      const r1 = await post('/jobs/selfhosted:job-1/reconcile', {
        operationId: op(),
      }).expect(200);
      expect(r1.body.data.result).toMatchObject({
        found: true,
        status: 'processing',
      });
      const r2 = await post('/jobs/selfhosted:job-1/reconcile', {
        operationId: op(),
        idempotencyKey: 'story-video:r1',
      }).expect(200);
      expect(r2.body.data.result).toMatchObject({ found: false });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /jobs/job-1',
        'GET /jobs/by-key/story-video%3Ar1',
      ]);
      expect(calls.some((c) => c.path === '/ffmpeg')).toBe(false);
    });

    it('limits: устаревшая ревизия — 409; верная — новая ревизия в журнале; concurrency не меняется', async () => {
      const stale = await post('/limits', {
        operationId: op(),
        expectedRevision: 3,
        limits: { maxInputs: 10 },
      }).expect(409);
      expect(stale.text).toContain('STALE_REVISION');
      const ok = await post('/limits', {
        operationId: op(),
        expectedRevision: 4,
        limits: { maxInputs: 10 },
      }).expect(200);
      expect(ok.body.data.result).toMatchObject({ revision: 5 });
      expect(db.journal.at(-1)).toMatchObject({
        phase: 'succeeded',
        oldRevision: 4,
        newRevision: 5,
      });
      const n = calls.length;
      await post('/limits', {
        operationId: op(),
        expectedRevision: 5,
        limits: { concurrency: 2 },
      }).expect(400);
      expect(calls).toHaveLength(n);
    });

    it('routing: CAS по ревизии, 409 на устаревшей; default=selfhosted — только с отдельным подтверждением', async () => {
      const ok = await post('/routing', {
        operationId: op(),
        expectedRevision: 1,
        defaultProvider: 'hosted',
        canaryProducts: ['story', 'story'],
      }).expect(200);
      expect(ok.body.data.result).toMatchObject({
        revision: 2,
        canaryProducts: ['story'],
      });
      await post('/routing', {
        operationId: op(),
        expectedRevision: 1,
        defaultProvider: 'hosted',
        canaryProducts: [],
      }).expect(409);
      await post('/routing', {
        operationId: op(),
        expectedRevision: 2,
        defaultProvider: 'selfhosted',
        canaryProducts: [],
      }).expect(400);
      expect(db.routing.defaultProvider).toBe('hosted');
      await post('/routing', {
        operationId: op(),
        expectedRevision: 2,
        defaultProvider: 'selfhosted',
        canaryProducts: [],
        confirmSelfhostedDefault: true,
      }).expect(200);
      expect(db.routing).toMatchObject({
        defaultProvider: 'selfhosted',
        revision: 3,
        updatedBy: 'usr_owner',
      });
      await post('/routing', {
        operationId: op(),
        expectedRevision: 3,
        defaultProvider: 'hosted',
        canaryProducts: ['nova'],
      }).expect(400);
      // Маршрутизация — локальная таблица: к серверу запросов нет.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('download-link: ссылка — в ответе; в журнале её нет; ключи сервера — нигде', async () => {
      const res = await post('/jobs/selfhosted:job-1/download-link', {
        operationId: op(),
        file: 'out.mp4',
      }).expect(200);
      expect(res.body.data.result).toMatchObject({
        file: 'out.mp4',
        url: expect.stringContaining('DL-TOKEN'),
        mime: 'video/mp4',
      });
      for (const s of SECRETS) expect(res.text).not.toContain(s);
      expect(JSON.stringify(db.journal)).not.toContain('DL-TOKEN');
      await post('/jobs/selfhosted:job-1/download-link', {
        operationId: op(),
        file: '../x',
      }).expect(400);
    });

    it('сервер не настроен — 503 с кодом, исход failed', async () => {
      delete process.env.FFMPEG_SELFHOSTED_OPS_KEY;
      const res = await post('/pause', { operationId: op() }).expect(503);
      expect(res.text).toContain('FFMPEG_NOT_CONFIGURED');
      expect(db.journal.map((r) => r.phase)).toEqual(['requested', 'failed']);
    });

    it('лишние поля и неверный operationId — 400 (без записи в журнал)', async () => {
      await post('/pause', { operationId: 'not-a-uuid' }).expect(400);
      await post('/pause', { operationId: op(), command: 'rm -rf' }).expect(
        400,
      );
      expect(db.journal).toHaveLength(0);
    });

    it('журнал не содержит токенов, ключей, URL и команд', async () => {
      await post('/pause', { operationId: op() }).expect(200);
      await post('/jobs/selfhosted:job-1/reconcile', {
        operationId: op(),
      }).expect(200);
      await post('/jobs/selfhosted:job-1/download-link', {
        operationId: op(),
        file: 'out.mp4',
      }).expect(200);
      const text = JSON.stringify(db.journal);
      noSecrets(text);
      expect(text).not.toMatch(/https?:\/\//);
    });
    it('reconcile: повтор с тем же id после «unknown» проверяет статус заново', async () => {
      const operationId = op();
      offline = true;
      const first = await post('/jobs/selfhosted:job-1/reconcile', {
        operationId,
        reason: 'сверка после обрыва',
      }).expect(200);
      expect(first.body.data.outcome).toBe('unknown');
      offline = false;
      const n = calls.length;
      const again = await post('/jobs/selfhosted:job-1/reconcile', {
        operationId,
        reason: 'сверка после обрыва',
      }).expect(200);
      expect(again.body.data).toMatchObject({
        outcome: 'succeeded',
        result: { found: true, status: 'processing' },
      });
      expect(calls.length).toBe(n + 1);
      expect(db.journal.map((r) => r.phase)).toEqual([
        'requested',
        'unknown',
        'succeeded',
      ]);
      expect(db.journal[0].reason).toBe('сверка после обрыва');
      // Подтверждённый исход дальше возвращается без нового запроса.
      await post('/jobs/selfhosted:job-1/reconcile', {
        operationId,
        reason: 'сверка после обрыва',
      }).expect(200);
      expect(calls.length).toBe(n + 1);
    });

    it('download-link принимает необязательную причину и пишет её в журнал', async () => {
      await post('/jobs/selfhosted:job-1/download-link', {
        operationId: op(),
        file: 'out.mp4',
        reason: 'проверка результата',
      }).expect(200);
      expect(db.journal[0]).toMatchObject({
        action: 'job.download-link',
        reason: 'проверка результата',
      });
    });
    it('recovery: resume без reconciled — понятная 409 NOT_RECONCILED', async () => {
      routes['POST /control/resume'] = () => ({
        status: 409,
        body: { error: { code: 'NOT_RECONCILED', message: 'recovery' } },
      });
      const res = await post('/resume', { operationId: op() }).expect(409);
      expect(res.text).toContain('NOT_RECONCILED');
      expect(res.text).toContain('reconciled: true');
    });

    it('recovery: resume с reconciled уходит серверу, журнал фиксирует reconciled', async () => {
      let sent: Record<string, unknown> = {};
      routes['POST /control/resume'] = (init) => {
        sent = JSON.parse(init.body as string);
        return { status: 200, body: { data: { mode: 'running' } } };
      };
      const res = await post('/resume', {
        operationId: op(),
        reconciled: true,
        reason: 'сверено с продуктовой БД',
      }).expect(200);
      expect(res.body.data.outcome).toBe('succeeded');
      expect(sent).toEqual({
        reconciled: true,
        reason: 'сверено с продуктовой БД',
      });
      expect(db.journal.at(-1)).toMatchObject({
        phase: 'succeeded',
        result: expect.objectContaining({ reconciled: true }),
      });
    });

    it('reconciled без причины — 400; без права configure — 403; без reconciled поле не уходит', async () => {
      await post('/resume', { operationId: op(), reconciled: true }).expect(
        400,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      await post(
        '/resume',
        { operationId: op(), reconciled: true, reason: 'сверено' },
        'tok_qa',
      ).expect(403);
      let sent: Record<string, unknown> = { x: 1 };
      routes['POST /control/resume'] = (init) => {
        sent = JSON.parse(init.body as string);
        return { status: 200, body: { data: {} } };
      };
      await post('/resume', { operationId: op() }).expect(200);
      expect(sent).toEqual({});
    });
    it('FF-INT-16: дубль, пока первый запрос в работе, — 202 in_progress, действие один раз, журнал без противоречий', async () => {
      routes['POST /control/pause'] = () =>
        new Promise((r) =>
          setTimeout(
            () => r({ status: 200, body: { data: { mode: 'paused' } } }),
            300,
          ),
        );
      const operationId = op();
      const first = post('/pause', { operationId }).then((r) => r);
      await new Promise((r) => setTimeout(r, 80));
      const dup = await post('/pause', { operationId });
      const done = await first;
      expect(dup.status).toBe(202);
      expect(dup.body.data).toMatchObject({
        outcome: 'in_progress',
        operationId,
      });
      expect(done.status).toBe(200);
      expect(done.body.data.outcome).toBe('succeeded');
      expect(calls.filter((c) => c.path === '/control/pause')).toHaveLength(1);
      expect(calls.some((c) => c.path === '/ops/overview')).toBe(false);
      expect(db.journal.map((r) => r.phase)).toEqual([
        'requested',
        'succeeded',
      ]);
    });

    it('FF-INT-16: запрос «в работе» дольше срока — сверка состояния, а не in_progress', async () => {
      const operationId = op();
      db.journal.push({
        id: randomUUID(),
        operationId,
        phase: 'requested',
        actorUserId: 'usr_owner',
        action: 'pause',
        jobId: null,
        correlationId: randomUUID(),
        createdAt: new Date(Date.now() - 60_000),
      });
      routes['GET /ops/overview'] = () => ({
        status: 200,
        body: {
          data: { ...OVERVIEW.data, control: { mode: 'paused', revision: 2 } },
        },
      });
      const r = await post('/pause', { operationId }).expect(200);
      expect(r.body.data).toMatchObject({ outcome: 'succeeded' });
      expect(calls.some((c) => c.path === '/control/pause')).toBe(false);
    });
  });
});
