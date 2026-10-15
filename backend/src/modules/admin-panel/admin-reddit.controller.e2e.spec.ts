/**
 * `/api/admin/reddit/*` целиком (пакет P-R-ADM): настоящий Nest с той же
 * `configureApp`, что у `main.ts` (парсер импорта 1 МБ, фильтр ошибок,
 * конверт), настоящий `AdminSessionGuard` и `AdminRedditClient`; подменены
 * база сессий, проверка оператора и сеть до sites-backend.
 */
import { ForbiddenException, INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { AdminPanelService } from './admin-panel.service';
import { AdminRedditClient } from './admin-reddit.client';
import { AdminRedditController } from './admin-reddit.controller';

const SECRET = 'reddit-internal-secret-0123456789';
const OP = 'cm1operator0000000000000a';
const C1 = 'cm1abcdefghijklmnopqrstuv';

const SESSIONS: Record<string, { userId: string; expiresAt: Date }> = {
  tok_operator: { userId: OP, expiresAt: new Date(Date.now() + 3600e3) },
  tok_user: { userId: 'usr_plain', expiresAt: new Date(Date.now() + 3600e3) },
};
const prisma = {
  adminSession: {
    findUnique: jest.fn(
      async (args: { where: { token: string } }) =>
        SESSIONS[args.where.token] ?? null,
    ),
  },
};
const adminPanel = {
  assertOperator: jest.fn(async (userId: string) => {
    if (userId !== OP) throw new ForbiddenException('Operator access required');
  }),
};

type Upstream = {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

describe('admin/reddit (e2e)', () => {
  let app: INestApplication;
  let client: AdminRedditClient;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let upstream: Upstream;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminRedditController],
      providers: [
        AdminSessionGuard,
        AdminRedditClient,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPanelService, useValue: adminPanel },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, { cors: { origins: ['https://admin.example.com'] } });
    client = moduleRef.get(AdminRedditClient);
    client.env = {
      SITES_BACKEND_URL: 'https://sites.example.com',
      SITES_INTERNAL_SECRET: SECRET,
    };
    client.fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(upstream.text ?? JSON.stringify(upstream.body), {
        status: upstream.status,
        headers: upstream.headers ?? { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    upstream = { status: 200, body: { success: true, data: { ok: true } } };
  });
  afterEach(() => jest.restoreAllMocks());

  const server = () => app.getHttpServer();
  const URL = '/api/admin/reddit';
  const asOp = (t: request.Test) =>
    t.set('Cookie', 'admin_session=tok_operator');

  describe.each([
    ['GET status', () => request(server()).get(`${URL}/status`)],
    ['POST setup', () => request(server()).post(`${URL}/setup`).send({})],
    [
      'GET rx/projects',
      () => request(server()).get(`${URL}/rx/projects?format=csv`),
    ],
    [
      'POST import/apply',
      () =>
        request(server())
          .post(`${URL}/import/apply`)
          .send({ communitiesCsv: 'a' }),
    ],
    [
      'POST cx/versions/:vid/approve',
      () =>
        request(server())
          .post(`${URL}/cx/versions/${C1}/approve`)
          .send({ opKey: 'k' }),
    ],
  ] as Array<[string, () => request.Test]>)('%s', (_n, call) => {
    it('без cookie — 401, до sites-backend не доходит', async () => {
      const res = await call().expect(401);
      expect(res.body.success).toBe(false);
      expect(calls).toHaveLength(0);
      expect(adminPanel.assertOperator).not.toHaveBeenCalled();
    });

    it('чужая/просроченная сессия — 401; не оператор — 403; запроса нет', async () => {
      await call().set('Cookie', 'admin_session=tok_nope').expect(401);
      await call().set('Cookie', 'admin_session=tok_user').expect(403);
      expect(calls).toHaveLength(0);
    });
  });

  it('оператор: GET status — конверт, no-store, актор = userId, заголовки секрета', async () => {
    upstream = {
      status: 200,
      body: {
        success: true,
        data: { enabled: true, product: null, gate: null },
        meta: { requestId: 'upstream' },
      },
    };
    const res = await asOp(request(server()).get(`${URL}/status`)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      success: true,
      data: { enabled: true, product: null, gate: null },
    });
    expect(res.body.meta.requestId).not.toBe('upstream');
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/reddit/status',
    );
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['X-Admin-Actor']).toBe(OP);
    expect(h['X-Sites-Internal-Secret']).toBe(SECRET);
    expect(adminPanel.assertOperator).toHaveBeenCalledWith(OP);
  });

  it('статус ответа — как у sites-backend: 201 создания, 200 POST-действия, 202 генерации', async () => {
    for (const [status, path] of [
      [201, `rx/projects`],
      [200, `rx/projects/${C1}/archive`],
      [202, `rx/briefs/${C1}/generate`],
      [200, 'setup'],
    ] as const) {
      upstream = { status, body: { success: true, data: { id: C1 } } };
      const res = await asOp(
        request(server()).post(`${URL}/${path}`).send({ opKey: 'k' }),
      );
      expect(res.status).toBe(status);
      expect(res.body.data).toEqual({ id: C1 });
    }
  });

  it('ошибка Publisher — тот же статус, код и details в конверте генератора', async () => {
    upstream = {
      status: 409,
      body: {
        success: false,
        error: {
          code: 'PUB_GATE_CLOSED',
          message: 'Гейт закрыт',
          details: { gate: 'reddit_publish', missing: ['niche'] },
        },
        meta: { requestId: 'up', path: '/internal/admin/reddit/rx/x' },
      },
    };
    const res = await asOp(
      request(server())
        .post(`${URL}/rx/contents/${C1}/copy`)
        .send({ opKey: 'k' }),
    ).expect(409);
    expect(res.body.error).toEqual({
      code: 'PUB_GATE_CLOSED',
      message: 'Гейт закрыт',
      details: { gate: 'reddit_publish', missing: ['niche'] },
    });
    expect(res.body.meta.path).toBe(`/api/admin/reddit/rx/contents/${C1}/copy`);
  });

  it('401 sites-backend — 502; секрет не уходит в ответ', async () => {
    upstream = { status: 401, body: { error: { code: 'UNAUTHORIZED' } } };
    const res = await asOp(request(server()).get(`${URL}/status`)).expect(502);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('Р-RD-AUD-7: sites-backend не ответил (сеть/таймаут) — 504 UPSTREAM_TIMEOUT в конверте', async () => {
    const real = client.fetchImpl;
    client.fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    try {
      const res = await asOp(
        request(server()).post(`${URL}/rx/projects`).send({ opKey: 'k' }),
      ).expect(504);
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message:
            'Бэкенд клиентских сайтов не ответил вовремя — результат неизвестен, повтор безопасен',
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    } finally {
      client.fetchImpl = real;
    }
  });

  it('не настроено — 503 с понятным текстом', async () => {
    const env = client.env;
    client.env = {};
    try {
      const res = await asOp(request(server()).get(`${URL}/status`)).expect(
        503,
      );
      expect(res.body.error.message).toContain('SITES_BACKEND_URL');
      expect(calls).toHaveLength(0);
    } finally {
      client.env = env;
    }
  });

  it('id не формата sites-backend — 400 без запроса; неизвестный путь и метод — 404 без запроса', async () => {
    await asOp(request(server()).get(`${URL}/rx/projects/a.b`)).expect(400);
    await asOp(
      request(server()).get(`${URL}/rx/projects/..%2F..%2Fstatus`),
    ).expect(400);
    await asOp(
      request(server()).get(`${URL}/params/domain_host/proposals`),
    ).expect(400);
    await asOp(request(server()).get(`${URL}/rx/members`)).expect(404);
    await asOp(request(server()).delete(`${URL}/rx/projects/${C1}`)).expect(
      404,
    );
    await asOp(request(server()).put(`${URL}/setup`).send({})).expect(404);
    await asOp(request(server()).get(`${URL}/rx/projects/${C1}/x/y`)).expect(
      404,
    );
    expect(calls).toHaveLength(0);
  });

  it('list ?format=csv — файл text/csv с именем, без конверта; JSON-список — в конверте', async () => {
    upstream = {
      status: 200,
      text: 'id,title\r\n',
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="reddit-projects.csv"',
      },
    };
    const csv = await asOp(
      request(server()).get(`${URL}/rx/projects?format=csv&evil=1`),
    ).expect(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe(
      'attachment; filename="reddit-projects.csv"',
    );
    expect(csv.headers['cache-control']).toBe('no-store');
    expect(csv.text).toBe('id,title\r\n');
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/reddit/rx/projects?format=csv',
    );
    upstream = {
      status: 200,
      body: { success: true, data: { items: [], nextBefore: null } },
    };
    const json = await asOp(
      request(server()).get(`${URL}/rx/publications?stage=live`),
    ).expect(200);
    expect(json.body).toMatchObject({
      success: true,
      data: { items: [], nextBefore: null },
    });
    expect(typeof json.body.meta.requestId).toBe('string');
  });

  it('импорт: тело ~900 КБ проходит (свой парсер 1 МБ), больше 1 МБ — 413 без запроса', async () => {
    upstream = {
      status: 200,
      body: { success: true, data: { apply: false, items: [] } },
    };
    const body = {
      communitiesCsv: 'subreddit\n' + 'r/test\n'.repeat(130_000),
      opportunitiesCsv: '',
      keywordsCsv: '',
      projectTitle: 'T',
      locale: 'en',
      market: 'US',
    };
    expect(JSON.stringify(body).length).toBeGreaterThan(900_000);
    const ok = await asOp(
      request(server()).post(`${URL}/import/plan`).send(body),
    ).expect(200);
    expect(ok.body.data).toEqual({ apply: false, items: [] });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(body);
    const big = await asOp(
      request(server())
        .post(`${URL}/import/apply`)
        .send({ ...body, communitiesCsv: 'x'.repeat(1024 * 1024) }),
    ).expect(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(calls).toHaveLength(1);
  });

  it('adm-6: тело импорта 1 МБ читается только после CORS и при cookie сессии; без cookie — общий лимит и 401', async () => {
    const mid = { communitiesCsv: 'x'.repeat(150 * 1024) };
    // Без cookie большой парсер не работает: 150 КБ — 413 общего лимита
    // (тело не разбирается до 1 МБ), маленькое тело — 401 гварда.
    const anon = await request(server())
      .post(`${URL}/import/apply`)
      .send(mid)
      .expect(413);
    expect(anon.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    await request(server())
      .post(`${URL}/import/plan`)
      .set('Cookie', 'other=1')
      .send({ communitiesCsv: 'a' })
      .expect(401);
    // Чужой Origin — 403 до разбора тела (битый JSON не даёт 400).
    const foreign = await asOp(
      request(server())
        .post(`${URL}/import/apply`)
        .set('Origin', 'https://evil.example.com')
        .set('Content-Type', 'application/json')
        .send('{"communitiesCsv":'),
    ).expect(403);
    expect(foreign.body.error.code).toBe('ORIGIN_DENIED');
    // С cookie и своим Origin — свой парсер 1 МБ, как раньше.
    upstream = {
      status: 200,
      body: { success: true, data: { apply: false, items: [] } },
    };
    await asOp(
      request(server())
        .post(`${URL}/import/plan`)
        .set('Origin', 'https://admin.example.com')
        .send(mid),
    ).expect(200);
    expect(calls).toHaveLength(1);
    expect(adminPanel.assertOperator).toHaveBeenCalledTimes(1);
  });

  it('прочие маршруты — прежний общий лимит JSON (150 КБ — 413)', async () => {
    await asOp(
      request(server())
        .post(`${URL}/rx/projects`)
        .send({ opKey: 'k', title: 'x'.repeat(150 * 1024) }),
    ).expect(413);
    expect(calls).toHaveLength(0);
  });

  it('v1.2: новые маршруты cx/* — до sites-backend тем же методом и путём', async () => {
    const callId = 'aic_0123456789abcdef01234567';
    upstream = { status: 200, body: { success: true, data: { id: callId } } };
    await asOp(request(server()).get(`${URL}/cx/ai/calls/${callId}`)).expect(
      200,
    );
    upstream = { status: 201, body: { success: true, data: { id: C1 } } };
    await asOp(
      request(server())
        .post(`${URL}/cx/brand-facts`)
        .send({ opKey: 'k', factKey: 'price', kind: 'text', value: 'x' }),
    ).expect(201);
    upstream = { status: 200, body: { success: true, data: { id: C1 } } };
    for (const path of [
      `cx/approvals/${C1}/revoke`,
      `cx/sources/${C1}/revoke`,
      `cx/offers/${C1}/activate`,
      `cx/brand-facts/${C1}/retire`,
      `cx/publications/${C1}/transition`,
    ]) {
      await asOp(
        request(server()).post(`${URL}/${path}`).send({ opKey: 'k' }),
      ).expect(200);
    }
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET https://sites.example.com/internal/admin/reddit/cx/ai/calls/${callId}`,
      'POST https://sites.example.com/internal/admin/reddit/cx/brand-facts',
      `POST https://sites.example.com/internal/admin/reddit/cx/approvals/${C1}/revoke`,
      `POST https://sites.example.com/internal/admin/reddit/cx/sources/${C1}/revoke`,
      `POST https://sites.example.com/internal/admin/reddit/cx/offers/${C1}/activate`,
      `POST https://sites.example.com/internal/admin/reddit/cx/brand-facts/${C1}/retire`,
      `POST https://sites.example.com/internal/admin/reddit/cx/publications/${C1}/transition`,
    ]);
    // Путей, которых нет у контракта (импорт по URL, DELETE), — нет и здесь.
    await asOp(
      request(server()).post(`${URL}/cx/sources/import-url`).send({}),
    ).expect(404);
    await asOp(request(server()).delete(`${URL}/cx/offers/${C1}`)).expect(404);
    expect(calls).toHaveLength(7);
  });

  it('v1.2: источники и факты бренда — выгрузка CSV файлом, query по списку маршрута', async () => {
    upstream = {
      status: 200,
      text: 'id\r\n',
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="publisher-sources.csv"',
      },
    };
    const res = await asOp(
      request(server()).get(
        `${URL}/cx/sources?format=csv&usage=claims&origin=reddit`,
      ),
    ).expect(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="publisher-sources.csv"',
    );
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/reddit/cx/sources?usage=claims&format=csv',
    );
    await asOp(
      request(server()).get(`${URL}/cx/brand-facts?status=active&format=csv`),
    ).expect(200);
    expect(calls[1].url).toBe(
      'https://sites.example.com/internal/admin/reddit/cx/brand-facts?status=active&format=csv',
    );
  });

  it('CSV с другого origin Админки: Content-Disposition и X-Next-Before открыты скрипту; курсор проброшен; JSON-ответы без Expose', async () => {
    const ORIGIN = 'https://admin.example.com';
    upstream = {
      status: 200,
      text: 'id\r\n',
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          'attachment; filename="publisher-reddit-opportunities.csv"',
        'x-next-before': C1,
      },
    };
    const part1 = await asOp(
      request(server())
        .get(`${URL}/rx/opportunities?format=csv&policyNow=ok`)
        .set('Origin', ORIGIN),
    ).expect(200);
    expect(part1.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(part1.headers['access-control-allow-credentials']).toBe('true');
    expect(part1.headers['access-control-expose-headers']).toBe(
      'Content-Disposition, X-Next-Before',
    );
    expect(part1.headers['x-next-before']).toBe(C1);
    upstream = {
      status: 200,
      text: 'id\r\n',
      headers: { 'content-type': 'text/csv' },
    };
    const part2 = await asOp(
      request(server())
        .get(`${URL}/rx/opportunities?format=csv&policyNow=ok&before=${C1}`)
        .set('Origin', ORIGIN),
    ).expect(200);
    expect(part2.headers['x-next-before']).toBeUndefined();
    expect(calls[1].url).toBe(
      `https://sites.example.com/internal/admin/reddit/rx/opportunities?before=${C1}&format=csv&policyNow=ok`,
    );
    upstream = { status: 200, body: { success: true, data: { ok: true } } };
    const json = await asOp(
      request(server()).get(`${URL}/status`).set('Origin', ORIGIN),
    ).expect(200);
    expect(json.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('S3-6: чужой Origin — 403 ORIGIN_DENIED до guard и sites-backend', async () => {
    const res = await asOp(
      request(server())
        .get(`${URL}/rx/projects?format=csv`)
        .set('Origin', 'https://evil.example.com'),
    ).expect(403);
    expect(res.body.error.code).toBe('ORIGIN_DENIED');
    expect(calls).toHaveLength(0);
    expect(prisma.adminSession.findUnique).not.toHaveBeenCalled();
  });
});
