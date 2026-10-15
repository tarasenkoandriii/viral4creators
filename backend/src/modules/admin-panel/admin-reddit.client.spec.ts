/**
 * `AdminRedditClient` и таблица `ADMIN_REDDIT_ROUTES` (пакет P-R-ADM):
 * заголовки, строгий список маршрутов (контроллер ↔ таблица ↔ внутренний
 * контракт v1), проверка параметров, лимиты тел, маппинг ошибок и то, что
 * секрет, тела и query не попадают ни в ошибки, ни в журнал.
 */
import { HttpException, Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminRedditClient } from './admin-reddit.client';
import { AdminRedditController } from './admin-reddit.controller';
import {
  ADMIN_REDDIT_PARAM_KEYS,
  ADMIN_REDDIT_ROUTES,
  AdminRedditRouteName,
  IMPORT_MAX_BODY_BYTES,
  pathParamNames,
} from './admin-reddit.routes';
import type { AdminPanelService } from './admin-panel.service';
import type { AdminAuthenticatedRequest } from '../admin-auth/admin-session.guard';

const SECRET = 'reddit-internal-secret-0123456789';
const OP = 'cm1operator0000000000000a';
const C1 = 'cm1abcdefghijklmnopqrstuv';
const C2 = 'cm1zyxwvutsrqponmlkjihgfe';

type Reply = {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

function client(over: Record<string, string | undefined> = {}) {
  const c = new AdminRedditClient();
  c.env = {
    SITES_BACKEND_URL: 'https://sites.example.com/ignored-path',
    SITES_INTERNAL_SECRET: SECRET,
    ...over,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: Reply = { status: 200, body: { success: true, data: { ok: 1 } } };
  c.fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(reply.text ?? JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers ?? { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    c,
    calls,
    reply: (r: Reply) => {
      reply = r;
    },
  };
}

const ALL = Object.keys(ADMIN_REDDIT_ROUTES) as AdminRedditRouteName[];

/** Валидное значение параметра пути по его имени. */
function sample(param: string): string {
  return param === 'key' ? 'reddit_rules_stale_days' : C1;
}

/** Внутренний контракт v1.2 (`admin-reddit-internal-contract.md`): метод + путь. */
const CONTRACT_V1_2 = [
  'GET status',
  'POST setup',
  'GET params',
  'GET params/:key/proposals',
  'POST params/:key/propose',
  'POST params/:key/decide',
  'POST import/plan',
  'POST import/apply',
  // rx/* — все 40 REDDIT_ROUTES
  'GET rx/projects',
  'POST rx/projects',
  'GET rx/projects/:id',
  'PATCH rx/projects/:id',
  'POST rx/projects/:id/archive',
  'POST rx/projects/:id/restore',
  'GET rx/communities',
  'POST rx/communities',
  'GET rx/communities/:id',
  'PATCH rx/communities/:id',
  'GET rx/communities/:id/rules',
  'GET rx/communities/:id/rules/:sid/source',
  'POST rx/communities/:id/rules',
  'POST rx/rules/:id/review',
  'GET rx/opportunities',
  'POST rx/opportunities',
  'GET rx/opportunities/:id',
  'GET rx/opportunities/:id/excerpts',
  'PATCH rx/opportunities/:id',
  'POST rx/opportunities/:id/score',
  'POST rx/opportunities/:id/qualify',
  'POST rx/opportunities/:id/skip',
  'POST rx/opportunities/:id/archive',
  'GET rx/keywords',
  'POST rx/keywords',
  'PATCH rx/keywords/:id',
  'GET rx/briefs',
  'POST rx/briefs',
  'GET rx/briefs/:id',
  'PATCH rx/briefs/:id',
  'POST rx/briefs/:id/ready',
  'POST rx/briefs/:id/archive',
  'POST rx/briefs/:id/generate',
  'GET rx/briefs/:id/contents',
  'POST rx/briefs/:id/contents',
  'GET rx/contents/:cid',
  'POST rx/contents/:cid/check',
  'POST rx/contents/:cid/copy',
  'POST rx/contents/:cid/report-publication',
  'GET rx/publications',
  // cx/* — студия, только Reddit-материалы
  'GET cx/contents/:cid/versions',
  'POST cx/contents/:cid/versions',
  'GET cx/contents/:cid/versions/:vid',
  'PATCH cx/contents/:cid/versions/:vid',
  'POST cx/contents/:cid/versions/:vid/submit',
  'GET cx/contents/:cid/versions/:a/diff/:b',
  'POST cx/contents/:cid/transition',
  'GET cx/versions/:vid/qa-checks',
  'POST cx/versions/:vid/qa-checks',
  'POST cx/versions/:vid/approve',
  // cx/* v1.2
  'POST cx/approvals/:id/revoke',
  'GET cx/sources',
  'POST cx/sources',
  'POST cx/sources/:id/revoke',
  'GET cx/offers',
  'POST cx/offers',
  'POST cx/offers/:id/activate',
  'GET cx/brand-facts',
  'POST cx/brand-facts',
  'POST cx/brand-facts/:id/activate',
  'POST cx/brand-facts/:id/resolve',
  'POST cx/brand-facts/:id/retire',
  'POST cx/publications/:id/transition',
  'GET cx/ai/calls/:callId',
];

describe('ADMIN_REDDIT_ROUTES — строгий список 1:1 к внутреннему контракту', () => {
  it('таблица = контракт v1.2 (8 служебных + 40 rx + 24 cx), без повторов', () => {
    const table = ALL.map(
      (n) => `${ADMIN_REDDIT_ROUTES[n].method} ${ADMIN_REDDIT_ROUTES[n].path}`,
    );
    expect(new Set(table).size).toBe(table.length);
    expect([...table].sort()).toEqual([...CONTRACT_V1_2].sort());
    expect(table.filter((r) => r.includes(' rx/'))).toHaveLength(40);
    expect(table.filter((r) => r.includes(' cx/'))).toHaveLength(24);
    expect(table).toHaveLength(72);
  });

  it('контроллер объявляет ровно маршруты таблицы: имя метода = имя маршрута, тот же HTTP-метод и путь', () => {
    const proto = AdminRedditController.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(Reflect.getMetadata(PATH_METADATA, AdminRedditController)).toBe(
      'admin/reddit',
    );
    const declared = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .map((k) => ({ k, fn: proto[k] as object }))
      .filter(({ fn }) => Reflect.getMetadata(PATH_METADATA, fn) !== undefined);
    expect(declared.map((d) => d.k).sort()).toEqual([...ALL].sort());
    for (const { k, fn } of declared) {
      const route = ADMIN_REDDIT_ROUTES[k as AdminRedditRouteName];
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(route.path);
      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(
        RequestMethod[route.method],
      );
    }
  });

  it('каждый обработчик контроллера зовёт клиент со СВОИМ маршрутом и параметрами пути', async () => {
    const panel = {
      assertOperator: jest.fn(async () => undefined),
    } as unknown as AdminPanelService;
    const seen: Array<{ name: string; call: Record<string, unknown> }> = [];
    const fake = {
      call: jest.fn(async (name: string, actor: string, call: object) => {
        expect(actor).toBe(OP);
        seen.push({ name, call: call as Record<string, unknown> });
        return { status: 200, data: { ok: name } };
      }),
    } as unknown as AdminRedditClient;
    const ctl = new AdminRedditController(panel, fake) as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      json: jest.fn(),
      send: jest.fn(),
    };
    const req = { userId: OP } as AdminAuthenticatedRequest;
    for (const name of ALL) {
      const route = ADMIN_REDDIT_ROUTES[name];
      const params = pathParamNames(route.path);
      // Порядок аргументов: req, параметры пути, [query], [body], res.
      const args: unknown[] = [req, ...params.map((p) => `${p}-value`)];
      if ('query' in route) args.push({ q: 'x' });
      if (route.method !== 'GET') args.push({ opKey: 'k' });
      args.push(res);
      await ctl[name](...args);
      const last = seen[seen.length - 1];
      expect(last.name).toBe(name);
      expect(last.call.params ?? {}).toEqual(
        Object.fromEntries(params.map((p) => [p, `${p}-value`])),
      );
      expect(last.call.body).toEqual(
        route.method === 'GET' ? undefined : { opKey: 'k' },
      );
      expect(last.call.query).toEqual(
        'query' in route ? { q: 'x' } : undefined,
      );
    }
    expect(seen).toHaveLength(ALL.length);
    expect(panel.assertOperator).toHaveBeenCalledTimes(ALL.length);
  });

  it('клиент строит внутренний адрес только по таблице: тот же путь, тот же метод', async () => {
    const { c, calls } = client();
    for (const name of ALL) {
      const route = ADMIN_REDDIT_ROUTES[name];
      const params = Object.fromEntries(
        pathParamNames(route.path).map((p) => [p, sample(p)]),
      );
      await c.call(name, OP, {
        params,
        ...(route.method !== 'GET' ? { body: { opKey: 'k' } } : {}),
      });
      const expected = route.path.replace(/:(\w+)/g, (_m, p: string) =>
        sample(p),
      );
      const last = calls[calls.length - 1];
      expect(last.url).toBe(
        `https://sites.example.com/internal/admin/reddit/${expected}`,
      );
      expect(last.init.method).toBe(route.method);
    }
  });

  it('имени вне таблицы нет — 400 без запроса (в т.ч. «унаследованные» ключи объекта)', async () => {
    const { c, calls } = client();
    for (const bad of ['proxy', '__proto__', 'constructor', 'toString']) {
      await expect(
        c.call(bad as AdminRedditRouteName, OP),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('AdminRedditClient — вход и заголовки', () => {
  it('без адреса, с коротким секретом или http не-localhost — 503 и ни одного запроса', async () => {
    for (const env of [
      { SITES_BACKEND_URL: undefined },
      { SITES_INTERNAL_SECRET: 'short' },
      { SITES_INTERNAL_SECRET: undefined },
      { SITES_BACKEND_URL: 'http://evil.example.com' },
      { SITES_BACKEND_URL: 'не адрес' },
    ]) {
      const { c, calls } = client(env);
      expect(c.configured()).toBe(false);
      const e = (await c
        .call('status', OP)
        .catch((x: unknown) => x)) as HttpException;
      expect(e.getStatus()).toBe(503);
      expect(JSON.stringify(e.getResponse())).not.toContain(SECRET);
      expect(calls).toHaveLength(0);
    }
  });

  it('localhost и sites-backend по http — можно (стенд, docker compose)', () => {
    for (const u of ['http://localhost:4100', 'http://sites-backend:4100']) {
      expect(client({ SITES_BACKEND_URL: u }).c.configured()).toBe(true);
    }
  });

  it('секрет, оператор, язык и JSON — в заголовках; origin без пути; ответ — data и статус', async () => {
    const { c, calls, reply } = client();
    reply({
      status: 201,
      body: { success: true, data: { id: C1 }, meta: { requestId: 'r' } },
    });
    await expect(
      c.call('createProject', OP, { body: { opKey: 'k', title: 'T' } }),
    ).resolves.toEqual({ status: 201, data: { id: C1 } });
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/reddit/rx/projects',
    );
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['X-Sites-Internal-Secret']).toBe(SECRET);
    expect(h['X-Admin-Actor']).toBe(OP);
    expect(h['Accept-Language']).toBe('ru');
    expect(h['Content-Type']).toBe('application/json');
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      opKey: 'k',
      title: 'T',
    });
  });

  it('GET — без тела и Content-Type; POST без тела — {}', async () => {
    const { c, calls } = client();
    await c.call('status', OP);
    expect(calls[0].init.body).toBeUndefined();
    expect(
      (calls[0].init.headers as Record<string, string>)['Content-Type'],
    ).toBeUndefined();
    await c.call('setup', OP);
    expect(calls[1].init.body).toBe('{}');
  });

  it('актор не в формате контракта — 403 без запроса', async () => {
    const { c, calls } = client();
    for (const bad of ['', 'admin:x', 'a'.repeat(59), 'op\nX-Evil: 1']) {
      await expect(c.call('status', bad)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('AdminRedditClient — параметры пути и query', () => {
  it('id — формат sites-backend `[A-Za-z0-9_-]{1,64}`: обход пути, точка, пробел, кириллица, > 64, пустое — 400 без запроса', async () => {
    const { c, calls } = client();
    for (const bad of [
      '../../etc/passwd',
      '..',
      'a.b',
      '%2e%2e',
      `${C1}/archive`,
      `${C1}?x=1`,
      'a b',
      'ид',
      'x'.repeat(65),
      '',
    ]) {
      await expect(
        c.call('getProject', OP, { params: { id: bad } }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(c.call('getProject', OP, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      c.call('diffVersions', OP, { params: { cid: C1, a: C2, b: 'x.y' } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
    await c.call('diffVersions', OP, { params: { cid: C1, a: C2, b: C1 } });
    expect(calls[0].url).toBe(
      `https://sites.example.com/internal/admin/reddit/cx/contents/${C1}/versions/${C2}/diff/${C1}`,
    );
  });

  it('id не только cuid: вызов AI `aic_<hex>`, восстановленный объект `rs_<hex>` — проходят', async () => {
    const { c, calls } = client();
    const call = 'aic_0123456789abcdef01234567';
    const restored = 'rs_0123456789abcdef01234567';
    await c.call('getAiCall', OP, { params: { callId: call } });
    await c.call('revokeSource', OP, {
      params: { id: restored },
      body: { opKey: 'k', reason: 'отозвано' },
    });
    expect(calls.map((x) => x.url)).toEqual([
      `https://sites.example.com/internal/admin/reddit/cx/ai/calls/${call}`,
      `https://sites.example.com/internal/admin/reddit/cx/sources/${restored}/revoke`,
    ]);
  });

  it('ключ параметра — только из списка гейта reddit_publish и P-R', async () => {
    const { c, calls } = client();
    for (const key of ADMIN_REDDIT_PARAM_KEYS) {
      await c.call('proposeParam', OP, {
        params: { key },
        body: { opKey: 'k', value: {} },
      });
    }
    expect(calls).toHaveLength(ADMIN_REDDIT_PARAM_KEYS.length);
    for (const key of [
      'domain_host',
      'roles',
      'NICHE',
      '../setup',
      'niche%2F..',
    ]) {
      await expect(
        c.call('decideParam', OP, { params: { key }, body: {} }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(ADMIN_REDDIT_PARAM_KEYS.length);
  });

  it('query — только ключи маршрута; пустые пропущены; массив или длинное — 400', async () => {
    const { c, calls } = client();
    await c.call('listOpportunities', OP, {
      query: {
        status: 'new',
        policyNow: 'ok',
        q: 'a&b=c',
        limit: '',
        evil: '1',
        pid: 'cm1other',
      },
    });
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/reddit/rx/opportunities?status=new&q=a%26b%3Dc&policyNow=ok',
    );
    // У маршрута без query в таблице query не уходит вовсе.
    await c.call('getProject', OP, {
      params: { id: C1 },
      query: { format: 'csv' },
    });
    expect(calls[1].url).toBe(
      `https://sites.example.com/internal/admin/reddit/rx/projects/${C1}`,
    );
    for (const query of [{ status: ['a', 'b'] }, { q: 'x'.repeat(201) }]) {
      await expect(c.call('listProjects', OP, { query })).rejects.toMatchObject(
        { status: 400 },
      );
    }
    expect(calls).toHaveLength(2);
  });
});

describe('AdminRedditClient — тела', () => {
  it('тело — только JSON-объект: массив, строка, число — 400 без запроса', async () => {
    const { c, calls } = client();
    for (const body of [[1], 'x', 7]) {
      await expect(c.call('createProject', OP, { body })).rejects.toMatchObject(
        { status: 400 },
      );
    }
    expect(calls).toHaveLength(0);
  });

  it('обычное тело > 256 КБ — 413 без запроса', async () => {
    const { c, calls } = client();
    await expect(
      c.call('patchBrief', OP, {
        params: { id: C1 },
        body: { text: 'x'.repeat(257 * 1024) },
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(calls).toHaveLength(0);
  });

  it('импорт: до 1 МБ уходит целиком, больше — 413 без запроса', async () => {
    const { c, calls } = client();
    const csv = 'subreddit,rules\n' + 'r/test,"rule"\n'.repeat(60_000);
    expect(csv.length).toBeGreaterThan(800 * 1024);
    const body = {
      communitiesCsv: csv,
      opportunitiesCsv: '',
      keywordsCsv: '',
      projectTitle: 'Исследование',
      locale: 'en',
      market: 'US',
    };
    await c.call('importPlan', OP, { body });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(body);
    await expect(
      c.call('importApply', OP, {
        body: { ...body, communitiesCsv: 'x'.repeat(IMPORT_MAX_BODY_BYTES) },
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(calls).toHaveLength(1);
  });
});

describe('AdminRedditClient — ошибки sites-backend', () => {
  it('4xx — тот же статус, код и details (без meta); 404 флага — как есть', async () => {
    const { c, reply } = client();
    reply({
      status: 409,
      body: {
        success: false,
        error: {
          code: 'PUB_CONFLICT',
          message: 'Объект изменился',
          details: { reason: 'revision', currentRevision: 4 },
        },
        meta: { requestId: 'upstream-req', path: '/internal/admin/reddit/x' },
      },
    });
    const e = (await c
      .call('patchProject', OP, { params: { id: C1 }, body: { opKey: 'k' } })
      .catch((x: unknown) => x)) as HttpException;
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      message: 'Объект изменился',
      error: 'PUB_CONFLICT',
      upstreamDetails: { reason: 'revision', currentRevision: 4 },
    });
    reply({
      status: 404,
      body: {
        success: false,
        error: { code: 'PUB_NOT_FOUND', message: 'Не найдено' },
      },
    });
    const nf = (await c
      .call('listProjects', OP)
      .catch((x: unknown) => x)) as HttpException;
    expect(nf.getStatus()).toBe(404);
    expect(nf.getResponse()).toEqual({
      message: 'Не найдено',
      error: 'PUB_NOT_FOUND',
    });
  });

  it('400 валидации — fields доходят; кривой код или пустой текст — свои', async () => {
    const { c, reply } = client();
    reply({
      status: 400,
      body: {
        error: {
          code: 'PUB_VALIDATION',
          message: 'Ошибка',
          details: { fields: [{ field: 'title', code: 'required' }] },
        },
      },
    });
    const e = (await c
      .call('createProject', OP, { body: {} })
      .catch((x: unknown) => x)) as HttpException;
    expect(e.getResponse()).toMatchObject({
      error: 'PUB_VALIDATION',
      upstreamDetails: { fields: [{ field: 'title', code: 'required' }] },
    });
    reply({ status: 422, body: { error: { code: '<script>', message: '' } } });
    const w = (await c
      .call('createProject', OP, { body: {} })
      .catch((x: unknown) => x)) as HttpException;
    expect(w.getStatus()).toBe(422);
    expect(w.getResponse()).toEqual({
      message: 'Запрос отклонён',
      error: 'SITES_BACKEND_ERROR',
    });
    reply({ status: 403, text: 'not json' });
    await expect(
      c.call('createProject', OP, { body: {} }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('401 — 502 «секреты не совпадают»; 500 — 502; 503 без секрета у sites-backend — 502 с понятным текстом', async () => {
    const { c, reply } = client();
    reply({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } });
    const a = (await c
      .call('status', OP)
      .catch((x: unknown) => x)) as HttpException;
    expect(a.getStatus()).toBe(502);
    expect(String(a.message)).toContain('не совпадают');
    reply({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'connect 10.0.0.5:5432' } },
    });
    const b = (await c
      .call('status', OP)
      .catch((x: unknown) => x)) as HttpException;
    expect(b.getStatus()).toBe(502);
    expect(JSON.stringify(b.getResponse())).not.toContain('10.0.0.5');
    reply({
      status: 503,
      body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'закрыт' } },
    });
    const s = (await c
      .call('status', OP)
      .catch((x: unknown) => x)) as HttpException;
    expect(s.getStatus()).toBe(502);
    expect(String(s.message)).toContain('SITES_INTERNAL_SECRET');
  });

  it('503 PUB_BUSY / PUB_AI_UNAVAILABLE — 503 с тем же кодом (повторить), прочие 503 — 502', async () => {
    const { c, reply } = client();
    for (const code of ['PUB_BUSY', 'PUB_AI_UNAVAILABLE']) {
      reply({ status: 503, body: { error: { code, message: 'Повторите' } } });
      const e = (await c
        .call('generateDraft', OP, { params: { id: C1 }, body: {} })
        .catch((x: unknown) => x)) as HttpException;
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse()).toMatchObject({ error: code });
    }
    reply({ status: 503, body: { error: { code: 'OTHER' } } });
    await expect(c.call('status', OP)).rejects.toMatchObject({ status: 502 });
  });

  it('504 самого sites-backend (функция не уложилась в лимит, тело не JSON) — 504 UPSTREAM_TIMEOUT', async () => {
    const { c, reply } = client();
    for (const r of [
      { status: 504, text: 'An error occurred with your deployment' },
      {
        status: 504,
        body: { error: { code: 'FUNCTION_INVOCATION_TIMEOUT', message: 'x' } },
      },
    ]) {
      reply(r);
      const e = (await c
        .call('importApply', OP, { body: {} })
        .catch((x: unknown) => x)) as HttpException;
      expect(e.getStatus()).toBe(504);
      expect(e.getResponse()).toMatchObject({ error: 'UPSTREAM_TIMEOUT' });
    }
  });

  it('сеть и таймаут — 504 UPSTREAM_TIMEOUT (исход неизвестен, повтор безопасен); слишком большой ответ — 502', async () => {
    const { c, reply } = client();
    c.fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const net = (await c
      .call('createProject', OP, { body: { opKey: 'k' } })
      .catch((x: unknown) => x)) as HttpException;
    expect(net.getStatus()).toBe(504);
    expect(net.getResponse()).toEqual({
      message:
        'Бэкенд клиентских сайтов не ответил вовремя — результат неизвестен, повтор безопасен',
      error: 'UPSTREAM_TIMEOUT',
    });

    jest.useFakeTimers();
    try {
      c.fetchImpl = ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as unknown as typeof fetch;
      const p = c.call('status', OP).catch((x: unknown) => x);
      await jest.advanceTimersByTimeAsync(20_001);
      expect(await p).toMatchObject({ status: 504 });
      expect(((await p) as HttpException).getResponse()).toMatchObject({
        error: 'UPSTREAM_TIMEOUT',
      });
    } finally {
      jest.useRealTimers();
    }

    const big = client();
    big.reply({
      status: 200,
      text: 'x',
      headers: { 'content-length': String(9 * 1024 * 1024) },
    });
    await expect(big.c.call('status', OP)).rejects.toMatchObject({
      status: 502,
    });
    void reply;
  });

  it('генерация ждёт 60 с, обычный маршрут — 20 с', async () => {
    jest.useFakeTimers();
    try {
      const { c } = client();
      let aborted = 0;
      c.fetchImpl = ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted++;
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch;
      const gen = c
        .call('generateDraft', OP, { params: { id: C1 }, body: {} })
        .catch((x: unknown) => x);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(aborted).toBe(0);
      await jest.advanceTimersByTimeAsync(30_001);
      expect(await gen).toMatchObject({ status: 504 });
      expect(aborted).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['importPlan', 'importApply'] as const)(
    '%s не обрывается через 60 с и ограничен 240 с',
    async (name) => {
      jest.useFakeTimers();
      try {
        const { c } = client();
        let aborted = false;
        c.fetchImpl = ((_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          })) as unknown as typeof fetch;
        const pending = c.call(name, OP, { body: {} }).catch((e: unknown) => e);
        await jest.advanceTimersByTimeAsync(60_001);
        expect(aborted).toBe(false);
        await jest.advanceTimersByTimeAsync(180_000);
        expect(aborted).toBe(true);
        expect(await pending).toMatchObject({ status: 504 });
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe('AdminRedditClient — секрет и тела не утекают', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const logged = () =>
    [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls]
      .map((c) => c.map(String).join(' '))
      .join('\n');

  it('эхо секрета в тексте и details ошибки — вычищено; журнал — только имя маршрута и статус', async () => {
    const { c, reply } = client();
    reply({
      status: 400,
      body: {
        error: {
          code: 'PUB_VALIDATION',
          message: `header was ${SECRET}`,
          details: {
            fields: [{ field: 'x', code: SECRET }],
            [SECRET]: { nested: [`a${SECRET}b`] },
          },
        },
      },
    });
    const e = (await c
      .call('importPlan', OP, {
        body: { communitiesCsv: 'BODY-MARKER-CSV', projectTitle: 'T' },
      })
      .catch((x: unknown) => x)) as HttpException;
    const out = JSON.stringify(e.getResponse());
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[скрыто]');
    const text = logged();
    expect(text).toContain('reddit.importPlan');
    expect(text).toContain('400');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('BODY-MARKER-CSV');
    expect(text).not.toContain('header was');
  });

  it('успех, сеть и 5xx — в журнале нет секрета, query, тела запроса и ответа', async () => {
    const { c, reply } = client();
    reply({
      status: 200,
      body: { success: true, data: { text: 'RESPONSE-MARKER' } },
    });
    await c.call('listOpportunities', OP, {
      query: { q: 'QUERY-MARKER' },
    });
    reply({ status: 500, body: { error: { message: 'UPSTREAM-MARKER' } } });
    await c
      .call('createRules', OP, {
        params: { id: C1 },
        body: { text: 'BODY-MARKER' },
      })
      .catch(() => undefined);
    c.fetchImpl = (async () => {
      throw new Error(`connect failed ${SECRET}`);
    }) as unknown as typeof fetch;
    await c.call('status', OP).catch(() => undefined);
    const text = logged();
    for (const marker of [
      SECRET,
      'QUERY-MARKER',
      'BODY-MARKER',
      'RESPONSE-MARKER',
      'UPSTREAM-MARKER',
      C1,
    ]) {
      expect(text).not.toContain(marker);
    }
  });

  it('огромные details не пробрасываются (≤ 16 КБ)', async () => {
    const { c, reply } = client();
    reply({
      status: 409,
      body: {
        error: {
          code: 'PUB_CONFLICT',
          message: 'm',
          details: { blob: 'x'.repeat(20 * 1024) },
        },
      },
    });
    const e = (await c
      .call('setup', OP)
      .catch((x: unknown) => x)) as HttpException;
    expect(e.getResponse()).toEqual({ message: 'm', error: 'PUB_CONFLICT' });
  });
});

describe('AdminRedditClient — выгрузка CSV', () => {
  it('список с format=csv — текст и безопасное имя файла', async () => {
    const { c, calls, reply } = client();
    reply({
      status: 200,
      text: 'id,title\r\nc1,"A"\r\n',
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          'attachment; filename="reddit-opportunities-2026-10-14.csv"',
      },
    });
    const out = await c.call('listOpportunities', OP, {
      query: { format: 'csv', policyNow: 'ok' },
    });
    expect(calls[0].url).toContain('?format=csv&policyNow=ok');
    expect(out.csv).toEqual({
      text: 'id,title\r\nc1,"A"\r\n',
      filename: 'reddit-opportunities-2026-10-14.csv',
      nextBefore: null,
    });
    reply({
      status: 200,
      text: 'a',
      headers: {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="../../x;.csv"',
      },
    });
    expect(
      (await c.call('listPublications', OP, { query: { format: 'csv' } })).csv
        ?.filename,
    ).toBe('reddit-listPublications.csv');
  });

  it('у маршрута без выгрузки text/csv не становится файлом', async () => {
    const { c, reply } = client();
    reply({
      status: 200,
      text: 'id\r\n',
      headers: { 'content-type': 'text/csv' },
    });
    const out = await c.call('getProject', OP, { params: { id: C1 } });
    expect(out).toEqual({ status: 200, data: null });
  });

  it('курсор следующей части: X-Next-Before проброшен (только формата id), before уходит в query', async () => {
    const { c, calls, reply } = client();
    const csvReply = (next: string) =>
      reply({
        status: 200,
        text: 'id\r\n',
        headers: { 'content-type': 'text/csv', 'x-next-before': next },
      });
    csvReply(C1);
    const first = await c.call('listBrandFacts', OP, {
      query: { format: 'csv', status: 'active' },
    });
    expect(first.csv?.nextBefore).toBe(C1);
    csvReply('rs_0123456789abcdef01234567');
    const second = await c.call('listBrandFacts', OP, {
      query: { format: 'csv', status: 'active', before: C1 },
    });
    expect(second.csv?.nextBefore).toBe('rs_0123456789abcdef01234567');
    expect(calls[1].url).toBe(
      `https://sites.example.com/internal/admin/reddit/cx/brand-facts?status=active&before=${C1}&format=csv`,
    );
    for (const bad of ['a.b', '../x', 'x'.repeat(65)]) {
      csvReply(bad);
      const out = await c.call('listProjects', OP, {
        query: { format: 'csv' },
      });
      expect(out.csv?.nextBefore).toBeNull();
    }
  });

  it('before принимают все списки с выгрузкой', () => {
    for (const name of Object.keys(
      ADMIN_REDDIT_ROUTES,
    ) as AdminRedditRouteName[]) {
      const r = ADMIN_REDDIT_ROUTES[name] as {
        csv?: true;
        query?: readonly string[];
      };
      if (!r.csv) continue;
      expect(r.query).toEqual(expect.arrayContaining(['before', 'format']));
    }
  });
});
