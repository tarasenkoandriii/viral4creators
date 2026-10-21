// Вкладка «FFmpeg: обработка» (ТЗ FFmpeg-server v1.1 §13.1, пакет ADM).
//
// Здесь — запросы к backend `/admin/ffmpeg/*` и вся чистая часть экрана:
// разбор ответов с допусками, фильтры в адресе, подписи, свежесть данных,
// тексты ошибок, повтор мутации тем же ключом. Разметка — в
// `app/ffmpeg/*`. Тест — `ffmpeg.test.ts` (без браузера).
//
// Свой тонкий fetch-слой, а не `apiGet` из `admin-api.ts`: вкладке нужны
// AbortSignal (отмена при уходе со страницы и при скрытии вкладки) и
// собственный тайм-аут мутаций, чтобы обрыв превращался в «результат
// неизвестен, сверяем», а не в вечное ожидание. Конверт ответа и
// `ApiRequestError` — общие с остальной админкой.
import { ApiRequestError } from './admin-api';
import type {
  FfmpegAcceptMode,
  FfmpegArtifactsState,
  FfmpegDownloadLink,
  FfmpegDownloadLinkInput,
  FfmpegExecutorUsage,
  FfmpegFileInfo,
  FfmpegJobDetail,
  FfmpegJobRow,
  FfmpegJobsPage,
  FfmpegJobsQuery,
  FfmpegJobState,
  FfmpegLimitsInput,
  FfmpegLimitsView,
  FfmpegMutationInput,
  FfmpegMutationResult,
  FfmpegObserved,
  FfmpegOperatorAction,
  FfmpegOverview,
  FfmpegProduct,
  FfmpegProvider,
  FfmpegPurgeInput,
  FfmpegResumeInput,
  FfmpegRouting,
  FfmpegRoutingInput,
  FfmpegSourceState,
  FfmpegWorkerState,
} from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api';
export const FFMPEG_API = '/admin/ffmpeg';

/** Тайм-аут GET: backend сам ждёт VPS ≤5 с (§13.1), запас на сеть. */
export const FFMPEG_GET_TIMEOUT_MS = 12_000;
/** Тайм-аут мутации; по его истечении исход неизвестен и сверяется тем же ключом. */
export const FFMPEG_MUTATION_TIMEOUT_MS = 15_000;
/** Период автообновления видимой вкладки. */
export const FFMPEG_REFRESH_MS = 10_000;
/** Потолок backoff при ошибках. */
export const FFMPEG_REFRESH_MAX_MS = 160_000;
/** Значение старше этого — «устарело», даже если источник не сказал stale. */
export const FFMPEG_STALE_AFTER_MS = 35_000;
/** Предел показа stderr (ТЗ: ≤64 KiB). */
export const FFMPEG_STDERR_MAX_BYTES = 64 * 1024;
/** Размер страницы задач — задаёт backend; здесь для подписи. */
export const FFMPEG_PAGE_SIZE = 25;

// ───────────────────────── Транспорт ─────────────────────────

/** Ответ не пришёл за отведённое время (не отмена пользователем). */
export class FfmpegTimeoutError extends Error {
  constructor() {
    super('Сервер не ответил вовремя');
    this.name = 'FfmpegTimeoutError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function queryString(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, v);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

async function ffmpegRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, options.timeoutMs ?? FFMPEG_GET_TIMEOUT_MS);
  const outer = options.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${FFMPEG_API}${path}${queryString(options.query)}`, {
        method: options.method ?? 'GET',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      if (timedOut) throw new FfmpegTimeoutError();
      throw e;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (e) {
      if (timedOut) throw new FfmpegTimeoutError();
      if (isAbortError(e)) throw e;
      throw new ApiRequestError('Сервер вернул некорректный ответ', response.status);
    }
    const env = body as { success?: boolean; data?: T; error?: unknown };
    if (env && env.success === true) return env.data as T;
    const err = env?.error as { message?: unknown; code?: unknown; details?: unknown } | string | undefined;
    const message =
      typeof err === 'string' ? err : typeof err?.message === 'string' && err.message ? err.message : `Сервер ответил ${response.status}`;
    const code = typeof err === 'object' && typeof err?.code === 'string' ? err.code : undefined;
    const details =
      typeof err === 'object' && err?.details && typeof err.details === 'object' && !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : undefined;
    throw new ApiRequestError(message, response.status, code, details);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

const enc = encodeURIComponent;

export async function getFfmpegOverview(signal?: AbortSignal): Promise<FfmpegOverview> {
  return normalizeOverview(await ffmpegRequest<unknown>('/overview', { signal }));
}
export async function listFfmpegJobs(query: FfmpegJobsQuery, signal?: AbortSignal): Promise<FfmpegJobsPage> {
  return normalizeJobsPage(await ffmpegRequest<unknown>('/jobs', { query: { ...query }, signal }));
}
export async function getFfmpegJob(id: string, signal?: AbortSignal): Promise<FfmpegJobDetail> {
  return normalizeJobDetail(await ffmpegRequest<unknown>(`/jobs/${enc(id)}`, { signal }));
}
export async function getFfmpegLimits(signal?: AbortSignal): Promise<FfmpegLimitsView> {
  return normalizeLimits(await ffmpegRequest<unknown>('/limits', { signal }));
}

/**
 * Backend отвечает 200 и `outcome: 'unknown'`, когда сервер не ответил на
 * мутацию: действие могло выполниться. Для сверки это то же, что обрыв.
 */
export class FfmpegUnknownOutcome extends Error {
  constructor(readonly outcome: FfmpegMutationResult) {
    super(outcome.message ?? 'Результат неизвестен');
    this.name = 'FfmpegUnknownOutcome';
  }
}
/** Записанный ранее отказ той же операции (повтор с тем же operationId). */
export class FfmpegFailedOutcome extends Error {
  constructor(readonly outcome: FfmpegMutationResult) {
    super(outcome.message ?? 'Операция завершилась отказом');
    this.name = 'FfmpegFailedOutcome';
  }
}

export function normalizeMutation(raw: unknown): FfmpegMutationResult {
  const o = isObj(raw) ? raw : {};
  const outcome = o.outcome === 'succeeded' || o.outcome === 'failed' ? o.outcome : 'unknown';
  return {
    operationId: str(o.operationId) ?? '',
    correlationId: str(o.correlationId),
    action: str(o.action) ?? '',
    outcome,
    replayed: bool(o.replayed),
    message: str(o.message) ? redactSecrets(str(o.message) as string) : null,
    result: o.result ?? null,
  };
}

async function mutation(path: string, body: unknown): Promise<FfmpegMutationResult> {
  const r = normalizeMutation(await ffmpegRequest<unknown>(path, { method: 'POST', body, timeoutMs: FFMPEG_MUTATION_TIMEOUT_MS }));
  if (r.outcome === 'unknown') throw new FfmpegUnknownOutcome(r);
  if (r.outcome === 'failed') throw new FfmpegFailedOutcome(r);
  return r;
}

export type FfmpegControlAction = 'pause' | 'drain' | 'resume';
export function ffmpegControl(action: FfmpegControlAction, body: FfmpegMutationInput | FfmpegResumeInput) {
  return mutation(`/${action}`, body);
}
export function cancelFfmpegJob(id: string, body: FfmpegMutationInput & { reason: string }) {
  return mutation(`/jobs/${enc(id)}/cancel`, body);
}
export function purgeFfmpegJob(id: string, body: FfmpegPurgeInput) {
  return mutation(`/jobs/${enc(id)}/purge`, body);
}
/** Сверка — только чтение; причина необязательна. */
export function reconcileFfmpegJob(id: string, body: { operationId: string; reason?: string }) {
  return mutation(`/jobs/${enc(id)}/reconcile`, body);
}
export function setFfmpegLimits(body: FfmpegLimitsInput) {
  return mutation('/limits', body);
}
export function setFfmpegRouting(body: FfmpegRoutingInput) {
  return mutation('/routing', body);
}
export async function createFfmpegDownloadLink(id: string, body: FfmpegDownloadLinkInput): Promise<FfmpegDownloadLink> {
  const r = await mutation(`/jobs/${enc(id)}/download-link`, body);
  const res = isObj(r.result) ? r.result : {};
  const url = str(res.url);
  // Ссылку принимаем только https: иначе это не короткая ссылка сервера.
  if (!url || !/^https:\/\//i.test(url)) throw new ApiRequestError('Сервер не выдал корректную ссылку', 422);
  return { file: str(res.file) ?? body.file, url, expiresAt: str(res.expiresAt), mime: str(res.mime) };
}

// ───────────────────────── Справочники ─────────────────────────

export const FFMPEG_PRODUCTS: readonly FfmpegProduct[] = [
  'postprod',
  'actors',
  'audio-track',
  'portfolio',
  'story',
  'tutorial-runner',
  'tutorial-video-versions',
  'shared-video',
  'client-site-tutorial',
];
export const PRODUCT_LABEL: Record<FfmpegProduct, string> = {
  postprod: 'Постпродакшн',
  actors: 'AI-аватары (субтитры)',
  'audio-track': 'Аудиодорожка',
  portfolio: 'Портфолио (водяной знак)',
  story: 'Story‑Tales',
  'tutorial-runner': 'Обучалка: сборка',
  'tutorial-video-versions': 'Обучалка: версии',
  'shared-video': 'Публичное видео (постер)',
  'client-site-tutorial': 'Обучающее видео сайта',
};
/** Существующий экран админки, где живёт операция продукта (если точной ссылки нет). */
const PRODUCT_PAGE: Record<FfmpegProduct, string> = {
  postprod: '/sessions',
  actors: '/actors',
  'audio-track': '/sessions',
  portfolio: '/portfolio-items',
  story: '/story-tales',
  'tutorial-runner': '/tutorial-scenarios',
  'tutorial-video-versions': '/tutorial-scenarios',
  'shared-video': '/shared-videos',
  'client-site-tutorial': '/site-tutorial-drafts',
};

export const FFMPEG_PROVIDERS: readonly FfmpegProvider[] = ['selfhosted', 'hosted'];
export const PROVIDER_LABEL: Record<FfmpegProvider, string> = {
  hosted: 'внешний сервис (Very Good FFmpeg)',
  selfhosted: 'свой сервер',
};
/** Подпись схемы «основной / запасной» по маршрутизации. */
export function routingSchemeText(r: Pick<FfmpegRouting, 'effectiveDefaultProvider' | 'fallbackToHosted'>): string {
  if (r.effectiveDefaultProvider === 'selfhosted')
    return r.fallbackToHosted ? 'основной: свой сервер, запасной: внешний сервис' : 'основной: свой сервер, запасного нет';
  return 'основной: внешний сервис';
}

export const FFMPEG_STATES: readonly FfmpegJobState[] = ['queued', 'processing', 'succeeded', 'failed', 'canceled'];
export const STATE_LABEL: Record<FfmpegJobState, string> = {
  queued: 'в очереди',
  processing: 'выполняется',
  succeeded: 'выполнено',
  failed: 'ошибка',
  canceled: 'отменено',
  unknown: 'исход неизвестен',
};
export const STATE_TONE: Record<FfmpegJobState, 'ok' | 'warning' | 'critical' | 'neutral' | 'accent'> = {
  queued: 'neutral',
  processing: 'accent',
  succeeded: 'ok',
  failed: 'critical',
  canceled: 'neutral',
  unknown: 'warning',
};
export const STAGE_LABEL: Record<string, string> = {
  queued: 'ожидание',
  downloading: 'скачивание входов',
  probing: 'проверка входов',
  running: 'FFmpeg',
  validating: 'проверка результатов',
  publishing: 'публикация',
  done: 'завершено',
};
export const ACCEPT_MODE_LABEL: Record<FfmpegAcceptMode, string> = {
  active: 'приём открыт, worker работает',
  paused: 'пауза: worker не берёт новые задачи, приём открыт',
  drained: 'drain: приём закрыт, активная завершается',
  recovery: 'восстановление: приём закрыт до сверки',
};
export const WORKER_LABEL: Record<FfmpegWorkerState, string> = {
  running: 'выполняет задачу',
  idle: 'свободен',
  paused: 'не берёт новые задачи',
  'executor-down': 'executor не отвечает',
};
/** Причины отказа readiness сервера (control/readiness.ts) словами. */
export const READY_REASON_LABEL: Record<string, string> = {
  sqlite_unavailable: 'SQLite недоступна',
  migrations_pending: 'не применены миграции',
  executor_no_heartbeat: 'нет heartbeat executor',
  executor_heartbeat_stale: 'heartbeat executor устарел',
  executor_status_error: 'ошибка опроса executor',
  capabilities_not_checked: 'self-test возможностей не выполнен',
  capabilities_failed: 'self-test возможностей не пройден',
  capabilities_missing: 'не хватает кодеков/фильтров',
  capabilities_error: 'ошибка self-test',
  disk: 'мало свободного места на диске',
  disk_low: 'мало свободного места на диске',
};
export const ARTIFACTS_LABEL: Record<FfmpegArtifactsState, string> = {
  available: 'доступны',
  expired: 'истекли (TTL 24 ч)',
  purged: 'удалены (отзыв/оператор)',
  purging: 'ссылки отозваны, удаление идёт',
  none: 'нет',
};
/** Стабильные коды ошибок сервера (ffmpeg-server/src/contracts.ts). */
export const ERROR_CODE_LABEL: Record<string, string> = {
  INVALID_REQUEST: 'некорректный запрос',
  UNSUPPORTED_COMMAND: 'неподдерживаемая команда',
  FORBIDDEN_SOURCE: 'запрещённый источник',
  INPUT_DOWNLOAD_FAILED: 'вход не скачался',
  INPUT_EXPIRED: 'ссылка входа истекла',
  INPUT_TOO_LARGE: 'вход больше лимита',
  INPUT_INVALID_MEDIA: 'вход не медиа',
  INPUT_LIMIT_EXCEEDED: 'превышен лимит входа',
  COMMAND_FAILED: 'команда завершилась ошибкой',
  OUTPUT_MISSING: 'нет результата',
  OUTPUT_TOO_LARGE: 'результат больше лимита',
  OUTPUT_INVALID_MEDIA: 'результат не прошёл проверку',
  TIMEOUT: 'превышен срок',
  QUEUE_TIMEOUT: 'срок ожидания в очереди',
  OOM: 'не хватило памяти',
  CANCELED: 'отменено',
  INTERRUPTED: 'прервано',
  OUTPUT_EXPIRED: 'файлы истекли',
  OUTPUT_PURGED: 'файлы отозваны',
  INTERNAL: 'внутренняя ошибка',
};
/** События timeline задачи и режима (ffmpeg-server `events.type`). */
export const EVENT_LABEL: Record<string, string> = {
  'job.accepted': 'принята',
  'job.claimed': 'взята worker',
  'job.succeeded': 'выполнена',
  'job.failed': 'ошибка',
  'job.canceled': 'отменена',
  'job.queue_timeout': 'истёк срок ожидания в очереди',
  'job.retry_scheduled': 'назначена повторная локальная попытка',
  'job.outputs_expired': 'файлы истекли',
  'job.purge_requested': 'запрошено удаление файлов',
  'job.purged': 'файлы удалены',
  'job.interrupted': 'прервана',
  'stage.downloading': 'этап: скачивание входов',
  'stage.probing': 'этап: проверка входов',
  'stage.running': 'этап: FFmpeg',
  'stage.validating': 'этап: проверка результатов',
  'stage.publishing': 'этап: публикация',
  'executor.started': 'executor запущен',
  'executor.done': 'executor завершил',
  'executor.cancel_sent': 'executor получил отмену',
  'inputs.reused': 'входы взяты из прошлой попытки',
  'publish.discarded': 'публикация отменена',
  'recovery.found': 'найдена при восстановлении',
  'limits.changed': 'лимиты изменены',
  'control.pause': 'пауза',
  'control.drain': 'drain',
  'control.resume': 'продолжение',
  'control.recovery': 'режим восстановления',
};
/** Действия журнала (`ffmpeg_operator_actions.action`). */
export const ACTION_LABEL: Record<string, string> = {
  pause: 'Пауза worker',
  drain: 'Drain',
  resume: 'Продолжить',
  'job.cancel': 'Отмена задачи',
  'job.purge': 'Удаление файлов',
  'job.reconcile': 'Сверка',
  'job.download-link': 'Ссылка на результат',
  'limits.update': 'Изменение лимитов',
  'routing.update': 'Изменение маршрутизации',
};

export function labelOf<K extends string>(map: Record<K, string>, key: string | null | undefined): string {
  if (!key) return '—';
  return (map as Record<string, string>)[key] ?? key;
}

// ───────────────────────── Разбор ответов ─────────────────────────
// Backend (`backend/src/modules/ffmpeg-admin`) отдаёт снимки
// `{state, fetchedAt, error, data}`, где `data` — сырой ответ ops-API
// сервера (snake_case, ffmpeg-server/src/ops/ops.ts). Разбор терпит
// отсутствующие поля, но НИКОГДА не превращает отсутствие в ноль:
// `null` показывается как «нет данных» с причиной.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Поле в snake_case или camelCase. */
const get = (o: Obj, snake: string): unknown => {
  if (snake in o) return o[snake];
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return o[camel];
};

const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): T | null =>
    typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
const productOf = oneOf(FFMPEG_PRODUCTS);
const providerOf = oneOf<FfmpegProvider>(['hosted', 'selfhosted']);
const SOURCE_STATES: readonly FfmpegSourceState[] = ['ok', 'stale', 'error', 'not-configured', 'unsupported'];

/** Снимок backend: состояние, момент, причина. */
interface Snap {
  source: FfmpegSourceState;
  at: string | null;
  stale: boolean;
  reason: string | null;
  data: Obj | null;
}
const SOURCE_REASON: Record<FfmpegSourceState, string | null> = {
  ok: null,
  stale: 'FFmpeg-сервер не ответил',
  error: 'FFmpeg-сервер не ответил, последних данных нет',
  'not-configured': 'Собственный FFmpeg-сервер не настроен в backend (адрес или ключ)',
  unsupported: 'Источник не поддерживает этот запрос',
};
function snap(raw: unknown): Snap {
  const o = isObj(raw) ? raw : {};
  const source = oneOf(SOURCE_STATES)(o.state) ?? (isObj(o.data) ? 'ok' : 'error');
  const reason = source === 'ok' ? null : redactNullable(str(o.error)) ?? SOURCE_REASON[source];
  return { source, at: str(o.fetchedAt), stale: source !== 'ok', reason, data: isObj(o.data) ? o.data : null };
}
const redactNullable = (s: string | null) => (s ? redactSecrets(s) : null);

function obs<T>(value: T | null, at: string | null, s: Pick<Snap, 'stale' | 'reason'>, missingReason?: string): FfmpegObserved<T> {
  return {
    value,
    observedAt: at,
    stale: s.stale,
    reason: s.stale ? s.reason : value === null ? (missingReason ?? null) : null,
  };
}

function pickRouting(v: unknown): FfmpegRouting | null {
  if (!isObj(v)) return null;
  const provider = providerOf(v.defaultProvider);
  if (!provider) return null;
  const products = (x: unknown) => arr(x).filter((p): p is FfmpegProduct => productOf(p) !== null);
  const gate = bool(v.selfhostedGateEnabled) || bool(v.selfhostedEnabled);
  const configured = v.selfhostedConfigured === undefined ? gate : bool(v.selfhostedConfigured);
  return {
    revision: num(v.revision),
    defaultProvider: provider,
    canaryProducts: products(v.canaryProducts),
    selfhostedEnabled: gate,
    selfhostedConfigured: configured,
    effectiveDefaultProvider: providerOf(v.effectiveDefaultProvider) ?? (gate && configured ? provider : 'hosted'),
    effectiveCanaryProducts: Array.isArray(v.effectiveCanaryProducts)
      ? products(v.effectiveCanaryProducts)
      : gate && configured
        ? products(v.canaryProducts)
        : [],
    updatedAt: str(v.updatedAt),
    fallbackToHosted: bool(v.fallbackToHosted),
    breaker: isObj(v.breaker)
      ? {
          open: bool(v.breaker.open),
          openUntil: str(v.breaker.openUntil),
          failures: num(v.breaker.failures) ?? 0,
          threshold: num(v.breaker.threshold),
        }
      : null,
  };
}

function readyReason(reasons: unknown): string | null {
  const list = arr(reasons).filter((r): r is string => typeof r === 'string');
  if (!list.length) return null;
  return list.map((r) => READY_REASON_LABEL[r] ?? r).join('; ');
}

function executorObs(ex: Obj | null, s: Snap): FfmpegObserved<FfmpegExecutorUsage> {
  const r = ex && isObj(ex.resources) ? ex.resources : null;
  if (!r) return obs<FfmpegExecutorUsage>(null, s.at, s, s.data ? 'FFmpeg-сервер не сообщает CPU/RAM executor' : undefined);
  const kb = (v: unknown) => (num(v) === null ? null : (num(v) as number) * 1024);
  const sampledAt = str(get(r, 'sampled_at'));
  const value: FfmpegExecutorUsage = {
    idle: bool(r.idle),
    cpuPercent: num(get(r, 'cpu_percent')),
    rssBytes: kb(get(r, 'rss_kb')),
    peakRssBytes: kb(get(r, 'peak_rss_kb')),
    sampledAt,
    stale: bool(r.stale),
  };
  // Замер устарел — помечаем как устаревшее, даже если сводка свежая.
  return {
    value,
    observedAt: sampledAt ?? s.at,
    stale: s.stale || value.stale,
    reason: s.stale ? s.reason : value.stale ? 'замер executor устарел (нет свежего heartbeat)' : null,
  };
}

export function normalizeOverview(raw: unknown): FfmpegOverview {
  const o = isObj(raw) ? raw : {};
  const generatedAt = str(o.generatedAt) ?? new Date().toISOString();
  const local = { stale: false, reason: null };
  const s = snap(o.selfhosted);
  const d = s.data ?? {};
  const control = isObj(d.control) ? d.control : null;
  const ready = isObj(d.ready) ? d.ready : null;
  const queue = isObj(d.queue) ? d.queue : null;
  const disk = isObj(d.disk) ? d.disk : null;
  const ex = isObj(d.executor) ? d.executor : null;
  const caps = isObj(d.capabilities) ? d.capabilities : null;
  const active = isObj(d.active) ? d.active : null;
  const mode = oneOf<FfmpegAcceptMode>(['active', 'paused', 'drained', 'recovery'])(control?.mode);
  const counts = queue && isObj(queue.counts) ? queue.counts : null;

  let worker: FfmpegWorkerState | null = null;
  if (s.data) {
    if (active) worker = 'running';
    else if (!ex || ex.fresh === false) worker = 'executor-down';
    else if (mode && mode !== 'active') worker = 'paused';
    else if (mode) worker = 'idle';
  }
  const usage = isObj(o.usage24h) && num(o.usage24h.hosted) !== null ? { hosted: num(o.usage24h.hosted) as number, selfhosted: num(o.usage24h.selfhosted) ?? 0 } : null;
  const hosted = isObj(o.hosted) ? { configured: bool(o.hosted.configured), note: str(o.hosted.note) } : null;
  const routing = pickRouting(o.routing);

  return {
    generatedAt,
    source: s.source,
    stale: s.stale,
    staleReason: s.reason,
    routing: obs(routing, generatedAt, local, 'настройка маршрутизации не получена'),
    acceptMode: obs(mode, s.at, s),
    worker: obs(worker, s.at, s),
    activeJob: active && str(active.id)
      ? {
          id: `selfhosted:${str(active.id)}`,
          operationId: str(get(active, 'client_operation_id')),
          stage: str(active.stage),
          progress: num(active.progress),
        }
      : null,
    ready: obs(
      ready && typeof ready.ready === 'boolean'
        ? { ready: ready.ready, reason: readyReason(ready.reasons), checkedAt: str(get(ready, 'checked_at')) }
        : null,
      s.at,
      s,
    ),
    jobs: obs(
      counts
        ? {
            active: num(counts.processing) ?? 0,
            queued: num(counts.queued) ?? 0,
            failed: num(get(queue as Obj, 'failed_24h')) ?? 0,
            oldestQueuedAgeSec: num(get(queue as Obj, 'oldest_queued_age_sec')),
            maxQueued: num(get(queue as Obj, 'max_queued')),
          }
        : null,
      s.at,
      s,
    ),
    disk: obs(
      disk && num(get(disk, 'free_bytes')) !== null
        ? {
            freeBytes: num(get(disk, 'free_bytes')) as number,
            minFreeBytes: num(get(disk, 'min_free_bytes')),
            workspacesBytes: num(get(disk, 'workspaces_bytes')),
            workspacesLimitBytes: num(get(disk, 'max_workspaces_bytes')),
            outputsBytes: num(get(disk, 'outputs_bytes')),
            outputsLimitBytes: num(get(disk, 'max_outputs_bytes')),
            measuredAt: str(get(disk, 'measured_at')),
          }
        : null,
      s.at,
      s,
    ),
    // CPU/RAM executor — `executor.resources`; простой — явный idle, не ноль.
    executor: executorObs(ex, s),
    image: obs(
      s.data
        ? {
            ffmpegVersion: str(get(ex ?? {}, 'ffmpeg_version')) ?? str(get(caps ?? {}, 'ffmpeg_version')),
            imageDigest: str(get(d, 'image_digest')),
          }
        : null,
      s.at,
      s,
    ),
    usage24h: obs(usage, generatedAt, local, 'журнал расходов недоступен'),
    fallbacks24h: obs(num(o.fallbacks24h), generatedAt, local, 'журнал запасного пути недоступен'),
    hosted,
    permissions: Array.isArray(o.permissions) ? o.permissions.filter((p): p is string => typeof p === 'string') : null,
  };
}

const STATE_ALIASES: Record<string, FfmpegJobState> = {
  completed: 'succeeded',
  success: 'succeeded',
  done: 'succeeded',
  error: 'failed',
  cancelled: 'canceled',
  pending: 'queued',
  running: 'processing',
  in_progress: 'processing',
};
function stateOf(v: unknown): FfmpegJobState | null {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  return (FFMPEG_STATES as readonly string[]).includes(s) ? (s as FfmpegJobState) : (STATE_ALIASES[s] ?? (s === 'unknown' ? 'unknown' : null));
}

function artifactsOf(o: Obj, state: FfmpegJobState, errorCode: string | null): FfmpegArtifactsState {
  if (str(get(o, 'purged_at'))) return 'purged';
  if (str(get(o, 'purge_requested_at'))) return 'purging';
  if (errorCode === 'OUTPUT_PURGED') return 'purged';
  if (errorCode === 'OUTPUT_EXPIRED') return 'expired';
  if (state === 'succeeded') return 'available';
  return 'none';
}

function selfId(raw: string, provider: FfmpegProvider): string {
  return provider === 'selfhosted' && !raw.startsWith('selfhosted:') ? `selfhosted:${raw}` : raw;
}

function pickRow(v: unknown, fallbackProvider: FfmpegProvider): FfmpegJobRow | null {
  if (!isObj(v)) return null;
  const rawId = str(v.jobId) ?? str(get(v, 'job_id')) ?? str(v.id);
  if (!rawId) return null;
  const provider = providerOf(v.provider) ?? (rawId.startsWith('selfhosted:') ? 'selfhosted' : fallbackProvider);
  const id = selfId(rawId, provider);
  const state = stateOf(v.status) ?? stateOf(v.state) ?? 'unknown';
  const errorCode = str(get(v, 'error_code'));
  const opId = str(get(v, 'client_operation_id'));
  const sec = (x: unknown) => (num(x) === null ? null : (num(x) as number) * 1000);
  return {
    id,
    provider,
    product: productOf(v.product) ?? (opId ? productOf(opId.split(':', 1)[0]) : null),
    operationId: opId,
    state,
    stage: str(v.stage),
    executionStatus: stateOf(get(v, 'execution_status')),
    errorCode,
    attempts: num(v.attempts) ?? (Array.isArray(v.attempts) ? v.attempts.length : null),
    queueMs: sec(get(v, 'queue_delay_sec')),
    runMs: sec(get(v, 'run_sec')),
    outputBytes: num(get(v, 'output_bytes')),
    artifacts: provider === 'selfhosted' ? artifactsOf(v, state, errorCode) : null,
    createdAt: str(get(v, 'created_at')),
    finishedAt: str(get(v, 'finished_at')),
  };
}

export function normalizeJobsPage(raw: unknown): FfmpegJobsPage {
  const o = isObj(raw) ? raw : {};
  const provider = providerOf(o.provider) ?? 'selfhosted';
  const source = oneOf(SOURCE_STATES)(o.state) ?? (Array.isArray(o.items) ? 'ok' : 'error');
  const items = arr(o.items)
    .map((r) => pickRow(r, provider))
    .filter((r): r is FfmpegJobRow => r !== null);
  return {
    provider,
    source,
    items,
    nextCursor: str(o.nextCursor),
    observedAt: str(o.fetchedAt),
    stale: source !== 'ok',
    staleReason: source === 'ok' ? null : redactNullable(str(o.error)) ?? SOURCE_REASON[source],
    productFilterPageOnly: o.productFilter === 'page',
  };
}

function pickStreams(v: unknown): FfmpegFileInfo['streams'] {
  return arr(v)
    .filter(isObj)
    .map((s) => ({
      type: str(s.type) ?? 'unknown',
      codec: str(s.codec),
      width: num(s.width) ?? undefined,
      height: num(s.height) ?? undefined,
      fps: num(s.fps) ?? undefined,
      sampleRate: num(get(s, 'sample_rate')) ?? undefined,
      channels: num(s.channels) ?? undefined,
      durationSec: num(get(s, 'duration_sec')),
    }));
}
const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null);
function fileInfo(name: string, ...sources: Array<Obj | null | undefined>): FfmpegFileInfo {
  const pick = (k: string) => {
    for (const s of sources) if (s && get(s, k) !== undefined && get(s, k) !== null) return get(s, k);
    return undefined;
  };
  return {
    name: safeFileName(name),
    bytes: num(pick('bytes')),
    sha256: sha(pick('sha256')),
    mime: str(pick('mime')),
    format: str(pick('format')),
    durationSec: num(pick('duration_sec')),
    streams: pickStreams(pick('streams')),
    purgedAt: str(pick('purged_at')),
  };
}

/** Короткое описание данных события timeline: только простые значения, без URL. */
function eventNote(data: unknown): string | null {
  if (!isObj(data)) return typeof data === 'string' ? redactSecrets(data).slice(0, 200) : null;
  const parts = Object.entries(data)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${redactSecrets(String(v)).slice(0, 80)}`);
  return parts.length ? parts.join(', ') : null;
}

function pickAction(v: unknown): FfmpegOperatorAction | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const at = str(v.createdAt) ?? str(v.at);
  if (!id || !at) return null;
  return {
    id,
    at,
    actorId: str(v.actorUserId) ?? str(v.actorId),
    action: str(v.action) ?? '—',
    jobId: str(v.jobId),
    operationId: str(v.clientOperationId) ?? null,
    reason: redactNullable(str(v.reason)),
    oldRevision: num(v.oldRevision),
    newRevision: num(v.newRevision),
    result: str(v.phase) ?? str(v.result) ?? 'unknown',
    correlationId: str(v.correlationId),
  };
}

export function normalizeJobDetail(raw: unknown): FfmpegJobDetail {
  const o = isObj(raw) ? raw : {};
  const s = snap(o);
  const d = s.data ?? {};
  const provider = providerOf(o.provider) ?? 'hosted';
  const id = str(o.jobId) ?? '—';
  const row = pickRow({ ...d, id, jobId: id, provider }, provider) as FfmpegJobRow;
  const res = isObj(d.resources) ? d.resources : null;
  const metaOut = isObj(get(d, 'outputs_metadata')) ? (get(d, 'outputs_metadata') as Obj) : {};
  const metaIn = arr(get(d, 'inputs_metadata')).filter(isObj);
  const arts = arr(d.artifacts).filter(isObj);
  const outNames = [
    ...new Set([
      ...arr(get(d, 'output_names')).filter((n): n is string => typeof n === 'string'),
      ...arr(d.outputNames).filter((n): n is string => typeof n === 'string'),
      ...arts.map((a) => str(a.name)).filter((n): n is string => !!n),
      ...Object.keys(metaOut),
    ]),
  ];
  const inNames = [
    ...new Set([
      ...arr(get(d, 'input_names')).filter((n): n is string => typeof n === 'string'),
      ...metaIn.map((m) => str(m.key)).filter((n): n is string => !!n),
    ]),
  ];
  const stderrRaw = str(get(d, 'stderr_tail')) ?? str(d.stderr);
  const stderr = stderrRaw ? cleanStderr(stderrRaw) : null;
  const createdAt = str(get(d, 'created_at'));
  const startedAt = str(get(d, 'started_at'));
  const queueDelayMs = createdAt && startedAt ? Math.max(0, Date.parse(startedAt) - Date.parse(createdAt)) : null;
  const owners = arr(o.owners)
    .filter(isObj)
    .map((w) => ({ label: str(w.label) ?? 'Операция продукта', href: str(w.href) }))
    .filter((w): w is { label: string; href: string } => isInternalHref(w.href));
  return {
    ...row,
    errorCode: row.errorCode ?? str(d.errorCode),
    source: s.source,
    observedAt: s.at,
    stale: s.stale,
    staleReason: s.reason,
    errorMessage: redactNullable(str(get(d, 'error_message')) ?? str(d.error)),
    startedAt,
    expiresAt: str(get(d, 'expires_at')),
    progress: num(d.progress),
    timeline: arr(d.timeline)
      .filter(isObj)
      .map((t) => {
        const event = str(t.type) ?? str(t.state) ?? '—';
        return {
          at: str(t.at),
          event,
          stage: event.startsWith('stage.') ? event.slice(6) : str(t.stage),
          note: eventNote(t.data ?? t.note),
        };
      }),
    inputs: inNames.map((n) => fileInfo(n, metaIn.find((m) => m.key === n))),
    outputs: outNames.map((n) => fileInfo(n, arts.find((a) => a.name === n), isObj(metaOut[n]) ? (metaOut[n] as Obj) : null)),
    resources: res
      ? {
          wallMs: num(get(res, 'wall_ms')),
          cpuMs: num(get(res, 'cpu_ms')),
          peakRssKb: num(get(res, 'peak_rss_kb')),
          inputBytes: num(get(res, 'input_bytes')),
          outputBytes: num(get(res, 'output_bytes')),
          queueDelayMs,
          exitCode: num(get(res, 'exit_code')),
        }
      : null,
    attemptsDetail: arr(d.attempts)
      .filter(isObj)
      .map((a, i) => ({
        n: num(a.n) ?? i + 1,
        status: str(a.status),
        outcome: str(a.outcome),
        errorCode: str(get(a, 'error_code')),
        startedAt: str(get(a, 'started_at')),
        finishedAt: str(get(a, 'finished_at')),
        exitCode: num(get(a, 'exit_code')),
        signal: str(a.signal),
        wallMs: num(get(a, 'wall_ms')),
        cpuMs: num(get(a, 'cpu_ms')),
        peakRssKb: num(get(a, 'peak_rss_kb')),
      })),
    ffmpegVersion: str(get(d, 'ffmpeg_version')),
    imageDigest: str(get(d, 'image_digest')),
    stderr: stderr ? stderr.text : null,
    stderrTruncated: stderr?.truncated ?? false,
    limitsRevision: num(get(d, 'limits_revision')),
    owners,
    actions: arr(o.actions).map(pickAction).filter((a): a is FfmpegOperatorAction => a !== null),
  };
}

export function normalizeLimits(raw: unknown): FfmpegLimitsView {
  const o = isObj(raw) ? raw : {};
  const s = snap(o);
  const d = s.data ?? {};
  const effective: Record<string, number> = {};
  if (isObj(d.effective)) for (const [k, v] of Object.entries(d.effective)) if (k !== 'revision' && num(v) !== null) effective[k] = v as number;
  const bounds: Record<string, number> = {};
  const ceiling = isObj(d.ceiling) ? d.ceiling : isObj(d.bounds) ? d.bounds : {};
  for (const [k, v] of Object.entries(ceiling)) {
    if (num(v) !== null) bounds[k] = v as number;
    else if (isObj(v) && num(v.max) !== null) bounds[k] = v.max as number;
  }
  return {
    source: s.source,
    observedAt: s.at,
    stale: s.stale,
    staleReason: s.reason,
    revision: num(d.revision),
    effective,
    bounds,
    editable: arr(o.editable).filter((k): k is string => typeof k === 'string'),
    routing: pickRouting(o.routing),
    history: arr(o.history).map(pickAction).filter((a): a is FfmpegOperatorAction => a !== null),
    serverHistory: arr(d.history)
      .filter(isObj)
      .filter((h) => num(h.revision) !== null)
      .map((h) => ({
        revision: num(h.revision) as number,
        at: str(get(h, 'changed_at')),
        actor: str(h.actor),
        reason: redactNullable(str(h.reason)),
      })),
    controlHistory: arr(get(d, 'control_history'))
      .filter(isObj)
      .map((e) => {
        const data = isObj(e.data) ? e.data : {};
        return {
          at: str(e.at),
          event: str(e.type) ?? '—',
          from: str(data.from),
          to: str(data.to) ?? str(data.mode),
          reason: redactNullable(str(data.reason)),
        };
      }),
  };
}

// ───────────────────────── Свежесть ─────────────────────────

export type Freshness = 'fresh' | 'stale' | 'missing';

/** Свежее — получено недавно и источник не сказал stale; missing — значения нет вовсе. */
export function freshness(obs: Pick<FfmpegObserved<unknown>, 'value' | 'observedAt' | 'stale'>, now: number): Freshness {
  if (obs.value === null) return 'missing';
  if (obs.stale) return 'stale';
  const at = obs.observedAt ? Date.parse(obs.observedAt) : NaN;
  if (!Number.isFinite(at) || now - at > FFMPEG_STALE_AFTER_MS) return 'stale';
  return 'fresh';
}

/** Задержка до следующего опроса: 10 с, при ошибках ×2 до потолка. */
export function nextPollDelay(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return FFMPEG_REFRESH_MS;
  return Math.min(FFMPEG_REFRESH_MS * 2 ** Math.min(failures, 10), FFMPEG_REFRESH_MAX_MS);
}

// ───────────────────────── Форматирование ─────────────────────────

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'нет данных';
  if (n < 1024) return `${n} Б`;
  const units = ['КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${Math.round(s % 60)} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

const KYIV = new Intl.DateTimeFormat('ru', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
/** Дата/время по Киеву; пусто или мусор — «—». */
export function kyivTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : KYIV.format(d);
}

export function shortId(id: string): string {
  const bare = id.startsWith('selfhosted:') ? id.slice('selfhosted:'.length) : id;
  return bare.length > 14 ? `${bare.slice(0, 8)}…${bare.slice(-4)}` : bare;
}

// ───────────────────────── Приватность ─────────────────────────

/** Имя файла без URL и путей: всё похожее на адрес не показывается. */
export function safeFileName(name: string): string {
  if (/:\/\/|[?#\\]|^\/|\.\.|[\x00-\x1f]/.test(name)) return '[имя скрыто]';
  return name.length > 200 ? `${name.slice(0, 200)}…` : name;
}

/** Второй рубеж поверх очистки на сервере: URL, токены, Bearer, подписи. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:https?|wss?|ftp|s3|gs):\/\/[^\s"'<>]+/gi, '[url скрыт]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [скрыт]')
    .replace(/\b((?:token|key|signature|sig|secret|password|x-amz-[a-z-]+)=)[^\s&"']+/gi, '$1[скрыт]');
}

/** Очищенный stderr, не длиннее 64 KiB (UTF-8) — хвост, как у сервера. */
export function cleanStderr(text: string): { text: string; truncated: boolean } {
  const clean = redactSecrets(text.replace(/\r\n?/g, '\n'));
  const bytes = new TextEncoder().encode(clean);
  if (bytes.length <= FFMPEG_STDERR_MAX_BYTES) return { text: clean, truncated: false };
  const tail = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(bytes.length - FFMPEG_STDERR_MAX_BYTES));
  // Первый символ мог разрезаться — отбрасываем его частичный остаток.
  return { text: tail.replace(/^�+/, ''), truncated: true };
}

// ───────────────────────── Задача ─────────────────────────

export type FilesGone = 'expired' | 'purged' | 'purging';

/** «Выполнено, но файлы истекли или отозваны» — отдельная метка (§5.3, §13.1). */
export function filesGone(job: Pick<FfmpegJobRow, 'state' | 'executionStatus' | 'errorCode' | 'artifacts'>): FilesGone | null {
  const executed = job.executionStatus === 'succeeded' || job.state === 'succeeded';
  if (!executed) return null;
  if (job.artifacts === 'purging') return 'purging';
  if (job.errorCode === 'OUTPUT_PURGED' || job.artifacts === 'purged') return 'purged';
  if (job.errorCode === 'OUTPUT_EXPIRED' || job.artifacts === 'expired') return 'expired';
  return null;
}
export const FILES_GONE_LABEL: Record<FilesGone, string> = {
  expired: 'выполнено, но файлы истекли',
  purged: 'выполнено, но файлы отозваны',
  purging: 'выполнено, файлы удаляются',
};

export function canCancel(job: Pick<FfmpegJobRow, 'state'>): boolean {
  return job.state === 'queued' || job.state === 'processing';
}
/** Удалить временные файлы можно, пока они не удалены (активную задачу это тоже останавливает). */
export function canPurge(job: Pick<FfmpegJobRow, 'artifacts' | 'provider'>): boolean {
  return job.provider === 'selfhosted' && job.artifacts !== 'purged' && job.artifacts !== 'purging';
}

/** Внутренний путь админки: только `/x…`, без схемы и `//`. */
export function isInternalHref(href: string | null | undefined): href is string {
  return typeof href === 'string' && /^\/(?![/\\])[^\s]*$/.test(href) && !/^\/[^?#]*:/.test(href);
}

/**
 * Ссылки в исходную операцию продукта: точные — от backend (владельцы
 * задачи в продуктовой БД), иначе — раздел продукта. Только внутренние пути.
 */
export function operationLinks(job: { owners?: Array<{ label: string; href: string }>; product: string | null }): Array<{ href: string; label: string }> {
  const exact = (job.owners ?? []).filter((o) => isInternalHref(o.href)).map((o) => ({ href: o.href, label: o.label }));
  if (exact.length) return exact;
  const product = productOf(job.product);
  return product ? [{ href: PRODUCT_PAGE[product], label: `Раздел «${PRODUCT_LABEL[product]}»` }] : [];
}

export type PreviewKind = 'image' | 'video' | 'audio';
const PREVIEW_MIME: Record<string, PreviewKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/webm': 'audio',
};
/** Безопасный предпросмотр только для растровых картинок, видео и аудио; SVG/HTML/XML — никогда. */
export function previewKind(mime: string | null | undefined): PreviewKind | null {
  if (!mime) return null;
  const m = mime.toLowerCase().split(';')[0].trim();
  if (/svg|html|xml|javascript|pdf/.test(m)) return null;
  return PREVIEW_MIME[m] ?? null;
}

// ───────────────────────── Фильтры в адресе ─────────────────────────

/** Периоды backend (`FFMPEG_PERIODS`); по умолчанию — последние 24 часа. */
export type FfmpegPeriod = '24h' | '7d' | '30d' | '90d';
export const FFMPEG_PERIODS: readonly FfmpegPeriod[] = ['24h', '7d', '30d', '90d'];
export const PERIOD_LABEL: Record<FfmpegPeriod, string> = {
  '24h': 'последние 24 часа',
  '7d': '7 дней',
  '30d': '30 дней',
  '90d': '90 дней (вся история)',
};

export interface FfmpegFilters {
  /** Пусто — свой сервер: у hosted списка задач нет, только поиск по id. */
  provider: 'hosted' | '';
  state: FfmpegJobState | '';
  product: FfmpegProduct | '';
  period: FfmpegPeriod;
  operationId: string;
  jobId: string;
}
export const DEFAULT_FILTERS: FfmpegFilters = {
  provider: '',
  state: '',
  product: '',
  period: '24h',
  operationId: '',
  jobId: '',
};

/** Идентификатор для фильтра: ≤128 печатных ASCII (как X-Client-Operation-Id); id задачи — ≤160 с префиксом. */
export function cleanId(v: string | null | undefined, max = 128): string {
  const t = (v ?? '').trim();
  return t.length <= max && /^[\x21-\x7e]+$/.test(t) ? t : '';
}
/** Id задачи в маршруте backend: hosted как есть или `selfhosted:<id>`. */
export function cleanJobId(v: string | null | undefined): string {
  const t = (v ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(t) ? t : '';
}

interface ParamsLike {
  get(name: string): string | null;
}

/** Фильтры из адреса; неизвестные значения отбрасываются. */
export function parseFilters(params: ParamsLike): FfmpegFilters {
  return {
    // selfhosted — умолчание backend, в адрес не пишется.
    provider: params.get('provider') === 'hosted' ? 'hosted' : '',
    state: oneOf(FFMPEG_STATES)(params.get('state')) ?? '',
    product: productOf(params.get('product')) ?? '',
    period: oneOf(FFMPEG_PERIODS)(params.get('period')) ?? '24h',
    operationId: cleanId(params.get('operationId')),
    jobId: cleanJobId(params.get('jobId')),
  };
}

/** Адрес страницы: только отличия от умолчаний + открытая карточка (`job`). */
export function filtersToSearch(f: FfmpegFilters, openJob?: string | null): string {
  const p = new URLSearchParams();
  if (f.provider) p.set('provider', f.provider);
  if (f.state) p.set('state', f.state);
  if (f.product) p.set('product', f.product);
  if (f.period !== '24h') p.set('period', f.period);
  if (f.operationId) p.set('operationId', f.operationId);
  if (f.jobId) p.set('jobId', f.jobId);
  const job = cleanJobId(openJob);
  if (job) p.set('job', job);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Ссылка на вкладку с фильтром — для очереди внимания и других экранов. */
export function ffmpegHref(filters: Partial<FfmpegFilters> = {}, openJob?: string | null): string {
  return `/ffmpeg${filtersToSearch({ ...DEFAULT_FILTERS, ...filters }, openJob)}`;
}

/** Запрос к backend (`FfmpegJobsQuery` контроллера). */
export function filtersToQuery(f: FfmpegFilters, cursor?: string | null): FfmpegJobsQuery {
  const q: FfmpegJobsQuery = { period: f.period };
  if (cursor) q.cursor = cursor;
  if (f.provider) q.provider = f.provider;
  if (f.state) q.state = f.state;
  if (f.product) q.product = f.product;
  if (f.operationId) q.clientOperationId = f.operationId;
  if (f.jobId) q.jobId = f.jobId;
  return q;
}

export function sameFilters(a: FfmpegFilters, b: FfmpegFilters): boolean {
  return filtersToSearch(a) === filtersToSearch(b);
}

// ───────────────────────── Лимиты и маршрутизация ─────────────────────────

export type LimitUnit = 'count' | 'bytes' | 'sec' | 'px' | 'fps' | 'threads';
export interface LimitField {
  key: string;
  label: string;
  unit: LimitUnit;
}
/** Поля профиля лимитов сервера (`LimitsProfile` в ffmpeg-server/src/contracts.ts). */
export const LIMIT_FIELDS: readonly LimitField[] = [
  { key: 'maxInputs', label: 'Входов в задаче', unit: 'count' },
  { key: 'maxCommands', label: 'Команд в задаче', unit: 'count' },
  { key: 'maxOutputs', label: 'Результатов в задаче', unit: 'count' },
  { key: 'maxCommandsTextBytes', label: 'Текст команд суммарно', unit: 'bytes' },
  { key: 'maxInputBytes', label: 'Один вход', unit: 'bytes' },
  { key: 'maxTotalInputBytes', label: 'Входы суммарно', unit: 'bytes' },
  { key: 'maxTotalOutputBytes', label: 'Результаты суммарно', unit: 'bytes' },
  { key: 'maxWorkspaceBytes', label: 'Рабочая папка задачи', unit: 'bytes' },
  { key: 'maxWidth', label: 'Ширина кадра', unit: 'px' },
  { key: 'maxHeight', label: 'Высота кадра', unit: 'px' },
  { key: 'maxFps', label: 'Частота кадров', unit: 'fps' },
  { key: 'maxInputDurationSec', label: 'Длительность входа', unit: 'sec' },
  { key: 'maxImagePixels', label: 'Пикселей в изображении', unit: 'count' },
  { key: 'pipelineDeadlineSec', label: 'Срок всего pipeline', unit: 'sec' },
  { key: 'queueDeadlineSec', label: 'Срок ожидания в очереди', unit: 'sec' },
  { key: 'downloadFileDeadlineSec', label: 'Скачивание одного файла', unit: 'sec' },
  { key: 'downloadConnectTimeoutSec', label: 'Соединение при скачивании', unit: 'sec' },
  { key: 'downloadStallTimeoutSec', label: 'Скачивание без прогресса', unit: 'sec' },
  { key: 'maxThreads', label: 'Потоков FFmpeg', unit: 'threads' },
  { key: 'stderrTailBytes', label: 'Хвост stderr', unit: 'bytes' },
];
export const UNIT_LABEL: Record<LimitUnit, string> = {
  count: 'шт.',
  bytes: 'МиБ',
  sec: 'с',
  px: 'px',
  fps: 'кадр/с',
  threads: 'потоков',
};
const MIB = 1024 * 1024;

/** Значение для поля формы: байты — в МиБ (до сотых), остальное как есть. */
export function toDisplay(unit: LimitUnit, raw: number): string {
  if (unit !== 'bytes') return String(raw);
  const v = raw / MIB;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}
/** Обратно в число сервера; null — не число. */
export function fromDisplay(unit: LimitUnit, text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return unit === 'bytes' ? Math.round(v * MIB) : Number.isInteger(v) ? v : null;
}
export function formatLimit(unit: LimitUnit, raw: number | null | undefined): string {
  if (raw === null || raw === undefined) return 'нет данных';
  return unit === 'bytes' ? formatBytes(raw) : `${raw} ${UNIT_LABEL[unit]}`;
}

export interface LimitChange {
  key: string;
  label: string;
  unit: LimitUnit;
  from: number | null;
  to: number;
}

/**
 * Изменённые поля и ошибки проверки (сервер проверит то же — это подсказка).
 * Поле без границы деплоя или вне списка `editable` backend не меняется.
 */
export function diffLimits(
  effective: Record<string, number>,
  bounds: Record<string, number>,
  draft: Record<string, string>,
  editable?: readonly string[],
): { changes: LimitChange[]; errors: Record<string, string> } {
  const changes: LimitChange[] = [];
  const errors: Record<string, string> = {};
  for (const f of LIMIT_FIELDS) {
    const text = draft[f.key];
    if (text === undefined) continue;
    const cur = effective[f.key] ?? null;
    if (cur !== null && text === toDisplay(f.unit, cur)) continue;
    if (editable && editable.length && !editable.includes(f.key)) {
      errors[f.key] = 'backend не разрешает менять этот лимит';
      continue;
    }
    const v = fromDisplay(f.unit, text);
    if (v === null || v < 1) {
      errors[f.key] = 'нужно целое положительное число';
      continue;
    }
    const max = bounds[f.key];
    if (typeof max !== 'number') {
      errors[f.key] = 'граница деплоя неизвестна — изменение недоступно';
      continue;
    }
    if (v > max) {
      errors[f.key] = `не больше ${formatLimit(f.unit, max)} (граница деплоя)`;
      continue;
    }
    if (v !== cur) changes.push({ key: f.key, label: f.label, unit: f.unit, from: cur, to: v });
  }
  return { changes, errors };
}

export interface RoutingChange {
  fromProvider: FfmpegProvider;
  toProvider: FfmpegProvider;
  added: FfmpegProduct[];
  removed: FfmpegProduct[];
  /** hosted → selfhosted по умолчанию: отдельное подтверждение владельца. */
  toSelfhostedDefault: boolean;
  changed: boolean;
}
export function diffRouting(cur: FfmpegRouting, nextProvider: FfmpegProvider, nextCanary: FfmpegProduct[]): RoutingChange {
  const added = nextCanary.filter((p) => !cur.canaryProducts.includes(p));
  const removed = cur.canaryProducts.filter((p) => !nextCanary.includes(p));
  return {
    fromProvider: cur.defaultProvider,
    toProvider: nextProvider,
    added,
    removed,
    toSelfhostedDefault: cur.defaultProvider !== 'selfhosted' && nextProvider === 'selfhosted',
    changed: cur.defaultProvider !== nextProvider || added.length > 0 || removed.length > 0,
  };
}

// ───────────────────────── Мутации ─────────────────────────

/** Один ключ операции (UUID) на открытый диалог: повтор и сверка идут с ним же. */
export function newOperationId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Мутация могла дойти и выполниться: сеть, тайм-аут, 5xx, `outcome: unknown`. */
export function isUnknownOutcome(e: unknown): boolean {
  if (e instanceof FfmpegUnknownOutcome || e instanceof FfmpegTimeoutError) return true;
  if (e instanceof ApiRequestError) {
    // «Не настроено» — определённый отказ до отправки, не неизвестный исход.
    const code = e.details?.code;
    if (code === 'FFMPEG_NOT_CONFIGURED' || code === 'FFMPEG_ROUTING_UNAVAILABLE') return false;
    return e.httpStatus >= 500 || e.httpStatus === 0;
  }
  return e instanceof TypeError;
}

export type MutationOutcome<T> =
  | { kind: 'done'; result: T; attempts: number }
  | { kind: 'error'; error: unknown; attempts: number }
  | { kind: 'unknown'; error: unknown; attempts: number };

/** Паузы повторной отправки того же тела (тот же requestId) при неизвестном исходе. */
export const RECONCILE_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * Отправка мутации со сверкой: при неизвестном исходе то же тело (тот же
 * `requestId`) уходит повторно — сервер вернёт прежний результат, а не
 * выполнит действие второй раз. Новый ключ здесь не создаётся никогда.
 */
export async function runWithReconcile<T>(
  send: () => Promise<T>,
  opts: { delays?: readonly number[]; sleep?: (ms: number) => Promise<void>; onUnknown?: (attempt: number) => void; cancelled?: () => boolean } = {},
): Promise<MutationOutcome<T>> {
  const delays = opts.delays ?? RECONCILE_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempts = 0;
  let lastError: unknown;
  for (;;) {
    attempts++;
    try {
      return { kind: 'done', result: await send(), attempts };
    } catch (e) {
      lastError = e;
      if (!isUnknownOutcome(e)) return { kind: 'error', error: e, attempts };
    }
    if (attempts > delays.length || opts.cancelled?.()) return { kind: 'unknown', error: lastError, attempts };
    opts.onUnknown?.(attempts);
    await sleep(delays[attempts - 1]);
    if (opts.cancelled?.()) return { kind: 'unknown', error: lastError, attempts };
  }
}

/** Машинный код отказа: `error.details.code` фильтра backend, иначе класс HTTP. */
export function ffmpegErrorCode(e: unknown): string | undefined {
  if (!(e instanceof ApiRequestError)) return undefined;
  const machine = e.details?.code;
  return typeof machine === 'string' ? machine : e.code;
}

/** После этой ошибки данные на экране устарели — перечитать. */
export function errorNeedsReload(e: unknown): boolean {
  return (e instanceof ApiRequestError && (e.httpStatus === 409 || e.httpStatus === 404 || e.httpStatus === 410)) || e instanceof FfmpegFailedOutcome;
}

export type FfmpegRight = 'read' | 'operate' | 'configure' | 'media';
const RIGHT_TEXT: Record<FfmpegRight, string> = {
  read: 'просмотр вкладки FFmpeg (ffmpeg.read)',
  operate: 'управление очередью и задачами (ffmpeg.operate)',
  configure: 'изменение лимитов и маршрутизации (ffmpeg.configure)',
  media: 'просмотр и скачивание результатов (ffmpeg.media.read)',
};

/** Ошибка словами: что случилось и что делать. */
export function ffmpegErrorText(e: unknown, right: FfmpegRight = 'read'): string {
  if (e instanceof FfmpegTimeoutError) return 'Backend не ответил вовремя.';
  if (e instanceof FfmpegUnknownOutcome) return e.outcome.message ?? 'Результат неизвестен, сверяем.';
  if (e instanceof FfmpegFailedOutcome)
    return `Эта операция уже выполнялась и завершилась отказом: ${e.outcome.message ?? 'без подробностей'}. Повторно она не выполняется — закройте диалог и откройте заново.`;
  if (e instanceof ApiRequestError) {
    const code = ffmpegErrorCode(e);
    if (e.httpStatus === 401) return 'Сессия админки истекла — войдите заново.';
    if (e.httpStatus === 403) {
      if (code && code !== 'FFMPEG_FORBIDDEN' && code !== 'FORBIDDEN')
        return `Отказано в доступе (${code}): ${e.message}`;
      if (code === 'FORBIDDEN' && !/владел|прав/i.test(e.message))
        return `FFmpeg-сервер отказал backend в доступе: ${e.message}. Проверьте ключ ops в настройках деплоя.`;
      return `Нет права: ${RIGHT_TEXT[right]}. До появления ролей доступ есть только у владельца (ADMIN_OWNER_TELEGRAM_IDS).`;
    }
    if (code === 'NOT_RECONCILED')
      return 'Сервер в режиме восстановления (recovery): продолжить можно только после сверки очереди с продуктовой БД — откройте «Продолжить» и подтвердите сверку (право ffmpeg.configure, причина обязательна).';
    if (code === 'FFMPEG_REASON_REQUIRED') return `Нужна причина: ${e.message}`;
    if (e.httpStatus === 409) {
      if (code === 'FFMPEG_STALE_REVISION' || code === 'STALE_REVISION' || code === 'REVISION_CONFLICT')
        return 'Данные изменились, пока вы смотрели (ревизия устарела). Экран обновлён — проверьте и повторите.';
      return `Конфликт: ${e.message}. Экран обновлён.`;
    }
    if (e.httpStatus === 404) return 'Не найдено — возможно, задача удалена из истории. Обновите список.';
    if (e.httpStatus === 410) return 'Файлы больше недоступны (истекли или отозваны).';
    if (e.httpStatus === 400 || e.httpStatus === 422) {
      if (code === 'FFMPEG_HOSTED_UNSUPPORTED') return `Для задачи внешнего провайдера это недоступно: ${e.message}`;
      if (code === 'FFMPEG_DEFAULT_CONFIRMATION_REQUIRED') return 'Перевод default → selfhosted требует отдельного подтверждения владельца.';
      return `Сервер отклонил запрос: ${e.message}`;
    }
    if (e.httpStatus === 429) return 'Слишком много запросов — подождите и повторите.';
    if (code === 'FFMPEG_NOT_CONFIGURED') return `Собственный FFmpeg-сервер не настроен в backend: ${e.message}`;
    if (code === 'FFMPEG_ROUTING_UNAVAILABLE') return `Маршрутизация недоступна: ${e.message}`;
    if (e.httpStatus === 503 || e.httpStatus === 502 || e.httpStatus === 504) return `Сервис недоступен (${e.httpStatus}): ${e.message}`;
    if (e.httpStatus >= 500) return `Ошибка сервера (${e.httpStatus}) — повторите позже.`;
    return e.message;
  }
  if (e instanceof TypeError) return 'Нет связи с backend — проверьте подключение.';
  return e instanceof Error ? e.message : 'Не удалось выполнить запрос';
}

/** Причина для журнала: 3–500 символов без учёта пробелов по краям. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export function reasonValid(reason: string): boolean {
  const t = reason.trim();
  return t.replace(/\s/g, '').length >= REASON_MIN && t.length <= REASON_MAX;
}

/** Текст подтверждения результата мутации. */
export function mutationResultText(title: string, r: FfmpegMutationResult): string {
  const parts: string[] = ['выполнено'];
  const res = isObj(r.result) ? r.result : {};
  if (res.deletionConfirmed === false) parts[0] = 'ссылки отозваны, удаление файлов ещё идёт — завершение видно в карточке';
  else if (res.deletionConfirmed === true) parts[0] = 'файлы удалены, удаление подтверждено сервером';
  if (res.found === false) parts[0] = 'записи нет в БД сервера — это не разрешение отправлять задачу заново, нужна ручная сверка операции продукта';
  else if (res.found === true && typeof res.status === 'string') parts[0] = `статус на сервере: ${labelOf(STATE_LABEL, stateOf(res.status) ?? res.status)}`;
  else if (r.action === 'job.reconcile' && typeof res.status === 'string') parts[0] = `статус у провайдера: ${labelOf(STATE_LABEL, stateOf(res.status) ?? res.status)}`;
  if (typeof res.revision === 'number') parts.push(`ревизия ${res.revision}`);
  if (r.replayed) parts.push('повтор той же операции — действие не выполнялось заново');
  if (r.correlationId) parts.push(`журнал: ${r.correlationId.slice(0, 8)}`);
  return `${title}: ${parts.join('; ')}.`;
}

export async function compileFfmpegDraft(id: string, file: string, document: unknown): Promise<unknown> {
  return ffmpegRequest(`/jobs/${enc(id)}/review-draft`, { method: 'POST', body: { file, document } });
}
