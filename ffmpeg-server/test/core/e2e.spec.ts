/**
 * Сквозные тесты с настоящими модулями EXEC и настоящим ffmpeg (ТЗ §13):
 *  1) локальный HTTPS-источник (самоподписанный CA) → downloader → executor
 *     как отдельный процесс (файловый протокол) → GET status → скачивание;
 *  2) настоящий backend-клиент FfmpegApiService (см. backend-client.ts) →
 *     submit/status/ошибка/импорт результата, error_code в ошибке статуса.
 *
 * Executor запускается из сборки во временный каталог (tsc) — тем же
 * кодом, что `node dist/executor/main.js` в контейнере.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type App, createApp } from '../../src/app';
import { realPorts } from '../../src/queue/adapters';
import { makeVideo } from '../fixtures/media';
import { loadBackendFfmpegService } from './backend-client';
import { fakeFfmpegPrisma } from './fake-prisma';
import {
  CLIENT_KEY,
  OPS_KEY,
  api,
  cleanupDir,
  makeConfig,
  memoryLogger,
  tempDir,
  waitFor,
} from './helpers';

jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../..');
const TLS = path.join(ROOT, 'test/fixtures/tls');

describe('e2e: HTTPS-источник → executor-процесс с ffmpeg → выдача', () => {
  let dir: string;
  let build: string;
  let https: Server;
  let srcPort: number;
  let app: App;
  let base: string;
  let executor: ChildProcess;
  let executorLog = '';
  let offset = 0;
  const fixtures: Record<string, Buffer> = {};
  let logs: string[];

  beforeAll(async () => {
    dir = tempDir('ffs-e2e-');
    build = path.join(dir, 'build');
    const tsc = spawnSync(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '-p',
        path.join(ROOT, 'tsconfig.json'),
        '--outDir',
        build,
        '--incremental',
        'false',
        '--sourceMap',
        'false',
      ],
      { encoding: 'utf8' },
    );
    if (tsc.status !== 0) throw new Error(`tsc: ${tsc.stdout}${tsc.stderr}`);

    const media = path.join(dir, 'media');
    mkdirSync(media);
    makeVideo(path.join(media, 'video.mp4'), { w: 320, h: 240, d: 2 });
    fixtures['/video.mp4'] = readFileSync(path.join(media, 'video.mp4'));

    https = createServer(
      {
        key: readFileSync(path.join(TLS, 'server.key')),
        cert: readFileSync(path.join(TLS, 'server.crt')),
      },
      (req, res) => {
        const p = (req.url ?? '').split('?')[0];
        if (p === '/expired.mp4') {
          res.writeHead(403).end('expired');
          return;
        }
        const body = fixtures[p];
        if (!body) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': body.length,
        });
        res.end(body);
      },
    );
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
    srcPort = (https.address() as AddressInfo).port;

    const cfg = makeConfig(dir, {
      FFMPEG_SERVER_INPUT_ALLOWED_HOSTS: 'inputs.test',
      FFMPEG_SERVER_EXECUTOR_POLL_MS: '100',
      FFMPEG_SERVER_ALLOW_HTTP_PUBLIC_URL: '1',
    });
    const mem = memoryLogger();
    logs = mem.lines;
    app = await createApp({
      cfg,
      ports: realPorts(cfg),
      log: mem.log,
      now: () => Date.now() + offset,
      readinessCacheMs: 0,
      downloadExtra: {
        ca: readFileSync(path.join(TLS, 'ca.crt')),
        lookup: async () => [{ address: '127.0.0.1', family: 4 as const }],
        allowedPorts: [srcPort],
        addressAllowed: (a: string) => a === '127.0.0.1',
      },
    });
    const port = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
    cfg.publicBaseUrl = base; // ссылки на файлы — на этот же сервер

    executor = spawn(process.execPath, [path.join(build, 'executor/main.js')], {
      env: {
        PATH: process.env.PATH,
        WORKSPACE_ROOT: cfg.workspaceRoot,
        EXECUTOR_POLL_MS: '100',
        EXECUTOR_HEARTBEAT_MS: '300',
        EXECUTOR_TMP_DIR: path.join(dir, 'exec-tmp'),
        FFMPEG_BIN: process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg',
        FFPROBE_BIN: process.env.FFPROBE_BIN ?? '/usr/bin/ffprobe',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mkdirSync(path.join(dir, 'exec-tmp'), { recursive: true });
    executor.stdout?.on('data', (d) => (executorLog += String(d)));
    executor.stderr?.on('data', (d) => (executorLog += String(d)));
    try {
      await waitFor(
        async () =>
          (await api(base, 'GET', '/api/ready', { key: null })).status === 200,
        120_000,
        250,
      );
    } catch (e) {
      const r = await api(base, 'GET', '/api/ready', { key: null });
      throw new Error(
        `не ready: ${r.text}\nexecutor:\n${executorLog.slice(-4000)}`,
      );
    }
  });

  afterAll(async () => {
    executor?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    await app?.close();
    await new Promise<void>((r) => (https ? https.close(() => r()) : r()));
    cleanupDir(dir);
  });

  const src = (p: string) =>
    `https://inputs.test:${srcPort}${p}?sig=SECRET-SIG`;

  async function poll(id: string) {
    return waitFor(
      async () => {
        const r = await api(base, 'GET', `/api/jobs/${id}`);
        return ['succeeded', 'failed', 'canceled'].includes(
          r.json?.data?.status,
        )
          ? r
          : null;
      },
      120_000,
      200,
    );
  }

  it('цепочка: вторая команда читает результат первой; два outputs, скачивание и Range', async () => {
    const body = {
      input_files: { video: src('/video.mp4') },
      output_files: ['poster.jpg', 'clip.mp4'],
      ffmpeg_commands: [
        '-i {{video}} -t 1.5 -vf scale=160:-2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac {{clip.mp4}}',
        '-ss 1 -i {{clip.mp4}} -frames:v 1 -q:v 3 {{poster.jpg}}',
      ],
    };
    const r = await api(base, 'POST', '/api/ffmpeg', {
      body,
      headers: { 'Idempotency-Key': 'e2e-1' },
    });
    expect(r.status).toBe(202);
    const s = await poll(r.json.data.id);
    if (s.json.data.status !== 'succeeded') {
      const card = await api(base, 'GET', `/api/ops/jobs/${r.json.data.id}`, {
        key: (await import('./helpers')).OPS_KEY,
      });
      throw new Error(
        `job: ${JSON.stringify(s.json.data)}\ncard: ${JSON.stringify(card.json.data).slice(0, 3000)}\n${executorLog.slice(-3000)}`,
      );
    }
    const d = s.json.data;
    expect(d.ffmpeg_version).toMatch(/\d/);
    expect(
      d.outputs_metadata['clip.mp4'].streams.some(
        (x: { type: string }) => x.type === 'video',
      ),
    ).toBe(true);
    const poster = await fetch(d.output_files['poster.jpg']);
    expect(poster.status).toBe(200);
    const jpg = Buffer.from(await poster.arrayBuffer());
    expect(jpg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(createHash('sha256').update(jpg).digest('hex')).toBe(
      d.outputs_metadata['poster.jpg'].sha256,
    );
    const clip = await fetch(d.output_files['clip.mp4'], {
      headers: { Range: 'bytes=4-11' },
    });
    expect(clip.status).toBe(206);
    expect(Buffer.from(await clip.arrayBuffer()).toString('latin1')).toBe(
      'ftypisom',
    );
    expect(clip.headers.get('content-type')).toBe('video/mp4');
    // Workspace удалён, URL и подпись источника не попали в лог.
    await waitFor(
      () => !existsSync(path.join(app.ctx.cfg.workspaceRoot, d.id)),
    );
    expect(logs.join('\n')).not.toMatch(/SECRET-SIG|inputs\.test/);
  });

  it('настоящий backend FfmpegApiService: submit → status → импорт, повтор ключа, error_code', async () => {
    process.env.FFMPEG_SELFHOSTED_ENABLED = '1';
    process.env.FFMPEG_SELFHOSTED_BASE_URL = `${base}/api`;
    process.env.FFMPEG_SELFHOSTED_KEY = CLIENT_KEY;
    // Настоящий путь submit/status: закрепление отправки до сети, учёт
    // исхода, breaker — на in-memory моделях Prisma.
    const prisma = fakeFfmpegPrisma();
    const svc = loadBackendFfmpegService(prisma);
    try {
      const job = {
        inputs: { video: src('/video.mp4') },
        outputs: ['poster.jpg'],
        commands: ['-ss 1 -i {{video}} -frames:v 1 -q:v 3 {{poster.jpg}}'],
        product: 'shared-video',
        operationKey: 'shared-video:poster:42:v1',
        retrySubmit: false,
      };
      const ref = await svc.submit(job);
      expect(ref.jobId).toMatch(/^selfhosted:[0-9a-f-]{36}$/);
      expect(prisma.ffmpegSubmission.rows).toEqual([
        expect.objectContaining({
          idempotencyKey: 'shared-video:poster:42:v1',
          provider: 'selfhosted',
          state: 'accepted',
          jobId: ref.jobId,
        }),
      ]);
      // Потерянный ответ: повтор того же ключа операции — та же задача.
      expect((await svc.submit(job)).jobId).toBe(ref.jobId);
      const st = await waitFor(
        async () => {
          const x = await svc.status(ref.jobId);
          return x.status !== 'pending' ? x : null;
        },
        120_000,
        200,
      );
      expect(st.status).toBe('completed');
      const bytes = Buffer.from(
        await (await fetch(st.outputs!['poster.jpg'])).arrayBuffer(),
      );
      expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
      const row = app.ctx.db.get<{ client_operation_id: string }>(
        'SELECT client_operation_id FROM jobs WHERE id = ?',
        [ref.jobId.slice('selfhosted:'.length)],
      );
      expect(row?.client_operation_id).toBe(
        'shared-video:shared-video:poster:42:v1',
      );

      // Ошибка входа → failed с безопасным error_code в ошибке статуса.
      const bad = await svc.submit({
        ...job,
        inputs: { video: src('/expired.mp4') },
        operationKey: 'shared-video:poster:43:v1',
      });
      const badSt = await waitFor(
        async () => {
          const x = await svc.status(bad.jobId);
          return x.status !== 'pending' ? x : null;
        },
        60_000,
        200,
      );
      expect(badSt.status).toBe('failed');
      expect(badSt.errorCode).toBe('INPUT_EXPIRED');

      // После TTL файлов — terminal failed/OUTPUT_EXPIRED, а не вечный 410.
      offset = 25 * 3_600_000;
      await app.cleanup.run();
      const exp = await svc.status(ref.jobId);
      expect(exp.status).toBe('failed');
      expect(exp.errorCode).toBe('OUTPUT_EXPIRED');
      expect(exp.outputs).toBeUndefined();
      // Повтор операции после TTL через настоящий backend — тот же jobId и
      // ноль новых рендеров: ни задачи, ни попытки executor.
      const count = (sql: string) => app.ctx.db.get<{ n: number }>(sql)!.n;
      const jobsBefore = count('SELECT COUNT(*) AS n FROM jobs');
      const attemptsBefore = count('SELECT COUNT(*) AS n FROM attempts');
      const rendersBefore = count(
        'SELECT COUNT(*) AS n FROM attempts WHERE executor_started_at IS NOT NULL',
      );
      expect((await svc.submit(job)).jobId).toBe(ref.jobId);
      await waitFor(() => app.dispatcher.activeJobId() === null);
      expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(jobsBefore);
      expect(count('SELECT COUNT(*) AS n FROM attempts')).toBe(attemptsBefore);
      expect(
        count(
          'SELECT COUNT(*) AS n FROM attempts WHERE executor_started_at IS NOT NULL',
        ),
      ).toBe(rendersBefore);
      offset = 0;

      // После canceled новая попытка операции (ключ `:r1`) допустима —
      // ровно один новый рендер.
      const ops = (a: string) =>
        api(base, 'POST', `/api/control/${a}`, { key: OPS_KEY, body: {} });
      await ops('pause');
      const cJob = { ...job, operationKey: 'shared-video:poster:44:v1' };
      const c = await svc.submit(cJob);
      const cId = c.jobId.slice('selfhosted:'.length);
      expect(
        (await api(base, 'POST', `/api/jobs/${cId}/cancel`)).json.data.status,
      ).toBe('canceled');
      await ops('resume');
      const renders0 = count(
        'SELECT COUNT(*) AS n FROM attempts WHERE executor_started_at IS NOT NULL',
      );
      const retry = await svc.submit(cJob);
      expect(retry.jobId).not.toBe(c.jobId);
      const rId = retry.jobId.slice('selfhosted:'.length);
      const keyRow = app.ctx.db.get<{ job_id: string }>(
        'SELECT job_id FROM idempotency_keys WHERE key_hash = ?',
        [
          createHash('sha256')
            .update('shared-video:poster:44:v1:r1')
            .digest('hex'),
        ],
      );
      expect(keyRow?.job_id).toBe(rId);
      const rSt = await waitFor(
        async () => {
          const x = await svc.status(retry.jobId);
          return x.status !== 'pending' ? x : null;
        },
        120_000,
        200,
      );
      expect(rSt.status).toBe('completed');
      // Повтор после успеха новой попытки — без нового рендера.
      expect((await svc.submit(cJob)).jobId).toBe(retry.jobId);
      await waitFor(() => app.dispatcher.activeJobId() === null);
      expect(
        count(
          'SELECT COUNT(*) AS n FROM attempts WHERE executor_started_at IS NOT NULL',
        ),
      ).toBe(renders0 + 1);
    } finally {
      offset = 0;
      delete process.env.FFMPEG_SELFHOSTED_ENABLED;
      delete process.env.FFMPEG_SELFHOSTED_BASE_URL;
      delete process.env.FFMPEG_SELFHOSTED_KEY;
    }
  });

  it('обрыв ответа после приёма → сверка по ключу → тот же job; повтор и рестарт backend — без второго рендера', async () => {
    // Прокси между backend и сервером: первый POST доходит до сервера
    // (задача зафиксирована), а ответ клиенту обрывается.
    let dropNextSubmit = true;
    const proxy: HttpServer = createHttpServer((req, res) => {
      const target = new URL(base);
      const up = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (ur) => {
          if (
            dropNextSubmit &&
            req.method === 'POST' &&
            req.url === '/api/ffmpeg'
          ) {
            dropNextSubmit = false;
            ur.resume();
            ur.on('end', () => res.socket?.destroy());
            return;
          }
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const proxyPort = (proxy.address() as AddressInfo).port;
    process.env.FFMPEG_SELFHOSTED_ENABLED = '1';
    process.env.FFMPEG_SELFHOSTED_BASE_URL = `http://127.0.0.1:${proxyPort}/api`;
    process.env.FFMPEG_SELFHOSTED_KEY = CLIENT_KEY;
    process.env.FFMPEG_SELFHOSTED_COMMIT_DEADLINE_MS = '1000';
    const prisma = fakeFfmpegPrisma();
    try {
      const job = {
        inputs: { video: src('/video.mp4') },
        outputs: ['poster.jpg'],
        commands: ['-ss 0.5 -i {{video}} -frames:v 1 -q:v 4 {{poster.jpg}}'],
        product: 'shared-video',
        operationKey: 'shared-video:poster:drop:v1',
      };
      const svc = loadBackendFfmpegService(prisma);
      const ref = await svc.submit(job);
      expect(dropNextSubmit).toBe(false); // обрыв действительно был
      expect(ref.jobId).toMatch(/^selfhosted:/);
      // Повтор операции и «рестарт backend» (новый экземпляр, та же БД).
      expect((await svc.submit(job)).jobId).toBe(ref.jobId);
      const restarted = loadBackendFfmpegService(prisma);
      expect((await restarted.submit(job)).jobId).toBe(ref.jobId);
      // Строка «отправляется» → сверка; если бы процесс упал до сверки.
      prisma.ffmpegSubmission.rows[0].state = 'sending';
      prisma.ffmpegSubmission.rows[0].jobId = null;
      expect((await loadBackendFfmpegService(prisma).submit(job)).jobId).toBe(
        ref.jobId,
      );
      const id = ref.jobId.slice('selfhosted:'.length);
      expect(
        app.ctx.db.all('SELECT id FROM jobs WHERE id = ?', [id]),
      ).toHaveLength(1);
      expect(
        app.ctx.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM idempotency_keys WHERE job_id = ?',
          [id],
        )!.n,
      ).toBe(1);
      const st = await waitFor(
        async () => {
          const x = await svc.status(ref.jobId);
          return x.status !== 'pending' ? x : null;
        },
        120_000,
        200,
      );
      expect(st.status).toBe('completed');
      // Один рендер: одна попытка этой задачи и одна задача операции.
      expect(
        app.ctx.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM attempts WHERE job_id = ?',
          [id],
        )!.n,
      ).toBe(1);
      expect(
        app.ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM jobs WHERE client_operation_id LIKE '%shared-video:poster:drop:v1%'",
        )!.n,
      ).toBe(1);
      expect(prisma.ffmpegFallbackEvent.rows).toHaveLength(0);
    } finally {
      delete process.env.FFMPEG_SELFHOSTED_ENABLED;
      delete process.env.FFMPEG_SELFHOSTED_BASE_URL;
      delete process.env.FFMPEG_SELFHOSTED_KEY;
      delete process.env.FFMPEG_SELFHOSTED_COMMIT_DEADLINE_MS;
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });
});
