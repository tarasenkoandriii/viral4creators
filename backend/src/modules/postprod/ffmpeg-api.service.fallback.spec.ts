/**
 * Fallback selfhosted → hosted без двойного рендера — сценарии аудита
 * INT (doc/reports/ffmpeg-server-audit-2026-10-21, FF-INT-01/02/03/07/08/
 * 09/10/11) против настоящего `FfmpegApiService`, настоящего `fetch` и
 * HTTP-моков своего сервера (с `X-FFmpeg-Server: 1`, как ffmpeg-server) и
 * hosted. Главная метрика каждого сценария — `renders`: сколько задач
 * получили провайдеры на одну операцию (должно быть ≤ 1).
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { FfmpegApiService } from './ffmpeg-api.service';
import { planSlideshow } from '../tutorial-runner/tutorial-video-assembly';

jest.setTimeout(60_000);

// ── фейковая БД (только то, что трогает сервис) ─────────────────────

type Row = Record<string, unknown>;
function cond(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Row[]).some((w) => cond(row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (cond(row, v as Row)) return false;
      continue;
    }
    const cur = row[k] as unknown;
    if (v === null) {
      if (cur !== null && cur !== undefined) return false;
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      const n = (x: unknown) =>
        x instanceof Date ? x.getTime() : (x as number);
      if (cur === null || cur === undefined) return false;
      if ('gte' in o && !(n(cur) >= n(o.gte))) return false;
      if ('gt' in o && !(n(cur) > n(o.gt))) return false;
      if ('lt' in o && !(n(cur) < n(o.lt))) return false;
      continue;
    }
    if (cur !== v) return false;
  }
  return true;
}
function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row))
      row[k] = (row[k] as number) + ((v as Row).increment as number);
    else row[k] = v;
  }
}
function fakePrisma(routing: Row = {}, opts: { subsDown?: boolean } = {}) {
  const r: Row = {
    id: 'default',
    revision: 1,
    defaultProvider: 'selfhosted',
    canaryProducts: [],
    updatedAt: new Date(),
    updatedBy: null,
    breakerFailures: 0,
    breakerLastFailureAt: null,
    breakerOpenUntil: null,
    breakerProbeUntil: null,
    breakerProbeJobId: null,
    ...routing,
  };
  const subs = new Map<string, Row>();
  const counted = new Set<string>();
  const events: Row[] = [];
  const calls = { db: 0 };
  const tick = () => calls.db++;
  return {
    routing: r,
    subs,
    counted,
    events,
    calls,
    ffmpegRouting: {
      findUnique: jest.fn(async () => (tick(), { ...r })),
      updateMany: jest.fn(async (a: { where: Row; data: Row }) => {
        tick();
        if (!cond(r, a.where)) return { count: 0 };
        apply(r, a.data);
        return { count: 1 };
      }),
    },
    ffmpegBreakerJob: {
      create: jest.fn(async (a: { data: { jobId: string } }) => {
        tick();
        if (counted.has(a.data.jobId))
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        counted.add(a.data.jobId);
        return a.data;
      }),
    },
    ffmpegSubmission: {
      findUnique: jest.fn(async (a: { where: { idempotencyKey: string } }) => {
        tick();
        if (opts.subsDown) throw new Error('db down');
        const row = subs.get(a.where.idempotencyKey);
        return row ? { ...row } : null;
      }),
      upsert: jest.fn(
        async (a: {
          where: { idempotencyKey: string };
          create: Row;
          update: Row;
        }) => {
          tick();
          const cur = subs.get(a.where.idempotencyKey);
          if (cur) apply(cur, a.update);
          else subs.set(a.where.idempotencyKey, { ...a.create });
          return subs.get(a.where.idempotencyKey);
        },
      ),
      updateMany: jest.fn(
        async (a: { where: { idempotencyKey: string }; data: Row }) => {
          tick();
          const cur = subs.get(a.where.idempotencyKey);
          if (!cur) return { count: 0 };
          apply(cur, a.data);
          return { count: 1 };
        },
      ),
    },
    ffmpegFallbackEvent: {
      create: jest.fn(async (a: { data: Row }) => {
        tick();
        events.push(a.data);
        return a.data;
      }),
    },
  };
}

// ── HTTP-моки ─────────────────────────────────────────────────────

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
) => void | 'done';
interface Mock {
  base: string;
  log: Array<{ method: string; url: string; key: string; t: number }>;
  close: () => Promise<void>;
}
async function mock(handler: Handler): Promise<Mock> {
  const log: Mock['log'] = [];
  const srv: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const key = String(req.headers['idempotency-key'] ?? '');
      log.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        key,
        t: Date.now(),
      });
      handler(req, res, key);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api`,
    log,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections?.();
        srv.close(() => r());
      }),
  };
}
const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  server = true,
) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(server ? { 'x-ffmpeg-server': '1' } : {}),
  });
  res.end(JSON.stringify(body));
};
const proxy404 = (res: ServerResponse) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404 page not found\n');
};

type SubmitAct =
  | 'accept'
  | 'accept-then-reset'
  | 'reset'
  | 'hang'
  | { commitAfterMs: number }
  | { status: number; body: unknown; server?: boolean };

/** Свой сервер: задачи по ключу, by-key — по ним (как ffmpeg-server). */
async function selfServer(o: {
  submit: () => SubmitAct;
  byKey?: (
    key: string,
    jobs: Map<string, string>,
  ) => 'proxy404' | { status: number; body: unknown } | null;
  status?: (id: string) => unknown;
}) {
  const jobs = new Map<string, string>();
  let n = 0;
  const m = await mock((req, res, key) => {
    if (req.method === 'POST' && req.url === '/api/ffmpeg') {
      const act = o.submit();
      if (act === 'accept') {
        if (!jobs.has(key)) jobs.set(key, `s${++n}`);
        return send(res, 202, {
          data: { id: jobs.get(key), status: 'queued' },
        });
      }
      if (act === 'accept-then-reset') {
        if (!jobs.has(key)) jobs.set(key, `s${++n}`);
        return void req.socket.destroy();
      }
      if (act === 'reset') return void req.socket.destroy();
      if (act === 'hang') return;
      if ('commitAfterMs' in act) {
        setTimeout(() => {
          if (!jobs.has(key)) jobs.set(key, `s${++n}`);
        }, act.commitAfterMs);
        return void req.socket.destroy();
      }
      return send(res, act.status, act.body, act.server ?? true);
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/jobs/by-key/')) {
      const k = decodeURIComponent(req.url.slice('/api/jobs/by-key/'.length));
      const custom = o.byKey?.(k, jobs);
      if (custom === 'proxy404') return proxy404(res);
      if (custom) return send(res, custom.status, custom.body);
      if (jobs.has(k))
        return send(res, 200, { data: { id: jobs.get(k), status: 'queued' } });
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no' } });
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/jobs/')) {
      const id = req.url.slice('/api/jobs/'.length);
      return send(
        res,
        200,
        o.status?.(id) ?? {
          data: {
            status: 'succeeded',
            output_files: { 'o.mp4': 'https://s/o' },
          },
        },
      );
    }
    send(res, 404, { error: { code: 'NOT_FOUND' } });
  });
  return Object.assign(m, { jobs });
}
async function hostedServer(status?: () => unknown) {
  let n = 0;
  return mock((req, res) => {
    if (req.method === 'POST')
      return send(
        res,
        202,
        { data: { id: `h${++n}`, status: 'queued' } },
        false,
      );
    send(
      res,
      200,
      status?.() ?? { data: { status: 'succeeded', output_files: {} } },
      false,
    );
  });
}

const JOB = (k = 'a') => ({
  inputs: { source: `https://blob.example/${k}.mp4` },
  outputs: ['out.mp4'],
  commands: ['-i {{source}} {{out.mp4}}'],
});
const posts = (m: Mock) => m.log.filter((e) => e.method === 'POST').length;
const byKeys = (m: Mock) => m.log.filter((e) => e.url.includes('/by-key/'));
async function attempt<T>(p: Promise<T>) {
  try {
    return { ok: await p, err: null as string | null };
  } catch (e) {
    return { ok: null, err: (e as Error).message };
  }
}

const savedEnv = { ...process.env };
afterAll(() => {
  process.env = savedEnv;
});

async function scenario(
  o: Parameters<typeof selfServer>[0] & {
    routing?: Row;
    subsDown?: boolean;
    env?: Record<string, string>;
    hostedStatus?: () => unknown;
  },
  fn: (c: {
    svc: FfmpegApiService;
    db: ReturnType<typeof fakePrisma>;
    self: Awaited<ReturnType<typeof selfServer>>;
    hosted: Mock;
  }) => Promise<void>,
) {
  const self = await selfServer(o);
  const hosted = await hostedServer(o.hostedStatus);
  process.env = {
    ...savedEnv,
    FFMPEG_API_BASE_URL: hosted.base,
    FFMPEG_API_KEY: 'hk',
    FFMPEG_SELFHOSTED_ENABLED: 'true',
    FFMPEG_SELFHOSTED_BASE_URL: self.base,
    FFMPEG_SELFHOSTED_KEY: 'sk',
    // Короткий дедлайн фиксации сервера: сверка доказательна через ~3 с.
    FFMPEG_SELFHOSTED_COMMIT_DEADLINE_MS: '1000',
    FFMPEG_SELFHOSTED_COMMIT_MARGIN_MS: '2000',
    ...(o.env ?? {}),
  };
  delete process.env.FFMPEG_FALLBACK_HOSTED;
  if (o.env?.FFMPEG_FALLBACK_HOSTED)
    process.env.FFMPEG_FALLBACK_HOSTED = o.env.FFMPEG_FALLBACK_HOSTED;
  const db = fakePrisma(o.routing, { subsDown: o.subsDown });
  const svc = new FfmpegApiService(
    db as unknown as ConstructorParameters<typeof FfmpegApiService>[0],
  );
  Object.assign(svc, { reconcileStepMs: 100, reconcileMaxMs: 1_500 });
  try {
    await fn({ svc, db, self, hosted });
  } finally {
    await self.close();
    await hosted.close();
  }
}

describe('доказанный отказ до приёма → hosted тем же телом (ответ сервера)', () => {
  it.each([
    [503, 'NOT_READY'],
    [503, 'NOT_ACCEPTING'],
    [503, 'SUBMIT_DEADLINE'],
    [429, 'QUEUE_FULL'],
    [429, 'CLIENT_QUOTA_EXCEEDED'],
    [422, 'UNSUPPORTED_COMMAND'],
    [403, 'FORBIDDEN_SOURCE'],
  ])('%i %s', async (status, code) => {
    await scenario(
      { submit: () => ({ status, body: { error: { code, message: 'x' } } }) },
      async ({ svc, db, self, hosted }) => {
        const ref = await svc.submit({ ...JOB(), product: 'postprod' });
        expect(ref.provider).toBe('hosted');
        expect(db.routing.breakerFailures).toBe(
          ['UNSUPPORTED_COMMAND', 'FORBIDDEN_SOURCE'].includes(String(code))
            ? 0
            : 1,
        );
        expect([posts(self), posts(hosted), byKeys(self).length]).toEqual([
          1, 1, 0,
        ]);
        expect(db.events).toEqual([
          expect.objectContaining({ reason: 'refused', code }),
        ]);
        // Fallback записан в ту же строку отправки.
        expect([...db.subs.values()]).toEqual([
          expect.objectContaining({
            provider: 'hosted',
            state: 'accepted',
            jobId: 'h1',
            fallbackReason: 'refused',
          }),
        ]);
      },
    );
  });

  it('30-frame Tutorial profile refusal submits only one hosted render', async () => {
    const plan = planSlideshow(
      Array.from({ length: 30 }, (_, stepIndex) => ({
        stepIndex,
        url: `https://blob.example/frame${stepIndex}.png`,
        seconds: 2,
      })),
      { motion: 'none' },
    )!;
    expect(Object.keys(plan.inputs)).toHaveLength(30);
    await scenario(
      {
        submit: () => ({
          status: 422,
          body: {
            error: {
              code: 'UNSUPPORTED_COMMAND',
              message: 'too many inputs (max 20)',
            },
          },
        }),
      },
      async ({ svc, self, hosted, db }) => {
        const ref = await svc.submit({
          ...plan,
          product: 'tutorial-runner',
          operationKey: 'tutorial:30',
        });
        expect(ref.provider).toBe('hosted');
        expect(self.jobs.size).toBe(0);
        expect(posts(hosted)).toBe(1);
        expect(db.routing.breakerFailures).toBe(0);
      },
    );
  });

  it('ECONNREFUSED → hosted', async () => {
    await scenario({ submit: () => 'accept' }, async ({ svc, hosted }) => {
      // Порт, на котором точно никто не слушает (9 fetch запрещает сам).
      const closed = await mock(() => undefined);
      await closed.close();
      process.env.FFMPEG_SELFHOSTED_BASE_URL = closed.base;
      const ref = await svc.submit(JOB());
      expect(ref.provider).toBe('hosted');
      expect(posts(hosted)).toBe(1);
    });
  });

  it('503 RECOVERY (FF-INT-03) — без fallback и без повтора', async () => {
    await scenario(
      {
        submit: () => ({ status: 503, body: { error: { code: 'RECOVERY' } } }),
      },
      async ({ svc, db, hosted }) => {
        const r = await attempt(
          svc.submit({ ...JOB(), operationKey: 'op-rec' }),
        );
        expect(r.err).toMatch(/503/);
        expect(posts(hosted)).toBe(0);
        expect(db.subs.get('op-rec')).toMatchObject({
          provider: 'selfhosted',
          state: 'unknown',
        });
      },
    );
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [409, 'IDEMPOTENCY_CONFLICT'],
    [422, 'INVALID_COMMAND'],
    [403, 'FORBIDDEN'],
  ])('%i %s — наша ошибка: без fallback и без сверки', async (status, code) => {
    await scenario(
      { submit: () => ({ status, body: { error: { code } } }) },
      async ({ svc, self, hosted }) => {
        const r = await attempt(svc.submit(JOB()));
        expect(r.err).toMatch(new RegExp(`ffmpeg api ${status}`));
        expect(posts(hosted)).toBe(0);
        expect(byKeys(self)).toHaveLength(0);
      },
    );
  });
});

describe('неизвестный исход → сверка by-key (FF-INT-01, FF-INT-09)', () => {
  it('обрыв после приёма → найдено по ключу → без hosted (renders=1)', async () => {
    await scenario(
      { submit: () => 'accept-then-reset' },
      async ({ svc, self, hosted }) => {
        const ref = await svc.submit({ ...JOB(), operationKey: 'op-b' });
        expect(ref).toMatchObject({
          jobId: 'selfhosted:s1',
          provider: 'selfhosted',
        });
        expect(posts(hosted)).toBe(0);
        expect(self.jobs.size + posts(hosted)).toBe(1);
      },
    );
  });

  it('обрыв без приёма → 404 сервера ПОСЛЕ дедлайна фиксации → hosted', async () => {
    await scenario(
      { submit: () => 'reset' },
      async ({ svc, self, hosted, db }) => {
        const t0 = Date.now();
        const ref = await svc.submit({ ...JOB(), operationKey: 'op-c' });
        expect(ref.provider).toBe('hosted');
        const conclusive = byKeys(self).at(-1)!;
        // 1 с дедлайн + 2 с запас.
        expect(conclusive.t - t0).toBeGreaterThanOrEqual(2_900);
        expect(self.jobs.size + posts(hosted)).toBe(1);
        expect(db.events).toEqual([
          expect.objectContaining({ reason: 'not-found' }),
        ]);
      },
    );
  });

  it('медленная фиксация: запись появляется после первого 404 → найдено, без hosted', async () => {
    await scenario(
      { submit: () => ({ commitAfterMs: 800 }) },
      async ({ svc, self, hosted }) => {
        const ref = await svc.submit({ ...JOB(), operationKey: 'op-slow' });
        expect(ref.provider).toBe('selfhosted');
        expect(posts(hosted)).toBe(0);
        expect(self.jobs.size).toBe(1);
      },
    );
  });

  it('404 прокси (Traefik «404 page not found») — не «нет записи»: ошибка без hosted (probe-proxy404)', async () => {
    await scenario(
      { submit: () => 'accept-then-reset', byKey: () => 'proxy404' },
      async ({ svc, self, hosted, db }) => {
        const r = await attempt(
          svc.submit({
            ...JOB(),
            product: 'story',
            retrySubmit: false,
            operationKey: 'story-video:r1',
          }),
        );
        expect(r.err).toBeTruthy();
        expect(posts(hosted)).toBe(0);
        expect(self.jobs.size + posts(hosted)).toBe(1);
        expect(db.subs.get('story-video:r1')).toMatchObject({
          state: 'unknown',
        });
      },
    );
  });

  it('5xx/HTML прокси на POST — неизвестный исход, а не отказ', async () => {
    await scenario(
      {
        submit: () => ({ status: 502, body: 'bad gateway', server: false }),
        byKey: () => ({ status: 500, body: {} }),
      },
      async ({ svc, hosted }) => {
        const r = await attempt(svc.submit(JOB()));
        expect(r.err).toBeTruthy();
        expect(posts(hosted)).toBe(0);
      },
    );
  });

  it('сверка в recovery (503 RECOVERY) — ошибка, без hosted', async () => {
    await scenario(
      {
        submit: () => 'reset',
        byKey: () => ({ status: 503, body: { error: { code: 'RECOVERY' } } }),
      },
      async ({ svc, hosted }) => {
        const r = await attempt(svc.submit(JOB()));
        expect(r.err).toBeTruthy();
        expect(posts(hosted)).toBe(0);
      },
    );
  });
});

describe('отправка закреплена за операцией (FF-INT-02, ffmpeg_submissions)', () => {
  it('3 неизвестных исхода открывают breaker; повтор op-1 сверяется у своего сервера → без hosted (renders=1)', async () => {
    let byKeyDown = true;
    await scenario(
      {
        submit: () => 'accept-then-reset',
        byKey: () =>
          byKeyDown
            ? { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
            : null,
      },
      async ({ svc, db, self, hosted }) => {
        for (const k of ['op-1', 'op-2', 'op-3'])
          expect(
            (await attempt(svc.submit({ ...JOB(k), operationKey: k }))).err,
          ).toBeTruthy();
        expect((db.routing.breakerOpenUntil as Date).getTime()).toBeGreaterThan(
          Date.now(),
        );
        // Сверка всё ещё недоступна — повтор не уходит никуда.
        const blocked = await attempt(
          svc.submit({ ...JOB('op-1'), operationKey: 'op-1' }),
        );
        expect(blocked.err).toMatch(/не сверена/);
        expect(posts(hosted)).toBe(0);
        // Сверка вернулась — та же задача своего сервера.
        byKeyDown = false;
        const ref = await svc.submit({ ...JOB('op-1'), operationKey: 'op-1' });
        expect(ref.jobId).toBe(`selfhosted:${self.jobs.get('op-1')}`);
        expect(posts(hosted)).toBe(0);
        expect(posts(self)).toBe(3);
      },
    );
  });

  it('после rollback (default=hosted) повтор операции с неизвестным исходом — сначала свой сервер', async () => {
    let byKeyDown = true;
    await scenario(
      {
        submit: () => 'accept-then-reset',
        byKey: () =>
          byKeyDown
            ? { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
            : null,
      },
      async ({ svc, db, self, hosted }) => {
        await attempt(svc.submit({ ...JOB('r1'), operationKey: 'op-r1' }));
        db.routing.defaultProvider = 'hosted';
        process.env.FFMPEG_SELFHOSTED_ENABLED = 'false';
        byKeyDown = false;
        const ref = await svc.submit({ ...JOB('r1'), operationKey: 'op-r1' });
        expect(ref.provider).toBe('selfhosted');
        expect(posts(hosted)).toBe(0);
        expect(self.jobs.size).toBe(1);
      },
    );
  });

  it('принятая своим сервером операция → прежний jobId без нового submit', async () => {
    await scenario({ submit: () => 'accept' }, async ({ svc, self }) => {
      const a = await svc.submit({ ...JOB(), operationKey: 'op-acc' });
      const b = await svc.submit({ ...JOB(), operationKey: 'op-acc' });
      expect(b.jobId).toBe(a.jobId);
      expect(posts(self)).toBe(1);
    });
  });

  it('операция уже у hosted (fallback) — повтор туда же, без своего сервера', async () => {
    let n = 0;
    await scenario(
      {
        submit: () =>
          n++ === 0
            ? { status: 503, body: { error: { code: 'NOT_READY' } } }
            : 'accept',
      },
      async ({ svc, self, hosted }) => {
        await svc.submit({ ...JOB(), operationKey: 'op-h' });
        const again = await svc.submit({ ...JOB(), operationKey: 'op-h' });
        expect(again.provider).toBe('hosted');
        expect([posts(self), posts(hosted)]).toEqual([1, 2]);
      },
    );
  });

  it('свой сервер не настроен — к БД не обращаемся (hosted как до перехода)', async () => {
    await scenario({ submit: () => 'accept' }, async ({ svc, db, hosted }) => {
      delete process.env.FFMPEG_SELFHOSTED_BASE_URL;
      delete process.env.FFMPEG_SELFHOSTED_ENABLED;
      await svc.submit({ ...JOB(), operationKey: 'k' });
      await svc.status('legacy-1');
      expect(db.calls.db).toBe(0);
      expect(posts(hosted)).toBe(1);
    });
  });
});

describe('breaker: half-open с одной пробой, окно, учёт один раз (FF-INT-07/08)', () => {
  it('после истечения из 5 параллельных к своему серверу уходит ровно одна проба', async () => {
    await scenario(
      {
        submit: () => 'accept',
        routing: {
          breakerFailures: 3,
          breakerLastFailureAt: new Date(),
          breakerOpenUntil: new Date(Date.now() - 1000),
        },
      },
      async ({ svc, db, self, hosted }) => {
        const refs = await Promise.all(
          [1, 2, 3, 4, 5].map((i) => svc.submit(JOB(`p${i}`))),
        );
        expect(posts(self)).toBe(1);
        expect(posts(hosted)).toBe(4);
        const probe = refs.find((r) => r.provider === 'selfhosted')!;
        expect(db.routing.breakerProbeJobId).toBe(probe.jobId);
        // Завершение НЕ пробной задачи breaker не закрывает…
        await svc.status('selfhosted:other');
        expect(db.routing.breakerFailures).toBe(3);
        // …а пробной — закрывает.
        await svc.status(probe.jobId);
        expect(db.routing).toMatchObject({
          breakerFailures: 0,
          breakerOpenUntil: null,
          breakerProbeUntil: null,
          breakerProbeJobId: null,
        });
      },
    );
  });

  it('провал пробы открывает breaker заново', async () => {
    await scenario(
      {
        submit: () => ({ status: 503, body: { error: { code: 'NOT_READY' } } }),
        routing: {
          breakerFailures: 3,
          breakerLastFailureAt: new Date(),
          breakerOpenUntil: new Date(Date.now() - 1000),
        },
      },
      async ({ svc, db }) => {
        await svc.submit(JOB());
        expect((db.routing.breakerOpenUntil as Date).getTime()).toBeGreaterThan(
          Date.now() + 9 * 60_000,
        );
      },
    );
  });

  it('отказы старше окна не копятся: 2 часовой давности + 1 новый — не открывает', async () => {
    await scenario(
      {
        submit: () => ({ status: 503, body: { error: { code: 'NOT_READY' } } }),
        routing: {
          breakerFailures: 2,
          breakerLastFailureAt: new Date(Date.now() - 3600_000),
        },
      },
      async ({ svc, db }) => {
        await svc.submit(JOB());
        expect(db.routing.breakerFailures).toBe(1);
        expect(db.routing.breakerOpenUntil).toBeNull();
      },
    );
  });

  it('инфраструктурный провал одной задачи учитывается один раз при любом числе опросов', async () => {
    await scenario(
      {
        submit: () => 'accept',
        status: () => ({
          data: { status: 'failed', error_code: 'OOM', error_message: '' },
        }),
      },
      async ({ svc, db }) => {
        const st = await svc.status('selfhosted:x1');
        await Promise.all([1, 2, 3].map(() => svc.status('selfhosted:x1')));
        expect(st).toMatchObject({ errorCode: 'OOM', retryOnFallback: true });
        expect(db.routing.breakerFailures).toBe(1);
      },
    );
  });
});

describe('Story (retrySubmit: false) — общий бюджет 25 с (FF-INT-11)', () => {
  it('сервер завис: отправка обрывается после дедлайна + запас, сверка, hosted — всё в 25 с', async () => {
    await scenario({ submit: () => 'hang' }, async ({ svc, self, hosted }) => {
      const t0 = Date.now();
      const ref = await svc.submit({
        ...JOB(),
        product: 'story',
        retrySubmit: false,
        operationKey: 'story-video:s',
      });
      const total = Date.now() - t0;
      expect(ref.provider).toBe('hosted');
      expect(total).toBeLessThan(25_000);
      // Тайм-аут своей отправки: 1 с дедлайн + 2 с запас + 1 с, а не 25 с.
      expect(byKeys(self)[0].t - t0).toBeLessThan(6_000);
      expect([posts(self), posts(hosted)]).toEqual([1, 1]);
    });
  });
});

describe('hosted status — разбор как до перехода (FF-INT-10)', () => {
  it('error_code hosted не превращается в текст и в errorCode', async () => {
    await scenario(
      {
        submit: () => 'accept',
        hostedStatus: () => ({
          data: { status: 'failed', error_code: 'TIMEOUT', error_message: '' },
        }),
      },
      async ({ svc }) => {
        await expect(svc.status('legacy-9')).resolves.toEqual({
          status: 'failed',
          outputs: undefined,
          error: undefined,
        });
      },
    );
  });
});

describe('повтор после терминального провала — новая попытка (FF-INT-14)', () => {
  const oom = () => ({
    data: { status: 'failed', error_code: 'OOM', error_message: '' },
  });

  it('портфолио после OOM при открытом breaker → hosted, ровно один новый рендер', async () => {
    await scenario(
      { submit: () => 'accept', status: oom },
      async ({ svc, db, self, hosted }) => {
        const a = await svc.submit({ ...JOB(), product: 'portfolio' });
        const st = await svc.status(a.jobId);
        expect(st.retryOnFallback).toBe(true);
        // Breaker открыт (например, предыдущими провалами).
        Object.assign(db.routing, {
          breakerFailures: 3,
          breakerLastFailureAt: new Date(),
          breakerOpenUntil: new Date(Date.now() + 600_000),
        });
        const b = await svc.submit({ ...JOB(), product: 'portfolio' });
        expect(b.provider).toBe('hosted');
        expect([posts(self), posts(hosted)]).toEqual([1, 1]);
        expect([...db.subs.values()][0]).toMatchObject({
          provider: 'hosted',
          attempt: 1,
          state: 'accepted',
        });
      },
    );
  });

  it('breaker закрыт → своему серверу с ключом попытки <ключ>:r1, новый рендер', async () => {
    await scenario(
      { submit: () => 'accept', status: oom },
      async ({ svc, self, hosted }) => {
        const a = await svc.submit({ ...JOB(), operationKey: 'portfolio:i1' });
        await svc.status(a.jobId);
        const b = await svc.submit({ ...JOB(), operationKey: 'portfolio:i1' });
        expect(b.jobId).not.toBe(a.jobId);
        expect(
          self.log.filter((e) => e.method === 'POST').map((e) => e.key),
        ).toEqual(['portfolio:i1', 'portfolio:i1:r1']);
        expect(posts(hosted)).toBe(0);
      },
    );
  });

  it.each(['OUTPUT_EXPIRED', 'OUTPUT_PURGED'])(
    '%s при execution_status: succeeded — прежний jobId, без нового рендера (ТЗ §5.3)',
    async (code) => {
      await scenario(
        {
          submit: () => 'accept',
          status: () => ({
            data: {
              status: 'failed',
              error_code: code,
              execution_status: 'succeeded',
              output_files: {},
            },
          }),
        },
        async ({ svc, self, hosted }) => {
          const a = await svc.submit({ ...JOB(), operationKey: 'op-exp' });
          const st = await svc.status(a.jobId);
          expect(st).toMatchObject({
            status: 'failed',
            errorCode: code,
            executionSucceeded: true,
          });
          const b = await svc.submit({ ...JOB(), operationKey: 'op-exp' });
          expect(b.jobId).toBe(a.jobId);
          expect([posts(self), posts(hosted)]).toEqual([1, 0]);
        },
      );
    },
  );

  it('canceled / INTERRUPTED (исполнение не завершилось) — новая попытка', async () => {
    await scenario(
      {
        submit: () => 'accept',
        status: () => ({
          data: {
            status: 'canceled',
            error_code: 'CANCELED',
            execution_status: 'canceled',
          },
        }),
      },
      async ({ svc, self }) => {
        const a = await svc.submit({ ...JOB(), operationKey: 'op-can' });
        const b = await svc.submit({ ...JOB(), operationKey: 'op-can' });
        expect(b.jobId).not.toBe(a.jobId);
        expect(
          self.log.filter((e) => e.method === 'POST').map((e) => e.key),
        ).toEqual(['op-can', 'op-can:r1']);
      },
    );
  });

  it('задача ещё идёт — тот же jobId, без новой отправки', async () => {
    await scenario(
      {
        submit: () => 'accept',
        status: () => ({ data: { status: 'processing' } }),
      },
      async ({ svc, self }) => {
        const a = await svc.submit({ ...JOB(), operationKey: 'op-run' });
        const b = await svc.submit({ ...JOB(), operationKey: 'op-run' });
        expect(b.jobId).toBe(a.jobId);
        expect(posts(self)).toBe(1);
      },
    );
  });
});

describe('гейт выключен: путь hosted без записи в БД (FF-INT-15, probe-gateoff-db)', () => {
  it('БД недоступна — hosted всё равно отправляется', async () => {
    await scenario(
      {
        submit: () => 'accept',
        subsDown: true,
        env: { FFMPEG_SELFHOSTED_ENABLED: 'false' },
      },
      async ({ svc, self, hosted }) => {
        const r = await svc.submit(JOB());
        expect(r.provider).toBe('hosted');
        expect([posts(self), posts(hosted)]).toEqual([0, 1]);
      },
    );
  });

  it('БД жива — ни одной записи; breaker-таблицы не трогаются', async () => {
    await scenario(
      { submit: () => 'accept', env: { FFMPEG_SELFHOSTED_ENABLED: 'false' } },
      async ({ svc, db }) => {
        await svc.submit(JOB());
        await svc.submit(JOB('b'));
        expect(db.subs.size).toBe(0);
        expect(db.ffmpegSubmission.upsert).not.toHaveBeenCalled();
        expect(db.ffmpegSubmission.updateMany).not.toHaveBeenCalled();
        expect(db.ffmpegRouting.findUnique).not.toHaveBeenCalled();
        expect(db.ffmpegRouting.updateMany).not.toHaveBeenCalled();
      },
    );
  });

  it('у операции уже есть selfhosted-строка (rollback гейтом) — сначала сверка у своего сервера', async () => {
    await scenario(
      {
        submit: () => 'accept-then-reset',
        byKey: () => ({ status: 503, body: {} }),
      },
      async ({ svc, self, hosted }) => {
        await attempt(svc.submit({ ...JOB(), operationKey: 'op-g' }));
        process.env.FFMPEG_SELFHOSTED_ENABLED = 'false';
        const blocked = await attempt(
          svc.submit({ ...JOB(), operationKey: 'op-g' }),
        );
        expect(blocked.err).toMatch(/не сверена/);
        expect(posts(hosted)).toBe(0);
        expect(self.jobs.size).toBe(1);
      },
    );
  });
});

describe('запас сверки по умолчанию — дедлайн + 5 с (FF-INT-09)', () => {
  it('«нет записи» принимается не раньше sentAt + 1 с + 5 с', async () => {
    await scenario({ submit: () => 'reset' }, async ({ svc, self }) => {
      delete process.env.FFMPEG_SELFHOSTED_COMMIT_MARGIN_MS;
      const t0 = Date.now();
      const ref = await svc.submit({ ...JOB(), operationKey: 'op-m' });
      expect(ref.provider).toBe('hosted');
      expect(byKeys(self).at(-1)!.t - t0).toBeGreaterThanOrEqual(5_900);
    });
  });
});
