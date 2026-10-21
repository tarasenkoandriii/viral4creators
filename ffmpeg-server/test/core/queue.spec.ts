/**
 * Диспетчер (ТЗ §8, §9): коды ошибок pipeline, QUEUE_TIMEOUT, TIMEOUT,
 * квоты 429, round-robin/FIFO, отмена ↔ succeeded (CAS), purge активной
 * задачи, пороги диска, профиль лимитов.
 */
import {
  CLIENT2_KEY,
  CLIENT_KEY,
  OPS_KEY,
  type TestApp,
  api,
  cleanupDir,
  codeError,
  sampleBody,
  startTestApp,
  submitJob,
  waitFor,
  waitStatus,
} from './helpers';

const ops = (t: TestApp, action: string, body: unknown = {}) =>
  api(t.base, 'POST', `/api/control/${action}`, { key: OPS_KEY, body });

describe('диспетчер и pipeline', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
    cleanupDir(t.dir);
  });

  async function failWith(
    code: string,
    setup: (t: TestApp) => void,
    body = sampleBody(),
  ) {
    setup(t);
    const r = await submitJob(t, `k-${code}`, body);
    const s = await waitStatus(t, r.json.data.id, [
      'failed',
      'succeeded',
      'canceled',
    ]);
    expect(s.json.data).toMatchObject({
      status: 'failed',
      error_code: code,
      output_files: {},
    });
    expect(s.json.data.error_message).not.toMatch(/https?:|SECRET|sig=/);
    return s.json.data;
  }

  describe('коды ошибок', () => {
    beforeEach(async () => {
      t = await startTestApp();
    });

    it('INPUT_EXPIRED / INPUT_DOWNLOAD_FAILED / INPUT_TOO_LARGE из downloader', async () => {
      await failWith('INPUT_EXPIRED', (x) => {
        x.ports.downloads.behave = async () =>
          codeError('INPUT_EXPIRED', 'HTTP 403 https://storage.test/x?sig=1');
      });
      t.ports.downloads.behave = async () => codeError('INPUT_TOO_LARGE');
      const r = await submitJob(t, 'big', sampleBody(7));
      expect(
        (await waitStatus(t, r.json.data.id, ['failed'])).json.data.error_code,
      ).toBe('INPUT_TOO_LARGE');
      t.ports.downloads.behave = async () => new Error('socket hang up');
      const r2 = await submitJob(t, 'broken', sampleBody(8));
      expect(
        (await waitStatus(t, r2.json.data.id, ['failed'])).json.data.error_code,
      ).toBe('INPUT_DOWNLOAD_FAILED');
      expect(t.executor.starts).toHaveLength(0);
    });

    it('INPUT_INVALID_MEDIA и INPUT_LIMIT_EXCEEDED после probe', async () => {
      await failWith('INPUT_INVALID_MEDIA', (x) => {
        x.ports.downloads.behave = async () => 'notmedia';
      });
      t.ports.downloads.behave = async () => 'x'.repeat(1_000_001);
      const r = await submitJob(t, 'lim', sampleBody(3));
      expect(
        (await waitStatus(t, r.json.data.id, ['failed'])).json.data.error_code,
      ).toBe('INPUT_LIMIT_EXCEEDED');
    });

    it('COMMAND_FAILED: stderr в карточке ops очищен, клиенту не отдаётся', async () => {
      const d = await failWith('COMMAND_FAILED', (x) => {
        x.executor.behavior = () => ({ durationMs: 10, outcome: 'failed' });
      });
      expect(JSON.stringify(d)).not.toContain('Error');
      const card = await api(t.base, 'GET', `/api/ops/jobs/${d.id}`, {
        key: OPS_KEY,
      });
      expect(card.json.data.stderr_tail).toContain('[url]');
      expect(card.json.data.stderr_tail).not.toContain('sig=abc');
      expect(card.json.data.attempts[0]).toMatchObject({
        outcome: 'failed',
        exit_code: 1,
      });
      expect(JSON.stringify(card.json.data)).not.toMatch(
        /SECRET|storage\.test|frames:v/,
      );
    });

    it('OOM, OUTPUT_TOO_LARGE, OUTPUT_MISSING; первый output не публикуется при отказе', async () => {
      await failWith('OOM', (x) => {
        x.executor.behavior = () => ({ durationMs: 10, outcome: 'oom' });
      });
      const ov = await api(t.base, 'GET', '/api/ops/overview', {
        key: OPS_KEY,
      });
      expect(ov.json.data.queue.errors_24h).toEqual({ OOM: 1 });
      expect(ov.json.data.queue.oom_24h).toBe(1);
      expect(ov.json.data.ready).toMatchObject({ ready: true, reasons: [] });
      t.executor.behavior = () => ({ durationMs: 10, outcome: 'too_large' });
      const r = await submitJob(t, 'tl', sampleBody(4));
      expect(
        (await waitStatus(t, r.json.data.id, ['failed'])).json.data.error_code,
      ).toBe('OUTPUT_TOO_LARGE');
      t.executor.behavior = () => ({
        durationMs: 10,
        outcome: 'succeeded',
        skipOutputs: true,
      });
      const r2 = await submitJob(t, 'miss', {
        ...sampleBody(5),
        output_files: ['a.mp4', 'b.mp4'],
      });
      const s = await waitStatus(t, r2.json.data.id, ['failed']);
      expect(s.json.data.error_code).toBe('OUTPUT_MISSING');
      expect(
        t.app.ctx.db.all('SELECT * FROM artifacts WHERE job_id = ?', [
          r2.json.data.id,
        ]),
      ).toHaveLength(0);
    });

    it('workspace задачи удаляется после завершения', async () => {
      const r = await submitJob(t, 'ws');
      await waitStatus(t, r.json.data.id, ['succeeded']);
      const fs = await import('node:fs');
      await waitFor(
        () =>
          !fs.existsSync(`${t.app.ctx.cfg.workspaceRoot}/${r.json.data.id}`),
      );
    });
  });

  it('TIMEOUT по общему сроку pipeline; executor отменён до освобождения слота', async () => {
    t = await startTestApp({
      env: { FFMPEG_SERVER_LIMIT_PIPELINE_DEADLINE_SEC: '1' },
    });
    t.executor.behavior = () => ({ durationMs: 60_000, outcome: 'succeeded' });
    const r = await submitJob(t, 'slow');
    const s = await waitStatus(t, r.json.data.id, ['failed']);
    expect(s.json.data.error_code).toBe('TIMEOUT');
    const att = [...t.executor.attempts.values()][0];
    expect(att.done?.outcome === 'timeout' || att.canceledAt !== null).toBe(
      true,
    );
  });

  it('QUEUE_TIMEOUT: задача не стартовала за queue deadline', async () => {
    t = await startTestApp({
      env: { FFMPEG_SERVER_LIMIT_QUEUE_DEADLINE_SEC: '1' },
    });
    await ops(t, 'pause');
    const r = await submitJob(t, 'q');
    const s = await waitStatus(t, r.json.data.id, ['failed']);
    expect(s.json.data).toMatchObject({
      error_code: 'QUEUE_TIMEOUT',
      execution_status: 'failed',
    });
    expect(t.executor.starts).toHaveLength(0);
    expect(t.ports.downloads.calls).toHaveLength(0);
  });

  it('квоты: 10 на клиента и 20 на сервер (здесь 2 и 3) → 429 + Retry-After; повтор ключа не занимает место', async () => {
    t = await startTestApp({
      env: {
        FFMPEG_SERVER_MAX_QUEUED: '3',
        FFMPEG_SERVER_MAX_QUEUED_PER_CLIENT: '2',
      },
    });
    await ops(t, 'pause');
    expect((await submitJob(t, 'a1', sampleBody(1))).status).toBe(202);
    expect((await submitJob(t, 'a2', sampleBody(2))).status).toBe(202);
    const a3 = await submitJob(t, 'a3', sampleBody(3));
    expect(a3.status).toBe(429);
    expect(a3.json.error.code).toBe('CLIENT_QUOTA_EXCEEDED');
    expect(Number(a3.headers.get('retry-after'))).toBeGreaterThanOrEqual(30);
    expect((await submitJob(t, 'a1', sampleBody(1))).status).toBe(202);
    expect((await submitJob(t, 'b1', sampleBody(1), CLIENT2_KEY)).status).toBe(
      202,
    );
    const b2 = await submitJob(t, 'b2', sampleBody(2), CLIENT2_KEY);
    expect(b2.status).toBe(429);
    expect(b2.json.error.code).toBe('QUEUE_FULL');
  });

  it('round-robin между клиентами, FIFO внутри клиента; одна задача за раз', async () => {
    t = await startTestApp();
    await ops(t, 'pause');
    const ids: Record<string, string> = {};
    for (const k of ['a1', 'a2', 'a3'])
      ids[k] = (await submitJob(t, k, sampleBody(Number(k[1])))).json.data.id;
    ids.b1 = (
      await submitJob(t, 'b1', sampleBody(1), CLIENT2_KEY)
    ).json.data.id;
    await ops(t, 'resume');
    for (const id of Object.values(ids))
      await waitStatus(
        t,
        id,
        ['succeeded'],
        id === ids.b1 ? CLIENT2_KEY : CLIENT_KEY,
      );
    const order = t.executor.starts.map(
      (s) => Object.entries(ids).find(([, v]) => v === s.jobId)![0],
    );
    expect(order).toEqual(['a1', 'b1', 'a2', 'a3']);
    expect(t.executor.maxConcurrent).toBe(1);
  });

  describe('отмена и purge', () => {
    beforeEach(async () => {
      t = await startTestApp();
    });

    it('queued → canceled сразу; повтор отмены идемпотентен', async () => {
      await ops(t, 'pause');
      const r = await submitJob(t, 'c1');
      const c = await api(t.base, 'POST', `/api/jobs/${r.json.data.id}/cancel`);
      expect(c.status).toBe(200);
      expect(c.json.data).toMatchObject({
        status: 'canceled',
        error_code: 'CANCELED',
      });
      expect(
        (await api(t.base, 'POST', `/api/jobs/${r.json.data.id}/cancel`)).json
          .data.status,
      ).toBe('canceled');
      await ops(t, 'resume');
      await new Promise((r2) => setTimeout(r2, 100));
      expect(t.executor.starts).toHaveLength(0);
    });

    it('running → canceled; executor получает cancel, workspace очищается после подтверждения', async () => {
      t.executor.behavior = () => ({
        durationMs: 60_000,
        outcome: 'succeeded',
      });
      const r = await submitJob(t, 'c2');
      await waitFor(() => t.executor.starts.length === 1);
      const c = await api(t.base, 'POST', `/api/jobs/${r.json.data.id}/cancel`);
      expect(c.json.data.status).toBe('canceled');
      await waitFor(() => t.app.dispatcher.activeJobId() === null);
      const att = [...t.executor.attempts.values()][0];
      expect(att.canceledAt).not.toBeNull();
      expect(att.done?.outcome).toBe('canceled');
      const s = await api(t.base, 'GET', `/api/jobs/${r.json.data.id}`);
      expect(s.json.data.status).toBe('canceled');
    });

    it('гонка cancel ↔ succeeded: отмена во время публикации побеждает CAS, файлы не публикуются', async () => {
      const orig = t.ports.verifyOutputs.bind(t.ports);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      t.ports.verifyOutputs = async (...args) => {
        await gate;
        return orig(...args);
      };
      const r = await submitJob(t, 'race');
      await waitFor(
        async () =>
          (await api(t.base, 'GET', `/api/jobs/${r.json.data.id}`)).json.data
            .stage === 'validating',
      );
      const c = await api(t.base, 'POST', `/api/jobs/${r.json.data.id}/cancel`);
      expect(c.json.data.status).toBe('canceled');
      release();
      await waitFor(() => t.app.dispatcher.activeJobId() === null);
      const s = await api(t.base, 'GET', `/api/jobs/${r.json.data.id}`);
      expect(s.json.data).toMatchObject({
        status: 'canceled',
        output_files: {},
      });
      expect(t.app.ctx.db.all('SELECT * FROM artifacts')).toHaveLength(0);
      const fs = await import('node:fs');
      expect(
        fs.existsSync(`${t.app.ctx.cfg.outputsRoot}/${r.json.data.id}`),
      ).toBe(false);
    });

    it('гонка succeeded → cancel: готовая задача не становится canceled', async () => {
      const r = await submitJob(t, 'race2');
      await waitStatus(t, r.json.data.id, ['succeeded']);
      const c = await api(t.base, 'POST', `/api/jobs/${r.json.data.id}/cancel`);
      expect(c.status).toBe(200);
      expect(c.json.data.status).toBe('succeeded');
    });

    it('purge активной задачи: 202, затем остановка и удаление (повтор → 200)', async () => {
      t.executor.behavior = () => ({
        durationMs: 60_000,
        outcome: 'succeeded',
      });
      const r = await submitJob(t, 'p-act');
      await waitFor(() => t.executor.starts.length === 1);
      const p = await api(
        t.base,
        'DELETE',
        `/api/jobs/${r.json.data.id}/artifacts`,
      );
      expect(p.status).toBe(202);
      expect(p.json.data.purged).toBe(false);
      await waitFor(() => t.app.dispatcher.activeJobId() === null);
      const again = await api(
        t.base,
        'DELETE',
        `/api/jobs/${r.json.data.id}/artifacts`,
      );
      expect(again.status).toBe(200);
      const row = t.app.ctx.db.get<{ purged_at: number | null }>(
        'SELECT purged_at FROM jobs WHERE id = ?',
        [r.json.data.id],
      );
      expect(row?.purged_at).not.toBeNull();
    });
  });

  it('диск: свободно меньше порога → 503 и ready=false', async () => {
    t = await startTestApp({
      env: { FFMPEG_SERVER_DISK_MIN_FREE_BYTES: String(2 ** 52) },
    });
    const r = await submitJob(t, 'disk');
    expect(r.status).toBe(503);
    const ready = await api(t.base, 'GET', '/api/ready', { key: null });
    expect(ready.status).toBe(503);
    expect(ready.json.data.reasons).toContain('disk_low');
  });

  it('квота workspaces: задача ждёт, пока резерв workspace не помещается', async () => {
    t = await startTestApp({
      env: { FFMPEG_SERVER_DISK_MAX_WORKSPACES_BYTES: String(1024 ** 3) },
    });
    const r = await submitJob(t, 'wsq');
    await new Promise((x) => setTimeout(x, 200));
    expect(
      (await api(t.base, 'GET', `/api/jobs/${r.json.data.id}`)).json.data
        .status,
    ).toBe('queued');
    expect(t.app.ctx.metrics.render()).toMatch(
      /ffmpeg_dispatch_blocked_total\{reason="workspaces_quota"\} \d+/,
    );
  });

  it('лимиты: ops меняет в пределах верхних границ с CAS по ревизии', async () => {
    t = await startTestApp({ env: { FFMPEG_SERVER_LIMIT_MAX_INPUTS: '5' } });
    const cur = await api(t.base, 'GET', '/api/ops/limits', { key: OPS_KEY });
    expect(cur.json.data.effective.maxInputs).toBe(5);
    const rev = cur.json.data.revision;
    const above = await api(t.base, 'POST', '/api/ops/limits', {
      key: OPS_KEY,
      body: { expected_revision: rev, limits: { maxInputs: 6 } },
    });
    expect(above.status).toBe(400);
    const ok = await api(t.base, 'POST', '/api/ops/limits', {
      key: OPS_KEY,
      body: {
        expected_revision: rev,
        limits: { maxInputs: 3 },
        reason: 'canary',
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data.effective.maxInputs).toBe(3);
    const stale = await api(t.base, 'POST', '/api/ops/limits', {
      key: OPS_KEY,
      body: { expected_revision: rev, limits: { maxInputs: 2 } },
    });
    expect(stale.status).toBe(409);
    const r = await submitJob(t, 'lr');
    const row = t.app.ctx.db.get<{ limits_revision: number }>(
      'SELECT limits_revision FROM jobs WHERE id = ?',
      [r.json.data.id],
    );
    expect(row?.limits_revision).toBe(rev + 1);
  });

  it('ops overview/jobs: фильтры, курсор по 25, без секретов', async () => {
    t = await startTestApp();
    await ops(t, 'pause');
    for (let i = 0; i < 8; i++)
      await submitJob(
        t,
        `o${i}`,
        sampleBody(i),
        i % 2 ? CLIENT2_KEY : CLIENT_KEY,
        {
          'X-Client-Operation-Id': `op-${i}`,
        },
      );
    const ov = await api(t.base, 'GET', '/api/ops/overview', { key: OPS_KEY });
    expect(ov.json.data.queue.counts.queued).toBe(8);
    expect(ov.json.data.control.mode).toBe('paused');
    expect(ov.json.data.queue.oldest_queued_age_sec).toBeGreaterThanOrEqual(0);
    const p1 = await api(t.base, 'GET', '/api/ops/jobs?limit=5', {
      key: OPS_KEY,
    });
    expect(p1.json.data.items).toHaveLength(5);
    const p2 = await api(
      t.base,
      'GET',
      `/api/ops/jobs?limit=5&cursor=${p1.json.data.next_cursor}`,
      { key: OPS_KEY },
    );
    expect(p2.json.data.items).toHaveLength(3);
    expect(p2.json.data.next_cursor).toBeNull();
    const byOp = await api(
      t.base,
      'GET',
      '/api/ops/jobs?client_operation_id=op-3',
      { key: OPS_KEY },
    );
    expect(byOp.json.data.items).toHaveLength(1);
    const st = await api(t.base, 'GET', '/api/ops/jobs?state=failed', {
      key: OPS_KEY,
    });
    expect(st.json.data.items).toHaveLength(0);
    const all = JSON.stringify([ov.json, p1.json, p2.json]);
    expect(all).not.toMatch(/SECRET|storage\.test|frames:v/);
    // Индекс под фильтр: план запроса без полного скана jobs.
    const plan = t.app.ctx.db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE status IN ('queued') AND created_at >= 0 ORDER BY seq DESC LIMIT 26",
    );
    expect(plan.map((p) => p.detail).join(' ')).not.toMatch(/^SCAN jobs$/);
  });
});
