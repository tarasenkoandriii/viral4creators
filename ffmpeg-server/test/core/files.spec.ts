/**
 * Приватность результата (ТЗ §7, §13 «Защита»): bearer-ссылка с хешем в
 * БД, чужой клиент, срок ссылки и файла, отзыв при purge, Range/HEAD,
 * отсутствие query-токена в access log; OUTPUT_EXPIRED и повтор ключа
 * после TTL без нового рендера.
 */
import {
  CLIENT2_KEY,
  OPS_KEY,
  type TestApp,
  api,
  cleanupDir,
  startTestApp,
  submitJob,
  waitFor,
  waitStatus,
} from './helpers';

describe('выдача файлов', () => {
  let t: TestApp;
  let offset = 0;
  beforeEach(async () => {
    offset = 0;
    t = await startTestApp({ now: () => Date.now() + offset });
  });
  afterEach(async () => {
    await t.close();
    cleanupDir(t.dir);
  });

  async function done(key = 'f-1') {
    const r = await submitJob(t, key);
    const s = await waitStatus(t, r.json.data.id, ['succeeded']);
    // succeeded публикуется до освобождения слота (очистка workspace идёт
    // следом); purge в этом окне по контракту отвечает 202. Ждём слот.
    await waitFor(() => t.app.dispatcher.activeJobId() === null);
    const url = new URL(s.json.data.output_files['poster.jpg']);
    return {
      id: r.json.data.id as string,
      url,
      local: `${t.base}${url.pathname}${url.search}`,
    };
  }

  it('GET/HEAD/Range с нужными заголовками', async () => {
    const { local, id } = await done();
    const g = await fetch(local);
    expect(g.status).toBe(200);
    const body = await g.text();
    expect(body).toContain('rendered:outputs/poster.jpg');
    expect(g.headers.get('content-type')).toBe('image/jpeg');
    expect(g.headers.get('cache-control')).toBe('private, no-store');
    expect(g.headers.get('x-content-type-options')).toBe('nosniff');
    expect(g.headers.get('content-disposition')).toBe(
      `attachment; filename="poster.jpg"; filename*=UTF-8''poster.jpg`,
    );
    expect(g.headers.get('accept-ranges')).toBe('bytes');
    const h = await fetch(local, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.headers.get('content-length')).toBe(
      String(Buffer.byteLength(body)),
    );
    const r = await fetch(local, { headers: { Range: 'bytes=0-7' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(
      `bytes 0-7/${Buffer.byteLength(body)}`,
    );
    expect(await r.text()).toBe(body.slice(0, 8));
    const bad = await fetch(local, { headers: { Range: 'bytes=0-1,4-5' } });
    expect(bad.status).toBe(416);
    // Повторный status выдаёт новую ссылку, прежняя продолжает работать.
    const again = await api(t.base, 'GET', `/api/jobs/${id}`);
    expect(again.json.data.output_files['poster.jpg']).not.toBe(local);
    expect((await fetch(local)).status).toBe(200);
  });

  it('без токена 401, чужой/неверный токен 404, токен другой задачи 404', async () => {
    const a = await done('a');
    const b = await done('b');
    expect((await fetch(`${t.base}${a.url.pathname}`)).status).toBe(401);
    expect(
      (await fetch(`${t.base}${a.url.pathname}?token=${'x'.repeat(43)}`))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${t.base}${b.url.pathname}${a.url.search}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${t.base}/api/files/${a.id}/other.jpg${a.url.search}`))
        .status,
    ).toBe(404);
    // Чужой клиент не получает status/ссылку.
    expect(
      (await api(t.base, 'GET', `/api/jobs/${a.id}`, { key: CLIENT2_KEY }))
        .status,
    ).toBe(404);
    // В БД — только хеш токена.
    const token = a.url.searchParams.get('token')!;
    expect(
      JSON.stringify(t.app.ctx.db.all('SELECT * FROM download_tokens')),
    ).not.toContain(token);
  });

  it('срок ссылки 30 минут → 410, без продления при скачивании', async () => {
    const a = await done();
    offset = 29 * 60_000;
    expect((await fetch(a.local)).status).toBe(200);
    offset = 30 * 60_000 + 1000;
    expect((await fetch(a.local)).status).toBe(410);
  });

  it('TTL файла 24 ч: 410 по ссылке, status = failed/OUTPUT_EXPIRED, повтор ключа без рендера', async () => {
    const a = await done('ttl-key');
    offset = 24 * 3_600_000 + 1000;
    await t.app.cleanup.run();
    expect((await fetch(a.local)).status).toBe(410);
    const s = await api(t.base, 'GET', `/api/jobs/${a.id}`);
    expect(s.status).toBe(200);
    expect(s.json.data).toMatchObject({
      status: 'failed',
      error_code: 'OUTPUT_EXPIRED',
      execution_status: 'succeeded',
      output_files: {},
    });
    const again = await submitJob(t, 'ttl-key');
    expect(again.json.data.id).toBe(a.id);
    expect(t.executor.starts).toHaveLength(1);
    const card = await api(t.base, 'GET', `/api/ops/jobs/${a.id}`, {
      key: OPS_KEY,
    });
    expect(card.json.data.executed_but_files_gone).toBe(true);
  });

  it('purge отзывает выданную ссылку: 200, затем 410 и OUTPUT_PURGED; повтор безопасен', async () => {
    const a = await done();
    const p = await api(t.base, 'DELETE', `/api/jobs/${a.id}/artifacts`);
    expect(p.status).toBe(200);
    expect(p.json.data.purged).toBe(true);
    expect((await fetch(a.local)).status).toBe(410);
    const s = await api(t.base, 'GET', `/api/jobs/${a.id}`);
    expect(s.json.data).toMatchObject({
      status: 'failed',
      error_code: 'OUTPUT_PURGED',
      execution_status: 'succeeded',
      output_files: {},
    });
    expect(
      (await api(t.base, 'DELETE', `/api/jobs/${a.id}/artifacts`)).status,
    ).toBe(200);
    expect(
      t.app.ctx.db.all("SELECT * FROM events WHERE type = 'job.purged'"),
    ).toHaveLength(1);
    // ops не может выпустить ссылку на удалённое.
    const link = await api(
      t.base,
      'POST',
      `/api/ops/jobs/${a.id}/download-link`,
      {
        key: OPS_KEY,
        body: { file: 'poster.jpg' },
      },
    );
    expect(link.status).toBe(410);
  });

  it('query-токен и имя файла не попадают в access log', async () => {
    const a = await done();
    await fetch(a.local);
    const token = a.url.searchParams.get('token')!;
    const logs = t.logs.join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('token=');
    expect(logs).toContain(`/api/files/${a.id}/:name`);
  });

  it('ops download-link выдаёт короткую ссылку', async () => {
    const a = await done();
    const link = await api(
      t.base,
      'POST',
      `/api/ops/jobs/${a.id}/download-link`,
      {
        key: OPS_KEY,
        body: { file: 'poster.jpg' },
      },
    );
    expect(link.status).toBe(200);
    const u = new URL(link.json.data.url);
    expect((await fetch(`${t.base}${u.pathname}${u.search}`)).status).toBe(200);
  });
});
