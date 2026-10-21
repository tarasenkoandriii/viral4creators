/**
 * Контракт API (ТЗ §5, §13): коды ответов, конверт, идемпотентность,
 * порядок проверок существующего ключа, приватность.
 */
import {
  CLIENT2_KEY,
  CLIENT_KEY,
  OPS_KEY,
  type TestApp,
  api,
  cleanupDir,
  sampleBody,
  startTestApp,
  submitJob,
  waitStatus,
} from './helpers';

describe('API v1', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t.close();
    cleanupDir(t.dir);
  });

  it('health без авторизации и без внутренних данных; ready отражает проверки', async () => {
    const h = await api(t.base, 'GET', '/api/health', { key: null });
    expect(h.status).toBe(200);
    expect(h.json).toEqual({ data: { status: 'ok' } });
    const r = await api(t.base, 'GET', '/api/ready', { key: null });
    expect(r.status).toBe(200);
    expect(r.json.data.ready).toBe(true);
    t.executor.heartbeatFresh = false;
    const r2 = await api(t.base, 'GET', '/api/ready', { key: null });
    expect(r2.status).toBe(503);
    expect(r2.json.data.reasons).toContain('executor_heartbeat_stale');
    t.executor.heartbeatFresh = true;
    t.executor.capsOk = false;
    const r3 = await api(t.base, 'GET', '/api/ready', { key: null });
    expect(r3.status).toBe(503);
    expect(r3.json.data.checks.capabilities).toBe(false);
  });

  it('POST → 202 {data:{id,status,error_message}} → GET succeeded с ссылкой', async () => {
    const r = await submitJob(t, 'op-1');
    expect(r.status).toBe(202);
    expect(r.json.data).toMatchObject({ status: 'queued', error_message: '' });
    expect(typeof r.json.data.id).toBe('string');
    const done = await waitStatus(t, r.json.data.id, ['succeeded', 'failed']);
    const d = done.json.data;
    expect(d.status).toBe('succeeded');
    expect(d.progress).toBe(100);
    expect(d.error_code).toBeNull();
    expect(d.execution_status).toBe('succeeded');
    expect(Object.keys(d.output_files)).toEqual(['poster.jpg']);
    expect(d.output_files['poster.jpg']).toMatch(
      new RegExp(
        `^https://ffmpeg\\.test/api/files/${d.id}/poster\\.jpg\\?token=[A-Za-z0-9_-]{43}$`,
      ),
    );
    expect(d.outputs_metadata['poster.jpg']).toMatchObject({
      mime: 'image/jpeg',
    });
    expect(d.ffmpeg_version).toBe('fake-6.1');
    expect(t.executor.maxConcurrent).toBe(1);
  });

  it('401 без ключа / с неверным ключом', async () => {
    expect(
      (
        await api(t.base, 'POST', '/api/ffmpeg', {
          key: null,
          body: sampleBody(),
        })
      ).status,
    ).toBe(401);
    const bad = await api(t.base, 'GET', '/api/jobs/x', {
      key: 'wrong-key-' + 'z'.repeat(30),
    });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe('UNAUTHORIZED');
  });

  it('400: не JSON, нет Idempotency-Key, лишние поля, пустые outputs', async () => {
    const notJson = await api(t.base, 'POST', '/api/ffmpeg', {
      raw: '{oops',
      headers: { 'Idempotency-Key': 'k1' },
    });
    expect(notJson.status).toBe(400);
    const noKey = await api(t.base, 'POST', '/api/ffmpeg', {
      body: sampleBody(),
    });
    expect(noKey.status).toBe(400);
    const longKey = await submitJob(t, 'x'.repeat(129));
    expect(longKey.status).toBe(400);
    const extra = await submitJob(t, 'k2', {
      ...sampleBody(),
      webhook: 'https://x',
    });
    expect(extra.status).toBe(400);
    expect(extra.json.error.code).toBe('INVALID_REQUEST');
    const empty = await submitJob(t, 'k3', {
      ...sampleBody(),
      output_files: [],
    });
    expect(empty.status).toBe(400);
    const badOut = await submitJob(t, 'k4', {
      ...sampleBody(),
      output_files: ['../x'],
    });
    expect(badOut.status).toBe(400);
  });

  it('403 запрещённый источник, 422 неподдерживаемая команда, 413 размер', async () => {
    const forb = await submitJob(t, 'f1', {
      ...sampleBody(),
      input_files: { base: 'https://evil.example/x.mp4' },
    });
    expect(forb.status).toBe(403);
    expect(forb.json.error.code).toBe('FORBIDDEN_SOURCE');
    const unsup = await submitJob(t, 'u1', {
      ...sampleBody(),
      ffmpeg_commands: ['ffmpeg -i {{base}} evil {{poster.jpg}}'],
    });
    expect(unsup.status).toBe(422);
    expect(unsup.json.error.code).toBe('UNSUPPORTED_COMMAND');
    const big = await submitJob(t, 'b1', {
      ...sampleBody(),
      ffmpeg_commands: ['x'.repeat(600 * 1024)],
    });
    expect(big.status).toBe(413);
  });

  it('идемпотентность: повтор → тот же id без нового рендера; другое тело → 409', async () => {
    const a = await submitJob(t, 'same');
    const b = await submitJob(t, 'same');
    expect(b.status).toBe(202);
    expect(b.json.data.id).toBe(a.json.data.id);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    const c = await submitJob(t, 'same', sampleBody(2));
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // Порядок ключей объекта не влияет на fingerprint; порядок массивов — влияет.
    const reordered = {
      ffmpeg_commands: sampleBody().ffmpeg_commands,
      output_files: sampleBody().output_files,
      input_files: sampleBody().input_files,
    };
    expect((await submitJob(t, 'same', reordered)).json.data.id).toBe(
      a.json.data.id,
    );
    await waitStatus(t, a.json.data.id, ['succeeded']);
    expect(t.executor.starts).toHaveLength(1);
    // Ключи разных клиентов независимы.
    const other = await submitJob(t, 'same', sampleBody(), CLIENT2_KEY);
    expect(other.json.data.id).not.toBe(a.json.data.id);
  });

  it('50 параллельных POST с одним ключом — один job и один executor', async () => {
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => submitJob(t, 'parallel')),
    );
    const ids = new Set(rs.map((r) => r.json?.data?.id));
    expect(rs.every((r) => r.status === 202)).toBe(true);
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    await waitStatus(t, id, ['succeeded']);
    expect(
      t.app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n,
    ).toBe(1);
    expect(t.executor.starts).toHaveLength(1);
  });

  it('«потерянный ответ»: by-key находит задачу, повтор POST — тот же id', async () => {
    const a = await submitJob(t, 'lost-1');
    const byKey = await api(t.base, 'GET', '/api/jobs/by-key/lost-1');
    expect(byKey.status).toBe(200);
    expect(byKey.json.data.id).toBe(a.json.data.id);
    expect((await api(t.base, 'GET', '/api/jobs/by-key/nope')).status).toBe(
      404,
    );
    // Чужой клиент не видит ключ.
    expect(
      (
        await api(t.base, 'GET', '/api/jobs/by-key/lost-1', {
          key: CLIENT2_KEY,
        })
      ).status,
    ).toBe(404);
    expect((await submitJob(t, 'lost-1')).json.data.id).toBe(a.json.data.id);
    // Ключ by-key не попадает в access log.
    expect(t.logs.join('\n')).not.toContain('lost-1');
  });

  it('существующий ключ возвращается даже при drain/полной очереди/неготовности', async () => {
    const a = await submitJob(t, 'keep');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    await api(t.base, 'POST', '/api/control/drain', { key: OPS_KEY, body: {} });
    t.executor.heartbeatFresh = false;
    const again = await submitJob(t, 'keep');
    expect(again.status).toBe(202);
    expect(again.json.data.id).toBe(a.json.data.id);
    const fresh = await submitJob(t, 'new-one', sampleBody(9));
    expect(fresh.status).toBe(503);
    expect(fresh.headers.get('retry-after')).toBeTruthy();
    // Другое тело с существующим ключом — 409 и в drain.
    expect((await submitJob(t, 'keep', sampleBody(5))).status).toBe(409);
  });

  it('404 для чужой и неизвестной задачи без утечки существования', async () => {
    const a = await submitJob(t, 'mine');
    const other = await api(t.base, 'GET', `/api/jobs/${a.json.data.id}`, {
      key: CLIENT2_KEY,
    });
    const unknown = await api(
      t.base,
      'GET',
      '/api/jobs/00000000-0000-4000-8000-000000000000',
      {
        key: CLIENT2_KEY,
      },
    );
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(other.text).toBe(unknown.text);
    // ops видит любую задачу; префикс selfhosted: допустим.
    const ops = await api(
      t.base,
      'GET',
      `/api/jobs/selfhosted:${a.json.data.id}`,
      { key: OPS_KEY },
    );
    expect(ops.status).toBe(200);
  });

  it('control и ops — только ops (403 для клиента)', async () => {
    expect(
      (await api(t.base, 'POST', '/api/control/pause', { body: {} })).status,
    ).toBe(403);
    expect((await api(t.base, 'GET', '/api/ops/overview')).status).toBe(403);
    expect((await api(t.base, 'GET', '/metrics')).status).toBe(403);
    expect(
      (await api(t.base, 'GET', '/metrics', { key: OPS_KEY })).status,
    ).toBe(200);
  });

  it('capabilities — авторизованный список версии, фильтров и лимитов', async () => {
    expect(
      (await api(t.base, 'GET', '/api/capabilities', { key: null })).status,
    ).toBe(401);
    const c = await api(t.base, 'GET', '/api/capabilities');
    expect(c.status).toBe(200);
    expect(c.json.data.filters).toContain('loudnorm');
    expect(c.json.data.limits.maxInputs).toBe(20);
  });

  it('X-Client-Operation-Id сохраняется и не влияет на fingerprint', async () => {
    const a = await submitJob(t, 'op-h', sampleBody(), CLIENT_KEY, {
      'X-Client-Operation-Id': 'story:42',
    });
    const b = await submitJob(t, 'op-h', sampleBody(), CLIENT_KEY, {
      'X-Client-Operation-Id': 'other',
    });
    expect(b.json.data.id).toBe(a.json.data.id);
    const g = await api(t.base, 'GET', `/api/jobs/${a.json.data.id}`);
    expect(g.json.data.client_operation_id).toBe('story:42');
    const bad = await submitJob(t, 'op-x', sampleBody(3), CLIENT_KEY, {
      'X-Client-Operation-Id': 'é'.repeat(3),
    });
    expect(bad.status).toBe(400);
  });

  it('payload в БД зашифрован, idempotency key — хешем; секреты не в логах', async () => {
    const a = await submitJob(t, 'priv-key-123');
    await waitStatus(t, a.json.data.id, ['succeeded']);
    const dump =
      JSON.stringify(t.app.ctx.db.all('SELECT * FROM jobs')) +
      JSON.stringify(t.app.ctx.db.all('SELECT * FROM idempotency_keys')) +
      JSON.stringify(t.app.ctx.db.all('SELECT * FROM events'));
    expect(dump).not.toContain('SECRET1');
    expect(dump).not.toContain('storage.test');
    expect(dump).not.toContain('priv-key-123');
    expect(dump).not.toContain('frames:v');
    const logs = t.logs.join('\n');
    for (const s of [
      'SECRET1',
      'priv-key-123',
      CLIENT_KEY,
      'token=',
      'storage.test',
      'frames:v',
    ]) {
      expect(logs).not.toContain(s);
    }
  });

  it('X-FFmpeg-Server: 1 на всех ответах сервера, включая 401/404/405/413/410/503', async () => {
    const a = await submitJob(t, 'hdr');
    const s = await waitStatus(t, a.json.data.id, ['succeeded']);
    const u = new URL(s.json.data.output_files['poster.jpg']);
    await api(t.base, 'DELETE', `/api/jobs/${a.json.data.id}/artifacts`);
    const responses = [
      await api(t.base, 'GET', '/api/health', { key: null }),
      await api(t.base, 'GET', '/api/jobs/x', { key: null }),
      await api(
        t.base,
        'GET',
        '/api/jobs/00000000-0000-4000-8000-000000000000',
      ),
      await api(t.base, 'GET', '/api/jobs/by-key/none'),
      await api(t.base, 'GET', '/nope', { key: null }),
      await api(t.base, 'PUT', '/api/ffmpeg'),
      await submitJob(t, 'big-h', {
        ...sampleBody(),
        ffmpeg_commands: ['x'.repeat(600 * 1024)],
      }),
      await api(t.base, 'GET', `${u.pathname}${u.search}`, { key: null }),
    ];
    expect(responses.map((r) => r.status)).toEqual([
      200, 401, 404, 404, 404, 405, 413, 410,
    ]);
    for (const r of responses)
      expect(r.headers.get('x-ffmpeg-server')).toBe('1');
    t.executor.heartbeatFresh = false;
    const r503 = await submitJob(t, 'h503', sampleBody(4));
    expect(r503.status).toBe(503);
    expect(r503.headers.get('x-ffmpeg-server')).toBe('1');
  });
});

describe('дедлайн фиксации приёма (FF-INT-09)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startTestApp({
      env: { FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS: '150' },
    });
  });
  afterEach(async () => {
    await t.close();
    cleanupDir(t.dir);
  });

  it('медленная фиксация → 503 SUBMIT_DEADLINE, ничего не создано; by-key — доказательный 404', async () => {
    t.executor.statusDelayMs = 400;
    const r = await submitJob(t, 'slow-commit');
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('SUBMIT_DEADLINE');
    expect(
      t.app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n,
    ).toBe(0);
    expect(
      t.app.ctx.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM idempotency_keys',
      )!.n,
    ).toBe(0);
    expect(
      (await api(t.base, 'GET', '/api/jobs/by-key/slow-commit')).status,
    ).toBe(404);
    // В пределах дедлайна — обычный приём.
    t.executor.statusDelayMs = 0;
    expect((await submitJob(t, 'slow-commit')).status).toBe(202);
  });
});
