/**
 * Ops-контракт с НАСТОЯЩИМ backend-клиентом вкладки «FFmpeg»
 * (backend/src/modules/ffmpeg-admin/ffmpeg-ops.client.ts, транспиляция
 * как в Р-FF-CORE-6) — теми же путями, query, телами и заголовками, что
 * шлёт ffmpeg-admin.service.ts: overview, jobs, card, limits CAS,
 * pause/drain/resume, cancel, purge, download-link, by-key.
 */
import { rmSync } from 'node:fs';
import { loadBackendOpsClient } from './backend-client';
import {
  CLIENT_KEY,
  OPS_KEY,
  type TestApp,
  cleanupDir,
  makeConfig,
  sampleBody,
  startTestApp,
  submitJob,
  tempDir,
  waitFor,
  waitStatus,
} from './helpers';

describe('ops-API ↔ backend FfmpegOpsClient', () => {
  let t: TestApp;
  let dir: string;
  const { client, Rejected, Unavailable, sanitizeOps } = loadBackendOpsClient();

  beforeEach(async () => {
    dir = tempDir();
    t = await startTestApp({ dir });
    process.env.FFMPEG_SELFHOSTED_BASE_URL = `${t.base}/api`;
    process.env.FFMPEG_SELFHOSTED_OPS_KEY = OPS_KEY;
    process.env.FFMPEG_SELFHOSTED_KEY = CLIENT_KEY;
  });
  afterEach(async () => {
    delete process.env.FFMPEG_SELFHOSTED_BASE_URL;
    delete process.env.FFMPEG_SELFHOSTED_OPS_KEY;
    delete process.env.FFMPEG_SELFHOSTED_KEY;
    await t.close();
    cleanupDir(dir);
  });

  const mut = (op: string) => ({
    idempotencyKey: op,
    correlationId: `corr-${op}`,
  });

  it('overview (с CPU/RAM executor), jobs с курсором, карточка', async () => {
    t.executor.behavior = () => ({ durationMs: 1500, outcome: 'succeeded' });
    const r = await submitJob(t, 'oc-1', sampleBody(), CLIENT_KEY, {
      'X-Client-Operation-Id': 'story:op-1',
    });
    const id = r.json.data.id as string;
    await waitFor(() => t.executor.starts.length === 1);
    await waitFor(async () => {
      const ov = await client.request('GET', '/ops/overview', { role: 'ops' });
      const res = (ov.executor as Record<string, Record<string, unknown>>)
        ?.resources;
      return res && res.idle === false && res.cpu_percent !== null ? ov : null;
    });
    const ov = await client.request('GET', '/ops/overview', { role: 'ops' });
    const res = (ov.executor as Record<string, Record<string, unknown>>)
      .resources;
    expect(res).toMatchObject({
      idle: false,
      rss_kb: 51_200,
      peak_rss_kb: 65_536,
      stale: false,
    });
    expect(typeof res.sampled_at).toBe('string');
    expect((ov.control as Record<string, unknown>).mode).toBe('active');
    expect(JSON.stringify(sanitizeOps(ov))).not.toMatch(/SECRET|storage\.test/);

    const list = await client.request('GET', '/ops/jobs', {
      role: 'ops',
      query: {
        limit: '25',
        cursor: undefined,
        state: undefined,
        period: '24h',
        client_operation_id: 'story:op-1',
        job_id: undefined,
      },
    });
    expect(Array.isArray(list.items)).toBe(true);
    expect((list.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      id,
      client_operation_id: 'story:op-1',
    });
    expect(list.next_cursor).toBeNull();

    await waitStatus(t, id, ['succeeded']);
    const card = sanitizeOps(
      await client.request('GET', `/ops/jobs/${encodeURIComponent(id)}`, {
        role: 'ops',
      }),
    ) as Record<string, unknown>;
    expect(card).toMatchObject({
      id,
      status: 'succeeded',
      client_operation_id: 'story:op-1',
    });
    expect(Array.isArray(card.timeline)).toBe(true);
    expect(Array.isArray(card.attempts)).toBe(true);
  });

  it('limits: CAS по ревизии, 409 STALE_REVISION', async () => {
    const cur = await client.request('GET', '/ops/limits', { role: 'ops' });
    const rev = cur.revision as number;
    const ok = await client.request('POST', '/ops/limits', {
      role: 'ops',
      body: { expected_revision: rev, limits: { maxInputs: 5 } },
      ...mut('lim-1'),
    });
    expect(ok.revision).toBe(rev + 1);
    expect((ok.effective as Record<string, number>).maxInputs).toBe(5);
    const stale = await client
      .request('POST', '/ops/limits', {
        role: 'ops',
        body: { expected_revision: rev, limits: { maxInputs: 4 } },
        ...mut('lim-2'),
      })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(Rejected);
    expect(stale).toMatchObject({ status: 409, code: 'STALE_REVISION' });
  });

  it('pause/drain/resume с {reason}; correlation id в access log', async () => {
    const p = await client.request('POST', '/control/pause', {
      role: 'ops',
      body: { reason: 'canary' },
      ...mut('c-1'),
    });
    expect(p.mode).toBe('paused');
    // Повтор того же действия идемпотентен.
    expect(
      (
        await client.request('POST', '/control/pause', {
          role: 'ops',
          body: {},
          ...mut('c-1'),
        })
      ).mode,
    ).toBe('paused');
    expect(
      (
        await client.request('POST', '/control/drain', {
          role: 'ops',
          body: {},
          ...mut('c-2'),
        })
      ).mode,
    ).toBe('drained');
    expect(
      (
        await client.request('POST', '/control/resume', {
          role: 'ops',
          body: {},
          ...mut('c-3'),
        })
      ).mode,
    ).toBe('active');
    expect(t.logs.join('\n')).toContain('"correlation_id":"corr-c-2"');
  });

  it('cancel (ключ клиента), purge 202/200, download-link {url, expires_at, mime}', async () => {
    const done = await submitJob(t, 'dl-1');
    await waitStatus(t, done.json.data.id, ['succeeded']);
    const link = await client.request(
      'POST',
      `/ops/jobs/${done.json.data.id}/download-link`,
      {
        role: 'ops',
        body: { file: 'poster.jpg' },
        ...mut('l-1'),
      },
    );
    expect(link.url).toMatch(/^https:\/\/ffmpeg\.test\/api\/files\//);
    expect(typeof link.expires_at).toBe('string');
    expect(link.mime).toBe('image/jpeg');

    t.executor.behavior = () => ({ durationMs: 60_000, outcome: 'succeeded' });
    const run = await submitJob(t, 'run-1', sampleBody(2));
    await waitFor(() => t.executor.starts.length === 2);
    const c = await client.request('POST', `/jobs/${run.json.data.id}/cancel`, {
      role: 'client',
      body: {},
      ...mut('x-1'),
    });
    expect(c.status).toBe('canceled');

    const run2 = await submitJob(t, 'run-2', sampleBody(3));
    await waitFor(() => t.executor.starts.length === 3);
    const p1 = await client.requestWithStatus(
      'DELETE',
      `/jobs/${run2.json.data.id}/artifacts`,
      { role: 'client', ...mut('p-1') },
    );
    expect(p1.status).toBe(202);
    await waitFor(() => t.app.dispatcher.activeJobId() === null);
    const p2 = await client.requestWithStatus(
      'DELETE',
      `/jobs/${run2.json.data.id}/artifacts`,
      { role: 'client', ...mut('p-2') },
    );
    expect(p2.status).toBe(200);
    const p3 = await client.requestWithStatus(
      'DELETE',
      `/jobs/${done.json.data.id}/artifacts`,
      { role: 'client', ...mut('p-3') },
    );
    expect(p3.status).toBe(200);
    expect(p3.data.error_code).toBe('OUTPUT_PURGED');
  });

  it('by-key: 404 только при отсутствии записи; в recovery и при недоступной БД — 503', async () => {
    const a = await submitJob(t, 'bk-1');
    const found = await client.request('GET', '/jobs/by-key/bk-1', {
      role: 'client',
    });
    expect(found.id).toBe(a.json.data.id);
    const missing = await client
      .request('GET', '/jobs/by-key/none', { role: 'client' })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(Rejected);
    expect(missing).toMatchObject({ status: 404 });

    // Потеря БД → recovery: отсутствие записи ничего не доказывает.
    const cfg = makeConfig(dir);
    await t.close();
    for (const suf of ['', '-wal', '-shm'])
      rmSync(cfg.dbPath + suf, { force: true });
    t = await startTestApp({ dir });
    process.env.FFMPEG_SELFHOSTED_BASE_URL = `${t.base}/api`;
    for (const p of ['/jobs/by-key/bk-1', `/jobs/${a.json.data.id}`]) {
      const e = await client
        .request('GET', p, { role: 'client' })
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Unavailable);
      expect(e).toMatchObject({ status: 503 });
    }
    const card = await client
      .request('GET', `/ops/jobs/${a.json.data.id}`, { role: 'ops' })
      .catch((x: unknown) => x);
    expect(card).toBeInstanceOf(Unavailable);

    // Недоступная БД — тоже 503, не 404.
    t.app.ctx.db.close();
    const down = await client
      .request('GET', '/jobs/by-key/bk-1', { role: 'client' })
      .catch((x: unknown) => x);
    expect(down).toBeInstanceOf(Unavailable);
    expect(down).toMatchObject({ status: 503 });
  });
});
