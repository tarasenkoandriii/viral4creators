// Вкладка «FFmpeg: обработка» (ТЗ FFmpeg-server v1.1 §13.1): запросы к
// backend `/admin/ffmpeg/*` (адреса, методы, тела DTO с operationId,
// отмена по AbortSignal), разбор снимков `{state, fetchedAt, error, data}`
// с сырыми данными ops-API (нет данных ≠ ноль), свежесть, фильтры в адресе
// и период по умолчанию 24 ч, метка «выполнено, но файлы истекли/
// отозваны», приватность (имена без URL, stderr ≤64 KiB), безопасный
// предпросмотр (никаких SVG/HTML), сверка мутации тем же ключом при обрыве
// и `outcome: unknown`, тексты ошибок (403/409/503), backoff опроса,
// лимиты и маршрутизация.
// Запуск (из admin/): npx tsx src/lib/ffmpeg.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiRequestError } from './admin-api';
import {
  DEFAULT_FILTERS,
  FFMPEG_REFRESH_MAX_MS,
  FFMPEG_REFRESH_MS,
  FFMPEG_STDERR_MAX_BYTES,
  FfmpegFailedOutcome,
  FfmpegTimeoutError,
  FfmpegUnknownOutcome,
  cancelFfmpegJob,
  canCancel,
  canPurge,
  cleanId,
  cleanJobId,
  cleanStderr,
  createFfmpegDownloadLink,
  diffLimits,
  diffRouting,
  errorNeedsReload,
  ffmpegControl,
  ffmpegErrorText,
  ffmpegHref,
  filesGone,
  filtersToQuery,
  filtersToSearch,
  formatBytes,
  freshness,
  fromDisplay,
  getFfmpegJob,
  getFfmpegLimits,
  getFfmpegOverview,
  isInternalHref,
  isUnknownOutcome,
  listFfmpegJobs,
  mutationResultText,
  newOperationId,
  nextPollDelay,
  normalizeJobDetail,
  normalizeJobsPage,
  normalizeLimits,
  normalizeOverview,
  operationLinks,
  parseFilters,
  previewKind,
  purgeFfmpegJob,
  reasonValid,
  reconcileFfmpegJob,
  redactSecrets,
  runWithReconcile,
  safeFileName,
  setFfmpegLimits,
  setFfmpegRouting,
  routingSchemeText,
  toDisplay,
} from './ffmpeg';
import { actionLabel } from './attention';
import type { FfmpegMutationResult, FfmpegRouting } from './types';

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ success: false, error: { code, message, ...(details ? { details } : {}) }, meta: { timestamp: '', requestId: 'r' } }),
    { status },
  );
const outcome = (o: Partial<FfmpegMutationResult> = {}): FfmpegMutationResult => ({
  operationId: 'op',
  correlationId: 'c0rrelat10n',
  action: 'pause',
  outcome: 'succeeded',
  replayed: false,
  message: 'Выполнено',
  result: {},
  ...o,
});

async function main() {
  // ── Запросы: адреса, методы, тела DTO backend ──
  const calls: Array<{ url: string; method: string; body: unknown; credentials?: RequestCredentials; signal?: AbortSignal | null }> = [];
  let reply: (url: string) => Response = () => ok(outcome());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
      signal: init?.signal,
    });
    return reply(String(input));
  }) as typeof fetch;
  const op = newOperationId();
  assert.match(op, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'operationId — UUID (IsUUID в DTO)');
  reply = (url) =>
    url.includes('download-link')
      ? ok(outcome({ result: { file: 'poster.jpg', url: 'https://ff.example/f?token=t', expiresAt: '2026-10-21T10:30:00.000Z', mime: 'image/jpeg' } }))
      : ok(outcome());
  await getFfmpegOverview();
  await listFfmpegJobs(filtersToQuery({ ...DEFAULT_FILTERS, state: 'failed', operationId: 'story:abc', jobId: 'selfhosted:a1' }));
  await getFfmpegJob('selfhosted:1/2');
  await getFfmpegLimits();
  await ffmpegControl('pause', { operationId: op, reason: 'обслуживание' });
  await ffmpegControl('drain', { operationId: op, reason: 'обслуживание' });
  await ffmpegControl('resume', { operationId: op, reason: 'обслуживание' });
  await cancelFfmpegJob('selfhosted:x', { operationId: op, reason: 'дубль' });
  await purgeFfmpegJob('selfhosted:x', { operationId: op, reason: 'отзыв согласия', confirmIrreversible: true });
  await reconcileFfmpegJob('hosted-1', { operationId: op });
  await ffmpegControl('resume', { operationId: op, reason: 'очередь сверена', reconciled: true });
  await reconcileFfmpegJob('selfhosted:x', { operationId: op, reason: 'жалоба клиента' });
  await setFfmpegLimits({ operationId: op, reason: 'тест', expectedRevision: 4, limits: { maxThreads: 2 } });
  await setFfmpegRouting({ operationId: op, reason: 'canary', expectedRevision: 7, defaultProvider: 'hosted', canaryProducts: ['story'] });
  const link = await createFfmpegDownloadLink('selfhosted:x', { operationId: op, file: 'poster.jpg', reason: 'проверка' });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url.replace(/^.*?\/api/, '')]),
    [
      ['GET', '/admin/ffmpeg/overview'],
      ['GET', '/admin/ffmpeg/jobs?period=24h&state=failed&clientOperationId=story%3Aabc&jobId=selfhosted%3Aa1'],
      ['GET', '/admin/ffmpeg/jobs/selfhosted%3A1%2F2'],
      ['GET', '/admin/ffmpeg/limits'],
      ['POST', '/admin/ffmpeg/pause'],
      ['POST', '/admin/ffmpeg/drain'],
      ['POST', '/admin/ffmpeg/resume'],
      ['POST', '/admin/ffmpeg/jobs/selfhosted%3Ax/cancel'],
      ['POST', '/admin/ffmpeg/jobs/selfhosted%3Ax/purge'],
      ['POST', '/admin/ffmpeg/jobs/hosted-1/reconcile'],
      ['POST', '/admin/ffmpeg/resume'],
      ['POST', '/admin/ffmpeg/jobs/selfhosted%3Ax/reconcile'],
      ['POST', '/admin/ffmpeg/limits'],
      ['POST', '/admin/ffmpeg/routing'],
      ['POST', '/admin/ffmpeg/jobs/selfhosted%3Ax/download-link'],
    ],
    'адреса и методы контроллера; id экранированы; /api не дублируется',
  );
  assert.ok(calls.every((c) => c.credentials === 'include'), 'cookie админки на каждом запросе');
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal), 'каждый запрос отменяем');
  assert.ok(calls.slice(0, 4).every((c) => c.body === undefined), 'GET без тела');
  assert.deepEqual(calls[4].body, { operationId: op, reason: 'обслуживание' });
  assert.deepEqual(calls[7].body, { operationId: op, reason: 'дубль' });
  assert.deepEqual(calls[8].body, { operationId: op, reason: 'отзыв согласия', confirmIrreversible: true }, 'purge — с явным подтверждением');
  assert.deepEqual(calls[9].body, { operationId: op }, 'reconcile без причины — без лишних полей (forbidNonWhitelisted)');
  assert.deepEqual(calls[10].body, { operationId: op, reason: 'очередь сверена', reconciled: true }, 'выход из recovery — reconciled: true');
  assert.deepEqual(calls[11].body, { operationId: op, reason: 'жалоба клиента' }, 'причина сверки, если введена');
  assert.deepEqual(calls[12].body, { operationId: op, reason: 'тест', expectedRevision: 4, limits: { maxThreads: 2 } });
  assert.deepEqual(calls[13].body, { operationId: op, reason: 'canary', expectedRevision: 7, defaultProvider: 'hosted', canaryProducts: ['story'] });
  assert.deepEqual(calls[14].body, { operationId: op, file: 'poster.jpg', reason: 'проверка' });
  assert.deepEqual(link, { file: 'poster.jpg', url: 'https://ff.example/f?token=t', expiresAt: '2026-10-21T10:30:00.000Z', mime: 'image/jpeg' });

  // Backend: исход неизвестен (200 + outcome unknown) и записанный отказ.
  reply = () => ok(outcome({ outcome: 'unknown', message: 'Результат неизвестен, сверяем: timeout' }));
  await assert.rejects(ffmpegControl('pause', { operationId: op }), (e: unknown) => e instanceof FfmpegUnknownOutcome && isUnknownOutcome(e));
  reply = () => ok(outcome({ outcome: 'failed', replayed: true, message: 'Операция уже выполнялась' }));
  await assert.rejects(ffmpegControl('pause', { operationId: op }), (e: unknown) => e instanceof FfmpegFailedOutcome && !isUnknownOutcome(e));
  // Ссылка не https — не принимается.
  reply = () => ok(outcome({ result: { file: 'a.jpg', url: 'javascript:alert(1)' } }));
  await assert.rejects(createFfmpegDownloadLink('selfhosted:x', { operationId: op, file: 'a.jpg' }), ApiRequestError);

  // Отмена при уходе: внешний AbortSignal обрывает запрос.
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
  const ctrl = new AbortController();
  const pending = getFfmpegOverview(ctrl.signal);
  ctrl.abort();
  await assert.rejects(pending, (e: unknown) => (e as Error).name === 'AbortError', 'уход со страницы отменяет запрос');

  // Ошибка — конверт фильтра: класс в error.code, машинный код в details.code.
  globalThis.fetch = (async () => fail(409, 'Conflict', 'Маршрутизацию уже изменили', { code: 'FFMPEG_STALE_REVISION' })) as typeof fetch;
  await assert.rejects(setFfmpegRouting({ operationId: op, expectedRevision: 1, defaultProvider: 'hosted', canaryProducts: [] }), (e: unknown) => {
    assert.ok(e instanceof ApiRequestError);
    assert.equal(e.httpStatus, 409);
    assert.ok(errorNeedsReload(e), '409 — перечитать экран');
    assert.match(ffmpegErrorText(e, 'configure'), /ревизия устарела/);
    assert.ok(!isUnknownOutcome(e));
    return true;
  });
  globalThis.fetch = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
  await assert.rejects(getFfmpegOverview(), (e: unknown) => e instanceof ApiRequestError && e.httpStatus === 502);

  // ── Сводка: снимок сервера ──
  const t0 = '2026-10-21T10:00:00.000Z';
  const routing = {
    revision: 3,
    defaultProvider: 'hosted',
    canaryProducts: ['story', 'nope'],
    updatedAt: t0,
    selfhostedGateEnabled: true,
    selfhostedConfigured: true,
    effectiveDefaultProvider: 'hosted',
    effectiveCanaryProducts: ['story'],
  };
  const opsOverview = {
    generated_at: t0,
    control: { mode: 'paused', revision: 2, reason: 'обслуживание', updated_at: t0 },
    ready: { ready: false, checks: {}, reasons: ['executor_heartbeat_stale', 'disk_low_x'], checked_at: t0 },
    queue: { counts: { queued: 2, succeeded: 10 }, failed_24h: 3, oldest_queued_age_sec: 40, max_queued: 20 },
    active: null,
    executor: { heartbeat_at: t0, fresh: true, busy: false, ffmpeg_version: '6.1.1', started_at: t0 },
    capabilities: { ok: true, missing: [], checked_at: t0, ffmpeg_version: '6.1.1' },
    disk: {
      measured_at: t0,
      free_bytes: 20e9,
      min_free_bytes: 15 * 2 ** 30,
      workspaces_bytes: 1e6,
      max_workspaces_bytes: 15 * 2 ** 30,
      outputs_bytes: 0,
      max_outputs_bytes: 10 * 2 ** 30,
    },
    limits_revision: 4,
    image_digest: 'sha256:abc',
  };
  const fresh = normalizeOverview({
    generatedAt: t0,
    routing,
    selfhosted: { state: 'ok', fetchedAt: t0, error: null, data: opsOverview, configuration: { baseUrl: true } },
    hosted: { configured: true, note: 'Внешний провайдер не отдаёт очередь' },
    usage24h: { hosted: 5, selfhosted: 1 },
    permissions: ['ffmpeg.read', 'ffmpeg.operate'],
  });
  assert.equal(fresh.source, 'ok');
  assert.deepEqual(fresh.routing.value?.canaryProducts, ['story'], 'неизвестный продукт отброшен');
  assert.equal(fresh.acceptMode.value, 'paused');
  assert.equal(fresh.worker.value, 'paused');
  assert.equal(fresh.ready.value?.ready, false);
  assert.equal(fresh.ready.value?.reason, 'heartbeat executor устарел; disk_low_x', 'причина отказа — словами, неизвестная как есть');
  assert.deepEqual(
    fresh.jobs.value,
    { active: 0, queued: 2, failed: 3, oldestQueuedAgeSec: 40, maxQueued: 20 },
    'нет processing в counts — честный 0 при ответившем сервере',
  );
  assert.equal(fresh.disk.value?.freeBytes, 20e9);
  assert.equal(fresh.image.value?.ffmpegVersion, '6.1.1');
  assert.equal(fresh.executor.value, null, 'CPU/RAM сервер не сообщает — «нет данных», не ноль');
  assert.match(fresh.executor.reason ?? '', /не сообщает/);
  assert.equal(fresh.routing.value?.fallbackToHosted, false);
  assert.equal(fresh.fallbacks24h.value, null, 'нет счётчика — не ноль');
  // Основной — свой сервер, запасной — внешний; breaker и счётчики.
  const primary = normalizeOverview({
    generatedAt: t0,
    routing: {
      ...routing,
      defaultProvider: 'selfhosted',
      canaryProducts: [],
      effectiveDefaultProvider: 'selfhosted',
      fallbackToHosted: true,
      breaker: { failures: 3, threshold: 3, open: true, openUntil: '2026-10-21T10:05:00.000Z' },
    },
    selfhosted: {
      state: 'ok',
      fetchedAt: t0,
      data: { ...opsOverview, executor: { fresh: true, resources: { idle: false, cpu_percent: 143.5, rss_kb: 1024, peak_rss_kb: 2048, sampled_at: t0, stale: false } } },
    },
    fallbacks24h: 4,
  });
  assert.deepEqual(primary.routing.value?.breaker, { open: true, openUntil: '2026-10-21T10:05:00.000Z', failures: 3, threshold: 3 });
  assert.equal(routingSchemeText(primary.routing.value!), 'основной: свой сервер, запасной: внешний сервис');
  assert.equal(routingSchemeText({ effectiveDefaultProvider: 'selfhosted', fallbackToHosted: false }), 'основной: свой сервер, запасного нет');
  assert.equal(routingSchemeText({ effectiveDefaultProvider: 'hosted', fallbackToHosted: true }), 'основной: внешний сервис');
  assert.equal(primary.fallbacks24h.value, 4);
  assert.deepEqual(primary.executor.value, { idle: false, cpuPercent: 143.5, rssBytes: 1024 * 1024, peakRssBytes: 2048 * 1024, sampledAt: t0, stale: false });
  assert.equal(freshness(primary.executor, Date.parse(t0) + 1000), 'fresh');
  const idleEx = normalizeOverview({ generatedAt: t0, routing, selfhosted: { state: 'ok', fetchedAt: t0, data: { ...opsOverview, executor: { fresh: true, resources: { idle: true, sampled_at: null } } } } });
  assert.equal(idleEx.executor.value?.idle, true, 'простой — явно, не «0%»');
  assert.equal(idleEx.executor.observedAt, t0);
  const staleEx = normalizeOverview({ generatedAt: t0, routing, selfhosted: { state: 'ok', fetchedAt: t0, data: { ...opsOverview, executor: { resources: { idle: false, cpu_percent: 5, sampled_at: '2026-10-21T09:00:00.000Z', stale: true } } } } });
  assert.equal(freshness(staleEx.executor, Date.parse(t0)), 'stale', 'устаревший замер помечен');
  assert.match(staleEx.executor.reason ?? '', /устарел/);
  assert.deepEqual(fresh.usage24h.value, { hosted: 5, selfhosted: 1 });
  assert.deepEqual(fresh.permissions, ['ffmpeg.read', 'ffmpeg.operate']);
  assert.equal(freshness(fresh.jobs, Date.parse(t0) + 5_000), 'fresh');
  assert.equal(freshness(fresh.jobs, Date.parse(t0) + 60_000), 'stale', 'старое значение помечено');
  const running = normalizeOverview({
    generatedAt: t0,
    routing,
    selfhosted: {
      state: 'ok',
      fetchedAt: t0,
      data: { ...opsOverview, control: { mode: 'active' }, active: { id: 'j1', stage: 'running', progress: 40, client_operation_id: 'story:x' } },
    },
  });
  assert.equal(running.worker.value, 'running');
  assert.deepEqual(running.activeJob, { id: 'selfhosted:j1', operationId: 'story:x', stage: 'running', progress: 40 });
  const exDown = normalizeOverview({
    generatedAt: t0,
    routing,
    selfhosted: { state: 'ok', fetchedAt: t0, data: { ...opsOverview, control: { mode: 'active' }, executor: { fresh: false } } },
  });
  assert.equal(exDown.worker.value, 'executor-down');

  const down = normalizeOverview({
    generatedAt: t0,
    routing,
    selfhosted: { state: 'error', fetchedAt: null, error: 'FFmpeg-сервер не ответил за 5 с', data: null },
  });
  assert.equal(down.stale, true);
  assert.equal(down.staleReason, 'FFmpeg-сервер не ответил за 5 с');
  assert.equal(down.jobs.value, null, 'недоступный VPS — не пустая очередь');
  assert.equal(freshness(down.jobs, Date.parse(t0)), 'missing');
  assert.equal(down.jobs.reason, 'FFmpeg-сервер не ответил за 5 с');
  assert.equal(down.disk.value, null);
  assert.equal(down.worker.value, null);
  assert.equal(freshness(down.routing, Date.parse(t0)), 'fresh', 'маршрутизация из БД backend свежа при лежащем VPS');
  const old = normalizeOverview({
    generatedAt: t0,
    routing,
    selfhosted: { state: 'stale', fetchedAt: '2026-10-21T09:50:00.000Z', error: 'timeout', data: opsOverview },
  });
  assert.equal(old.jobs.value?.queued, 2, 'stale — последние известные значения');
  assert.equal(freshness(old.jobs, Date.parse(t0)), 'stale', 'и они помечены устаревшими');
  assert.equal(old.jobs.observedAt, '2026-10-21T09:50:00.000Z');
  const nc = normalizeOverview({
    generatedAt: t0,
    routing: { ...routing, selfhostedConfigured: false },
    selfhosted: { state: 'not-configured', fetchedAt: null, error: null, data: null },
  });
  assert.equal(nc.source, 'not-configured');
  assert.match(nc.staleReason ?? '', /не настроен/);
  const empty = normalizeOverview({});
  assert.equal(empty.jobs.value, null);
  assert.equal(empty.routing.value, null);

  // ── Список задач ──
  const page = normalizeJobsPage({
    provider: 'selfhosted',
    state: 'ok',
    fetchedAt: t0,
    error: null,
    items: [
      {
        id: 'u1',
        jobId: 'selfhosted:u1',
        providerJobId: 'u1',
        provider: 'selfhosted',
        product: 'story',
        client_operation_id: 'story:abc',
        status: 'failed',
        stage: 'done',
        error_code: 'OUTPUT_EXPIRED',
        execution_status: 'succeeded',
        attempts: 1,
        output_bytes: 1000,
        queue_delay_sec: 3,
        run_sec: 40,
        created_at: t0,
        finished_at: t0,
        expires_at: t0,
        purged_at: null,
      },
      { bad: true },
    ],
    nextCursor: '17',
    productFilter: 'page',
  });
  assert.equal(page.items.length, 1);
  const row = page.items[0];
  assert.equal(row.id, 'selfhosted:u1');
  assert.equal(row.operationId, 'story:abc');
  assert.equal(row.queueMs, 3000);
  assert.equal(row.runMs, 40_000);
  assert.equal(row.artifacts, 'expired');
  assert.equal(filesGone(row), 'expired', '«выполнено, но файлы истекли»');
  assert.equal(page.nextCursor, '17');
  assert.ok(page.productFilterPageOnly);
  const hostedPage = normalizeJobsPage({
    provider: 'hosted',
    state: 'unsupported',
    fetchedAt: null,
    error: 'Внешний провайдер не отдаёт список задач — найдите задачу по id',
    items: null,
    nextCursor: null,
  });
  assert.equal(hostedPage.source, 'unsupported');
  assert.deepEqual(hostedPage.items, []);
  assert.match(hostedPage.staleReason ?? '', /по id/);
  const errPage = normalizeJobsPage({ provider: 'selfhosted', state: 'error', fetchedAt: null, error: 'timeout', items: null, nextCursor: null });
  assert.ok(errPage.stale && errPage.items.length === 0, 'ошибка — пусто, но помечено как недоступность');

  // ── Карточка задачи ──
  const big = 'x'.repeat(FFMPEG_STDERR_MAX_BYTES + 5000);
  const detail = normalizeJobDetail({
    jobId: 'selfhosted:11111111-2222-4333-8444-555555555555',
    provider: 'selfhosted',
    state: 'ok',
    fetchedAt: t0,
    error: null,
    data: {
      id: '11111111-2222-4333-8444-555555555555',
      status: 'failed',
      stage: 'done',
      error_code: 'OUTPUT_PURGED',
      error_message: 'outputs purged',
      execution_status: 'succeeded',
      client_operation_id: 'tutorial-runner:a1',
      product: 'tutorial-runner',
      created_at: '2026-10-21T09:00:00.000Z',
      started_at: '2026-10-21T09:00:05.000Z',
      finished_at: t0,
      input_names: ['base', 'https://storage.example/v.mp4?token=abc'],
      output_names: ['poster.jpg', 'x'],
      inputs_metadata: [
        { key: 'base', bytes: 5, sha256: 'B'.repeat(64), mime: 'video/mp4', format: 'mov', durationSec: 1.5, streams: [{ type: 'video', codec: 'h264', width: 1280, height: 720 }] },
      ],
      outputs_metadata: { 'poster.jpg': { bytes: 10, sha256: 'A'.repeat(64), mime: 'image/jpeg' } },
      artifacts: [
        { name: 'poster.jpg', bytes: 10, sha256: 'A'.repeat(64), mime: 'image/jpeg', purged_at: t0 },
        { name: 'x', sha256: 'zz' },
      ],
      resources: { wall_ms: 1000, cpu_ms: 900, peak_rss_kb: 2048, input_bytes: 5, output_bytes: 10, exit_code: 0 },
      attempts: [{ n: 1, status: 'finished', outcome: 'succeeded', wall_ms: 1000 }],
      timeline: [
        { at: t0, type: 'job.accepted', data: null },
        { at: t0, type: 'stage.downloading', data: { input: 'base', url: 'https://x.example/a?sig=1' } },
      ],
      stderr_tail: `Input #0 from 'https://bucket.example/in.mp4?X-Amz-Signature=deadbeef'\nAuthorization: Bearer abcdefghijkl\n${big}`,
      purged_at: t0,
      ffmpeg_version: '6.1.1',
      image_digest: 'sha256:abc',
      limits_revision: 4,
    },
    owners: [
      { kind: 'tutorial-asset', id: 'a', label: 'Tutorial: ролик a', href: '/tutorial-scenarios?asset=a' },
      { kind: 'evil', id: 'b', label: 'x', href: 'https://evil.example' },
    ],
    actions: [
      { id: 'j1', operationId: 'o', phase: 'succeeded', actorUserId: 'user-1', action: 'job.purge', jobId: 'selfhosted:1', reason: 'отзыв', createdAt: t0, correlationId: 'c' },
    ],
  });
  assert.equal(detail.provider, 'selfhosted');
  assert.equal(detail.id, 'selfhosted:11111111-2222-4333-8444-555555555555');
  assert.equal(detail.product, 'tutorial-runner');
  assert.deepEqual(detail.inputs.map((i) => i.name), ['base', '[имя скрыто]'], 'URL вместо имени не показывается');
  assert.equal(detail.inputs[0].sha256, 'b'.repeat(64));
  assert.equal(detail.inputs[0].streams[0].width, 1280);
  assert.deepEqual(detail.outputs.map((o) => o.name), ['poster.jpg', 'x']);
  assert.equal(detail.outputs[0].sha256, 'a'.repeat(64));
  assert.equal(detail.outputs[0].purgedAt, t0);
  assert.equal(detail.outputs[1].sha256, null, 'негодный хеш не показывается');
  assert.equal(detail.artifacts, 'purged');
  assert.equal(filesGone(detail), 'purged', '«выполнено, но файлы отозваны»');
  assert.equal(detail.resources?.queueDelayMs, 5000);
  assert.equal(detail.attemptsDetail[0].outcome, 'succeeded');
  assert.equal(detail.timeline[1].stage, 'downloading');
  assert.ok(!/https?:/.test(detail.timeline[1].note ?? ''), 'данные события без URL');
  assert.ok(detail.stderrTruncated, 'длинный stderr — только хвост');
  assert.ok(new TextEncoder().encode(detail.stderr ?? '').length <= FFMPEG_STDERR_MAX_BYTES);
  assert.ok(!/deadbeef|abcdefghijkl|https?:/.test(detail.stderr ?? ''), 'секреты из stderr вычищены');
  assert.deepEqual(detail.owners, [{ label: 'Tutorial: ролик a', href: '/tutorial-scenarios?asset=a' }], 'внешняя ссылка владельца отброшена');
  assert.equal(detail.actions[0].result, 'succeeded');
  assert.deepEqual(operationLinks(detail), [{ href: '/tutorial-scenarios?asset=a', label: 'Tutorial: ролик a' }]);
  assert.deepEqual(operationLinks({ owners: [], product: 'story' }), [{ href: '/story-tales', label: 'Раздел «Story‑Tales»' }], 'без точной ссылки — раздел продукта');
  assert.deepEqual(operationLinks({ product: 'nope' }), []);

  const hostedCard = normalizeJobDetail({
    jobId: 'abc123',
    provider: 'hosted',
    state: 'ok',
    fetchedAt: t0,
    data: { status: 'succeeded', errorCode: null, error: null, outputNames: ['out.mp4'] },
    owners: [],
    actions: [],
  });
  assert.equal(hostedCard.provider, 'hosted', 'старый id без префикса — hosted');
  assert.equal(hostedCard.state, 'succeeded');
  assert.deepEqual(hostedCard.outputs.map((o) => o.name), ['out.mp4']);
  assert.equal(hostedCard.artifacts, null);
  assert.ok(!canPurge(hostedCard), 'hosted не чистится отсюда');
  const downCard = normalizeJobDetail({ jobId: 'selfhosted:z', provider: 'selfhosted', state: 'error', fetchedAt: null, error: 'timeout', data: null, owners: [], actions: [] });
  assert.ok(downCard.stale);
  assert.equal(downCard.state, 'unknown', 'нет данных — «исход неизвестен», а не «в очереди»');
  assert.equal(normalizeJobDetail({ jobId: 'selfhosted:q', provider: 'selfhosted', state: 'ok', data: { status: 'weird' } }).state, 'unknown');

  assert.equal(filesGone({ state: 'succeeded', executionStatus: 'succeeded', errorCode: null, artifacts: 'purging' }), 'purging');
  assert.equal(filesGone({ state: 'failed', executionStatus: 'failed', errorCode: 'OUTPUT_EXPIRED', artifacts: 'expired' }), null, 'не выполнялась — не «выполнено»');
  assert.equal(filesGone({ state: 'succeeded', executionStatus: 'succeeded', errorCode: null, artifacts: 'available' }), null);
  assert.equal(cleanStderr('short').truncated, false);
  const cyr = cleanStderr('я'.repeat(FFMPEG_STDERR_MAX_BYTES));
  assert.ok(!cyr.text.startsWith('\uFFFD'), 'кириллица на границе — без битого символа');

  assert.ok(canCancel({ state: 'queued' }) && canCancel({ state: 'processing' }));
  assert.ok(!canCancel({ state: 'succeeded' }) && !canCancel({ state: 'unknown' }));
  assert.ok(canPurge({ provider: 'selfhosted', artifacts: 'available' }));
  assert.ok(!canPurge({ provider: 'selfhosted', artifacts: 'purged' }) && !canPurge({ provider: 'selfhosted', artifacts: 'purging' }));

  // ── Приватность и безопасный предпросмотр ──
  assert.equal(safeFileName('poster.jpg'), 'poster.jpg');
  for (const bad of ['https://a/b', '/etc/passwd', '../x', 'a?token=1', 'c:\\x']) assert.equal(safeFileName(bad), '[имя скрыто]', bad);
  assert.equal(redactSecrets('see https://h.example/p?a=1 ok'), 'see [url скрыт] ok');
  assert.equal(redactSecrets('token=abc&x=1'), 'token=[скрыт]&x=1');
  assert.equal(previewKind('image/png'), 'image');
  assert.equal(previewKind('video/mp4; codecs=avc1'), 'video');
  assert.equal(previewKind('audio/mpeg'), 'audio');
  for (const m of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/octet-stream', null, 'application/pdf'])
    assert.equal(previewKind(m), null, `без встраивания: ${m}`);
  assert.ok(isInternalHref('/story-tales?x=1'));
  for (const bad of ['//evil.example', 'javascript:alert(1)', 'https://x', '/\\evil', '/a b', '/javascript:x']) assert.ok(!isInternalHref(bad), bad);

  // ── Фильтры в адресе ──
  const p = (s: string) => parseFilters(new URLSearchParams(s));
  assert.deepEqual(p(''), DEFAULT_FILTERS, 'по умолчанию последние 24 часа, без фильтров');
  assert.equal(filtersToSearch(DEFAULT_FILTERS), '', 'умолчания в адрес не пишутся');
  const f = p('state=failed&provider=hosted&product=story&operationId=story:op-1&jobId=abc&period=7d&junk=1');
  assert.deepEqual(f, { provider: 'hosted', state: 'failed', product: 'story', operationId: 'story:op-1', jobId: 'abc', period: '7d' });
  assert.deepEqual(p(filtersToSearch(f).slice(1)), f, 'адрес ↔ фильтры без потерь');
  assert.deepEqual(p('state=evil&provider=x&product=y&period=99y'), DEFAULT_FILTERS, 'мусор отброшен');
  assert.equal(p('provider=selfhosted').provider, '', 'selfhosted — умолчание');
  assert.equal(p('operationId=' + 'a'.repeat(129)).operationId, '', 'id операции длиннее 128 отброшен');
  assert.equal(p('jobId=a%20b').jobId, '', 'пробел в id недопустим');
  assert.equal(cleanId('  ok-1 '), 'ok-1');
  assert.equal(cleanJobId('selfhosted:ab-1'), 'selfhosted:ab-1');
  assert.equal(cleanJobId('../x'), '');
  assert.equal(filtersToSearch(f, 'selfhosted:abc').includes('job=selfhosted%3Aabc'), true);
  assert.equal(ffmpegHref({ state: 'failed' }, 'selfhosted:j1'), '/ffmpeg?state=failed&job=selfhosted%3Aj1', 'ссылка для очереди внимания');
  assert.equal(ffmpegHref(), '/ffmpeg');
  assert.deepEqual(filtersToQuery(DEFAULT_FILTERS), { period: '24h' }, '24 ч по умолчанию');
  assert.deepEqual(filtersToQuery(f, 'c2'), {
    period: '7d',
    cursor: 'c2',
    provider: 'hosted',
    state: 'failed',
    product: 'story',
    clientOperationId: 'story:op-1',
    jobId: 'abc',
  });

  // ── Опрос: 10 с, backoff ×2 до потолка ──
  assert.equal(nextPollDelay(0), FFMPEG_REFRESH_MS);
  assert.equal(nextPollDelay(1), 20_000);
  assert.equal(nextPollDelay(2), 40_000);
  assert.equal(nextPollDelay(50), FFMPEG_REFRESH_MAX_MS);

  // ── Мутации: сверка тем же ключом ──
  assert.ok(isUnknownOutcome(new TypeError('Failed to fetch')));
  assert.ok(isUnknownOutcome(new FfmpegTimeoutError()));
  assert.ok(isUnknownOutcome(new ApiRequestError('x', 504)));
  assert.ok(!isUnknownOutcome(new ApiRequestError('x', 503, 'Service Unavailable', { code: 'FFMPEG_NOT_CONFIGURED' })), 'не настроено — определённый отказ');
  assert.ok(!isUnknownOutcome(new ApiRequestError('x', 409)));
  assert.ok(!isUnknownOutcome(new ApiRequestError('x', 403)));
  {
    const bodies: string[] = [];
    const body = { operationId: newOperationId(), reason: 'обслуживание' };
    let n = 0;
    const unknowns: number[] = [];
    const out = await runWithReconcile(
      async () => {
        bodies.push(JSON.stringify(body));
        n++;
        if (n === 1) throw new TypeError('network down');
        if (n === 2) throw new FfmpegUnknownOutcome(outcome({ outcome: 'unknown' }));
        return outcome({ replayed: true });
      },
      { sleep: async () => {}, onUnknown: (a) => unknowns.push(a) },
    );
    assert.equal(out.kind, 'done');
    assert.equal(out.attempts, 3);
    assert.deepEqual(unknowns, [1, 2], '«результат неизвестен, сверяем»');
    assert.equal(new Set(bodies).size, 1, 'повтор — тем же ключом и телом');
  }
  {
    let n = 0;
    const out = await runWithReconcile(
      async () => {
        n++;
        throw new ApiRequestError('down', 503);
      },
      { sleep: async () => {}, delays: [1, 1] },
    );
    assert.equal(out.kind, 'unknown', 'исход так и не установлен');
    assert.equal(n, 3);
  }
  {
    let n = 0;
    const out = await runWithReconcile(
      async () => {
        n++;
        throw new ApiRequestError('Нет права на вкладку FFmpeg: до RBAC доступ только у владельца', 403, 'Forbidden', { code: 'FFMPEG_FORBIDDEN' });
      },
      { sleep: async () => {} },
    );
    assert.equal(out.kind, 'error');
    assert.equal(n, 1, 'окончательный отказ не повторяется');
    assert.match(ffmpegErrorText((out as { error: unknown }).error, 'operate'), /^Нет права: управление очередью.*\(ffmpeg\.operate\)/);
  }
  assert.match(ffmpegErrorText(new ApiRequestError('no', 403, 'Forbidden', { code: 'FFMPEG_FORBIDDEN' }), 'media'), /ffmpeg\.media\.read/);
  assert.match(ffmpegErrorText(new ApiRequestError('x', 503, 'Service Unavailable', { code: 'FFMPEG_NOT_CONFIGURED' })), /не настроен/);
  assert.match(ffmpegErrorText(new ApiRequestError('x', 400, 'Bad Request', { code: 'FFMPEG_HOSTED_UNSUPPORTED' })), /внешнего провайдера/);
  assert.match(ffmpegErrorText(new ApiRequestError('x', 401)), /Сессия/);
  assert.match(ffmpegErrorText(new ApiRequestError('recovery', 409, 'Conflict', { code: 'NOT_RECONCILED' }), 'configure'), /recovery.*сверки очереди с продуктовой БД/);
  assert.match(ffmpegErrorText(new TypeError('x')), /Нет связи/);
  assert.match(ffmpegErrorText(new FfmpegFailedOutcome(outcome({ outcome: 'failed', message: 'ревизия' }))), /уже выполнялась и завершилась отказом/);
  const mr = (o: Partial<FfmpegMutationResult>) => mutationResultText('Действие', outcome(o));
  assert.equal(mr({ replayed: true, correlationId: null }), 'Действие: выполнено; повтор той же операции — действие не выполнялось заново.');
  assert.match(mr({ result: { deletionConfirmed: false } }), /ссылки отозваны, удаление файлов ещё идёт/);
  assert.match(mr({ result: { deletionConfirmed: true } }), /удаление подтверждено/);
  assert.match(mr({ action: 'job.reconcile', result: { found: false } }), /не разрешение отправлять задачу заново/);
  assert.match(mr({ action: 'job.reconcile', result: { found: true, status: 'succeeded' } }), /статус на сервере: выполнено/);
  assert.match(mr({ result: { revision: 5 } }), /ревизия 5/);
  assert.ok(reasonValid('abc') && !reasonValid('  a b ') && !reasonValid('x'.repeat(501)));

  // ── Лимиты ──
  const limits = normalizeLimits({
    state: 'ok',
    fetchedAt: t0,
    error: null,
    data: {
      revision: 4,
      effective: { maxThreads: 2, maxInputBytes: 512 * 2 ** 20, junk: 'x' },
      ceiling: { maxThreads: 2, maxInputBytes: 512 * 2 ** 20 },
      concurrency: 1,
      history: [{ revision: 4, changed_at: t0, actor: 'ops', reason: 'start' }],
      control_history: [{ at: t0, type: 'control.pause', data: { from: 'active', to: 'paused', reason: 'обслуживание' } }],
    },
    editable: ['maxThreads', 'maxInputBytes'],
    routing,
    history: [{ id: 'h1', createdAt: t0, action: 'pause', phase: 'succeeded', actorUserId: 'u1' }, { bad: true }],
  });
  assert.equal(limits.revision, 4);
  assert.deepEqual(limits.effective, { maxThreads: 2, maxInputBytes: 512 * 2 ** 20 });
  assert.deepEqual(limits.bounds, { maxThreads: 2, maxInputBytes: 512 * 2 ** 20 });
  assert.equal(limits.history.length, 1);
  assert.equal(limits.history[0].result, 'succeeded');
  assert.deepEqual(limits.serverHistory, [{ revision: 4, at: t0, actor: 'ops', reason: 'start' }]);
  assert.deepEqual(limits.controlHistory, [{ at: t0, event: 'control.pause', from: 'active', to: 'paused', reason: 'обслуживание' }]);
  assert.equal(limits.routing?.revision, 3);
  const limitsDown = normalizeLimits({ state: 'error', fetchedAt: null, error: 'timeout', data: null, editable: [], routing, history: [] });
  assert.ok(limitsDown.stale && limitsDown.revision === null, 'сервер лёг — ревизия неизвестна, правка недоступна');
  assert.equal(toDisplay('bytes', 512 * 2 ** 20), '512');
  assert.equal(fromDisplay('bytes', '256'), 256 * 2 ** 20);
  assert.equal(fromDisplay('sec', '1.5'), null, 'секунды — целые');
  assert.equal(fromDisplay('count', '-1'), null);
  const same = diffLimits(limits.effective, limits.bounds, { maxThreads: '2', maxInputBytes: '512' }, limits.editable);
  assert.deepEqual(same, { changes: [], errors: {} }, 'без изменений');
  const over = diffLimits(limits.effective, limits.bounds, { maxThreads: '4', maxInputBytes: '256' }, limits.editable);
  assert.match(over.errors.maxThreads, /граница деплоя/, 'выше верхней границы UI не предлагает');
  assert.deepEqual(over.changes.map((c) => [c.key, c.from, c.to]), [['maxInputBytes', 512 * 2 ** 20, 256 * 2 ** 20]]);
  assert.match(diffLimits(limits.effective, {}, { maxThreads: '1' }).errors.maxThreads, /неизвестна/, 'без границы не меняем');
  assert.match(diffLimits({ maxFps: 60 }, { maxFps: 60 }, { maxFps: '30' }, ['maxThreads']).errors.maxFps, /не разрешает/);

  // ── Маршрутизация ──
  const cur: FfmpegRouting = {
    revision: 7,
    defaultProvider: 'hosted',
    canaryProducts: ['story'],
    selfhostedEnabled: true,
    selfhostedConfigured: true,
    effectiveDefaultProvider: 'hosted',
    effectiveCanaryProducts: ['story'],
    updatedAt: null,
    fallbackToHosted: true,
    breaker: null,
  };
  const toSelf = diffRouting(cur, 'selfhosted', ['story']);
  assert.ok(toSelf.toSelfhostedDefault && toSelf.changed, 'default → selfhosted — отдельное подтверждение');
  const canary = diffRouting(cur, 'hosted', ['story', 'postprod']);
  assert.deepEqual([canary.added, canary.removed, canary.toSelfhostedDefault], [['postprod'], [], false]);
  assert.equal(diffRouting(cur, 'hosted', ['story']).changed, false);
  assert.equal(diffRouting({ ...cur, defaultProvider: 'selfhosted' }, 'hosted', ['story']).toSelfhostedDefault, false, 'rollback не требует подтверждения владельца');

  assert.equal(formatBytes(null), 'нет данных', 'отсутствие — не ноль');
  assert.equal(formatBytes(1536), '1.5 КиБ');

  // ── Очередь внимания: виды ffmpeg-* backend → «Открыть FFmpeg» и отфильтрованная страница ──
  const rulesPath = path.join(__dirname, '..', '..', '..', 'backend', 'src', 'modules', 'admin-attention', 'attention-rules.ts');
  const kinds = fs.existsSync(rulesPath)
    ? [...new Set([...fs.readFileSync(rulesPath, 'utf8').matchAll(/kind: '(ffmpeg-[a-z-]+)'/g)].map((m) => m[1]))]
    : ['ffmpeg-unavailable', 'ffmpeg-not-ready', 'ffmpeg-breaker-open', 'ffmpeg-queue-stuck', 'ffmpeg-oom-repeated'];
  assert.ok(kinds.length >= 5, `видов ffmpeg-*: ${kinds.length}`);
  for (const k of kinds) assert.equal(actionLabel(k), 'Открыть FFmpeg', k);
  // Адреса карточек backend (`/ffmpeg?state=queued`, `?state=failed&period=24h`) разбираются в фильтры страницы.
  assert.deepEqual(parseFilters(new URL('http://x/ffmpeg?state=queued').searchParams), { ...DEFAULT_FILTERS, state: 'queued' });
  assert.deepEqual(parseFilters(new URL('http://x/ffmpeg?state=failed&period=24h').searchParams), { ...DEFAULT_FILTERS, state: 'failed' });

  // ── Исходники вкладки: запреты ТЗ §13.1 ──
  const dir = path.join(__dirname, '..', 'app', 'ffmpeg');
  const src = fs
    .readdirSync(dir)
    .filter((n) => /\.tsx?$/.test(n))
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
    .join('\n');
  assert.ok(!/autoPlay/.test(src), 'без автовоспроизведения');
  assert.ok(!/dangerouslySetInnerHTML|<iframe|<object|<embed/.test(src), 'без встраивания HTML/SVG');
  assert.ok(!/>\s*(?:Повторить рендер|Повторный рендер|Перезапустить|Отрендерить)/i.test(src), 'нет кнопки повторного рендера');
  assert.ok(!/apiPost|apiGet\(/.test(src), 'все запросы — через lib/ffmpeg.ts (AbortSignal, тайм-аут, сверка)');
  assert.ok(/preload="none"/.test(src), 'медиа не грузится до команды');
  const lib = fs.readFileSync(path.join(__dirname, 'ffmpeg.ts'), 'utf8');
  assert.ok(!/rerender|re-render|retry-render|\/submit|\/api\/ffmpeg'/i.test(lib), 'API вкладки не создаёт задач и не рендерит');

  console.log('ffmpeg.test.ts: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
