/**
 * Рестарт и восстановление (ТЗ §8, §13): pause/drain переживают рестарт,
 * restart не создаёт второй executor, одна повторная попытка только после
 * доказанного завершения, recovery после потери/подмены БД.
 */
import { existsSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cli } from '../../src/ops/cli';
import {
  FakeExecutor,
  type FakeDownloads,
  OPS_KEY,
  type TestApp,
  api,
  cleanupDir,
  codeError,
  makeConfig,
  sampleBody,
  stableEnv,
  startTestApp,
  submitJob,
  tempDir,
  waitFor,
  waitStatus,
} from './helpers';

const ops = (t: TestApp, action: string, body: unknown = {}) =>
  api(t.base, 'POST', `/api/control/${action}`, { key: OPS_KEY, body });

describe('рестарт и восстановление', () => {
  let dir: string;
  let t: TestApp | null = null;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(async () => {
    await t?.close();
    t = null;
    cleanupDir(dir);
  });

  async function restart(
    executor?: FakeExecutor,
    downloads?: Partial<FakeDownloads>,
  ) {
    const ex = executor ?? t!.executor;
    await t!.close();
    t = await startTestApp({ dir, executor: ex, downloads });
    return t;
  }

  it('pause и drain переживают рестарт', async () => {
    t = await startTestApp({ dir });
    expect((await ops(t, 'pause')).json.data.mode).toBe('paused');
    await restart();
    let ov = await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY });
    expect(ov.json.data.control.mode).toBe('paused');
    const r = await submitJob(t, 'p1');
    expect(r.status).toBe(202);
    await new Promise((x) => setTimeout(x, 100));
    expect(t.executor.starts).toHaveLength(0);
    await ops(t, 'drain');
    await restart();
    ov = await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY });
    expect(ov.json.data.control.mode).toBe('drained');
    expect((await submitJob(t, 'p2', sampleBody(2))).status).toBe(503);
    // Read/status/cancel работают в drain.
    expect(
      (await api(t.base, 'GET', `/api/jobs/${r.json.data.id}`)).status,
    ).toBe(200);
    // Stale revision → 409.
    const rev = ov.json.data.control.revision;
    expect(
      (await ops(t, 'resume', { expected_revision: rev - 1 })).status,
    ).toBe(409);
    expect(
      (await ops(t, 'resume', { expected_revision: rev })).json.data.mode,
    ).toBe('active');
    await waitStatus(t, r.json.data.id, ['succeeded']);
  });

  it('рестарт API во время рендера: второй executor не запускается, задача доводится', async () => {
    t = await startTestApp({ dir });
    t.executor.behavior = () => ({ durationMs: 2500, outcome: 'succeeded' });
    const r = await submitJob(t, 'live');
    await waitFor(() => t!.executor.starts.length === 1);
    await restart();
    const s = await waitStatus(t, r.json.data.id, ['succeeded', 'failed']);
    expect(s.json.data.status).toBe('succeeded');
    expect(t.executor.starts).toHaveLength(1);
    expect(t.executor.maxConcurrent).toBe(1);
    expect(t.ports.downloads.calls).toHaveLength(0); // новый процесс не скачивал заново
  });

  it('executor перезапущен (abandoned): одна повторная попытка с сохранёнными входами, вторая → INTERRUPTED', async () => {
    t = await startTestApp({ dir });
    t.executor.behavior = () => ({ durationMs: 60_000, outcome: 'succeeded' });
    const r = await submitJob(t, 'aband');
    await waitFor(() => t!.executor.starts.length === 1);
    const ex = t.executor;
    await t.close();
    ex.restartExecutor();
    t = await startTestApp({ dir, executor: ex });
    await waitFor(() => ex.starts.length === 2);
    expect(t.ports.downloads.calls).toHaveLength(0); // входы прежней попытки
    // Вторая потеря — повтора больше нет.
    await t.close();
    ex.restartExecutor();
    t = await startTestApp({ dir, executor: ex });
    const s = await waitStatus(t, r.json.data.id, ['failed', 'succeeded']);
    expect(s.json.data.error_code).toBe('INTERRUPTED');
    expect(ex.starts).toHaveLength(2);
    const attempts = t.app.ctx.db.all<{ status: string }>(
      'SELECT status FROM attempts ORDER BY n',
    );
    expect(attempts.map((a) => a.status)).toEqual([
      'interrupted',
      'interrupted',
    ]);
  });

  it('API умер во время скачивания: повтор после доказанной смерти, скачивание заново', async () => {
    t = await startTestApp({
      dir,
      downloads: {
        behave: (_u, signal) =>
          new Promise((_res, rej) =>
            signal?.addEventListener('abort', () => rej(codeError('CANCELED'))),
          ),
      },
    });
    const r = await submitJob(t, 'dl');
    await waitFor(() => t!.ports.downloads.calls.length === 1);
    await restart(undefined, {});
    const s = await waitStatus(t, r.json.data.id, ['succeeded', 'failed']);
    expect(s.json.data.status).toBe('succeeded');
    expect(t.ports.downloads.calls).toHaveLength(1);
    expect(t.executor.starts).toHaveLength(1);
    const job = t.app.ctx.db.get<{ attempt_count: number }>(
      'SELECT attempt_count FROM jobs',
    );
    expect(job?.attempt_count).toBe(2);
  });

  it('OOM не повторяется автоматически', async () => {
    t = await startTestApp({ dir });
    t.executor.behavior = () => ({ durationMs: 10, outcome: 'oom' });
    const r = await submitJob(t, 'oom');
    const s = await waitStatus(t, r.json.data.id, ['failed']);
    expect(s.json.data.error_code).toBe('OOM');
    expect(t.executor.starts).toHaveLength(1);
  });

  it('потеря БД → recovery: приёма и выдачи нет до явной сверки', async () => {
    t = await startTestApp({ dir });
    const a = await submitJob(t, 'before');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    const cfg = makeConfig(dir);
    await t.close();
    t = null;
    for (const suf of ['', '-wal', '-shm'])
      rmSync(cfg.dbPath + suf, { force: true });
    t = await startTestApp({ dir });
    const ov = await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY });
    expect(ov.json.data.control).toMatchObject({
      mode: 'recovery',
      reason: 'db_recreated',
    });
    const r = await submitJob(t, 'after');
    expect(r.status).toBe(503);
    // Не «доказанный отказ до приёма»: backend не уводит к hosted (FF-INT-03).
    expect(r.json.error.code).toBe('RECOVERY');
    expect(r.headers.get('x-ffmpeg-server')).toBe('1');
    expect((await ops(t, 'pause')).status).toBe(409);
    const nr = await ops(t, 'resume');
    expect(nr.status).toBe(409);
    expect(nr.json.error.code).toBe('NOT_RECONCILED');
    // Рестарт в recovery остаётся recovery.
    await restart();
    expect(
      (await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY })).json
        .data.control.mode,
    ).toBe('recovery');
    expect(
      (
        await ops(t, 'resume', {
          reconciled: true,
          reason: 'checked executor + product DB',
        })
      ).json.data.mode,
    ).toBe('active');
    expect((await submitJob(t, 'after')).status).toBe(202);
  });

  it('restore из старого backup → recovery (db_behind_jobs)', async () => {
    t = await startTestApp({ dir });
    const cfg = makeConfig(dir);
    const backup = path.join(dir, 'backup.db');
    // Консистентный online backup (как в OPERATIONS.md).
    t.app.ctx.db.raw.exec(`VACUUM INTO '${backup}'`);
    const a = await submitJob(t, 'late');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    await t.close();
    t = null;
    for (const suf of ['-wal', '-shm'])
      rmSync(cfg.dbPath + suf, { force: true });
    copyFileSync(backup, cfg.dbPath);
    t = await startTestApp({ dir });
    const ov = await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY });
    expect(ov.json.data.control).toMatchObject({
      mode: 'recovery',
      reason: 'db_behind_jobs',
    });
    // Потерянный ключ не должен тихо создать новую задачу.
    expect((await submitJob(t, 'late')).status).toBe(503);
  });

  it('restore drill: online backup под нагрузкой → restore → recovery, сверка ключей', async () => {
    t = await startTestApp({ dir });
    const env = stableEnv(dir);
    const a = await submitJob(t, 'kept');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    const bdir = path.join(dir, 'backups');
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (
      out.push(String(c)),
      true
    )) as typeof process.stdout.write;
    try {
      expect(await cli(['backup', bdir], env)).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const file = JSON.parse(out[0]).backup as string;
    const b = await submitJob(t, 'lost-after-backup', sampleBody(2));
    await waitStatus(t, b.json.data.id, ['succeeded']);
    await t.close();
    t = null;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(await cli(['verify', file], env)).toBe(0);
      expect(await cli(['restore', file], env)).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    t = await startTestApp({ dir });
    const ov = await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY });
    expect(ov.json.data.control.mode).toBe('recovery');
    // Сохранённое сопоставление ключ → job сверяется; потерянное — 503, без нового рендера.
    expect(
      (await api(t.base, 'GET', '/api/jobs/by-key/kept')).json.data.id,
    ).toBe(a.json.data.id);
    // В recovery отсутствие записи не доказательство: 503, а не 404.
    const lost = await api(t.base, 'GET', '/api/jobs/by-key/lost-after-backup');
    expect(lost.status).toBe(503);
    expect(lost.json.error.code).toBe('RECOVERY');
    expect(lost.headers.get('retry-after')).toBe('60');
    expect(
      (await submitJob(t, 'lost-after-backup', sampleBody(2))).status,
    ).toBe(503);
  });

  it('BEGIN IMMEDIATE: второе соединение не пишет посреди транзакции приёма', async () => {
    t = await startTestApp({ dir });
    const other = new DatabaseSync(t.app.ctx.cfg.dbPath);
    other.exec('PRAGMA busy_timeout = 0');
    let blocked = false;
    t.app.ctx.db.tx(() => {
      try {
        other.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')");
      } catch {
        blocked = true;
      }
    });
    other.close();
    expect(blocked).toBe(true);
    expect(existsSync(t.app.ctx.cfg.controlMarkerPath)).toBe(true);
  });
});
