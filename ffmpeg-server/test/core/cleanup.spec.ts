/**
 * Очистка (ТЗ §7–§9, §13 «удаление orphan workspaces без чужих файлов»):
 * только внутри WORKSPACE_ROOT и только каталоги известной формы;
 * история 90 дней, tombstone идемпотентности 90 дней; orphan executor.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  OPS_KEY,
  type TestApp,
  api,
  cleanupDir,
  startTestApp,
  submitJob,
  waitFor,
  waitStatus,
} from './helpers';

describe('cleanup', () => {
  let t: TestApp;
  let offset = 0;
  beforeEach(async () => {
    offset = 0;
    t = await startTestApp({
      now: () => Date.now() + offset,
      orphanAgeMs: 60_000,
    });
  });
  afterEach(async () => {
    await t.close();
    cleanupDir(t.dir);
  });

  function mkOld(p: string) {
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, 'f'), 'x');
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(p, old, old);
  }

  it('orphan workspaces: только uuid-каталоги внутри корня; чужие и свежие не трогаются', async () => {
    const ws = t.app.ctx.cfg.workspaceRoot;
    const oldUnknown = path.join(ws, randomUUID());
    const freshUnknown = path.join(ws, randomUUID());
    const foreign = path.join(ws, 'relay-data');
    const executorDir = path.join(ws, '.executor');
    mkOld(oldUnknown);
    mkdirSync(freshUnknown, { recursive: true });
    mkOld(foreign);
    mkOld(executorDir);
    // Файл вне корня, на который указывает symlink внутри orphan, не удаляется.
    const outside = path.join(t.dir, 'outside.txt');
    writeFileSync(outside, 'keep');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, path.join(oldUnknown, 'link'));
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(oldUnknown, old, old);
    const r = await t.app.cleanup.run();
    expect(r.removedWorkspaces).toBe(1);
    expect(existsSync(oldUnknown)).toBe(false);
    expect(existsSync(freshUnknown)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(executorDir)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('workspace терминальной задачи удаляется; queued без повтора — только старый', async () => {
    const a = await submitJob(t, 'c1');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    await waitFor(() => t.app.dispatcher.activeJobId() === null);
    const ws = path.join(t.app.ctx.cfg.workspaceRoot, a.json.data.id);
    mkdirSync(ws, { recursive: true });
    const r = await t.app.cleanup.run();
    expect(r.errors).toBe(0);
    expect(existsSync(ws)).toBe(false);
  });

  it('история 90 дней; tombstone ключа удаляется вместе с задачей, не раньше', async () => {
    const a = await submitJob(t, 'hist');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    offset = 89 * 86_400_000;
    await t.app.cleanup.run();
    expect((await submitJob(t, 'hist')).json.data.id).toBe(a.json.data.id);
    const s = await api(t.base, 'GET', `/api/jobs/${a.json.data.id}`);
    expect(s.json.data.error_code).toBe('OUTPUT_EXPIRED');
    expect(t.executor.starts).toHaveLength(1);
    const keyRow = t.app.ctx.db.get<{ tombstone: number }>(
      'SELECT tombstone FROM idempotency_keys',
    );
    expect(keyRow?.tombstone).toBe(1);
    offset = 91 * 86_400_000;
    const r = await t.app.cleanup.run();
    expect(r.deletedJobs).toBe(1);
    expect(t.app.ctx.db.all('SELECT * FROM idempotency_keys')).toHaveLength(0);
    expect(
      t.app.ctx.db.all('SELECT * FROM events WHERE job_id IS NOT NULL'),
    ).toHaveLength(0);
    expect(
      (await api(t.base, 'GET', `/api/jobs/${a.json.data.id}`)).status,
    ).toBe(404);
  });

  it('orphan executor: попытка без живой задачи отменяется', async () => {
    t.executor.behavior = () => ({ durationMs: 60_000, outcome: 'succeeded' });
    await t.executor.start({
      version: 1,
      jobId: randomUUID(),
      attemptId: randomUUID(),
      steps: [],
      deadlineAt: Date.now() + 60_000,
      maxThreads: 2,
      stderrTailBytes: 1000,
      maxWriteBytes: 1000,
    });
    await t.app.cleanup.run();
    const att = [...t.executor.attempts.values()][0];
    expect(att.canceledAt).not.toBeNull();
    const m = await api(t.base, 'GET', '/metrics', { key: OPS_KEY });
    expect(m.text).toContain('ffmpeg_orphan_executor_total 1');
  });

  it('метрики: очередь, коды ошибок, диск; без ключей и URL', async () => {
    const a = await submitJob(t, 'm1');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    const m = await api(t.base, 'GET', '/metrics', { key: OPS_KEY });
    expect(m.headers.get('content-type')).toContain(
      'text/plain; version=0.0.4',
    );
    expect(m.text).toContain(
      'ffmpeg_jobs_finished_total{code="NONE",status="succeeded"} 1',
    );
    expect(m.text).toMatch(/ffmpeg_disk_bytes\{kind="free"\} \d+/);
    expect(m.text).toContain('ffmpeg_control_mode{mode="active"} 1');
    expect(m.text).not.toMatch(/storage\.test|SECRET|token|m1/);
  });
});
