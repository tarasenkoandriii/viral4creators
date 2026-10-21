/**
 * Конфигурация сервера из env (ТЗ §5.1, §9; бриф Р-FF-3/4).
 *
 * Принципы:
 *  - всё проверяется при старте; плохая конфигурация — отказ старта с
 *    понятной причиной, без вывода значений секретов;
 *  - верхние границы лимитов задаются env `FFMPEG_SERVER_LIMIT_*`
 *    (по умолчанию — значения ТЗ §9); эффективный профиль в БД не может
 *    их превысить (ops POST limits);
 *  - клиенты — только хеши ключей (sha256 hex), до двух на клиента.
 */
import path from 'node:path';
import type { LimitsProfile } from './contracts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ClientConfig {
  clientId: string;
  role: 'client' | 'ops';
  /** sha256 hex (нижний регистр) ключей; 1–2 активных. */
  keySha256: string[];
}

export type KeyRing = { active: string; keys: Map<string, Buffer> };

export type LimitsCeiling = Omit<LimitsProfile, 'revision'>;

export interface ServerConfig {
  port: number;
  host: string;
  /** Внешний https-адрес для ссылок на файлы (без хвостового /). */
  publicBaseUrl: string;
  dataDir: string;
  dbPath: string;
  /** Файл-маркер состояния управления (вне БД — для детекта потери БД). */
  controlMarkerPath: string;
  workspaceRoot: string;
  outputsRoot: string;
  clients: ClientConfig[];
  payloadKeys: KeyRing;
  hmacKeys: KeyRing;
  /** Хосты-источники входов (`host` или `*.suffix`). */
  inputAllowedHosts: string[];
  limitsCeiling: LimitsCeiling;
  queue: { maxQueuedTotal: number; maxQueuedPerClient: number };
  disk: {
    minFreeBytes: number;
    maxWorkspacesBytes: number;
    maxOutputsBytes: number;
  };
  retention: {
    outputTtlSec: number;
    downloadTokenTtlSec: number;
    historyDays: number;
    tombstoneDays: number;
  };
  /** Максимальный размер JSON тела POST. */
  maxBodyBytes: number;
  /** Позже этого срока от получения POST задача не фиксируется (FF-INT-09). */
  submitCommitDeadlineMs: number;
  /** Ожидаемые фильтры/энкодеры для capability self-test. */
  requiredFilters: string[];
  requiredEncoders: string[];
  imageDigest: string | null;
  executor: { heartbeatStaleSec: number; pollIntervalMs: number };
  dispatcherTickMs: number;
  cleanupIntervalSec: number;
  /** Online backup SQLite; dir = null — выключен. */
  backup: { dir: string | null; intervalSec: number; retentionDays: number };
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const KiB = 1024;

/** Значения ТЗ §9 — верхние границы по умолчанию. */
export const SPEC_LIMITS: LimitsCeiling = {
  maxInputs: 20,
  maxCommands: 10,
  maxOutputs: 10,
  maxCommandsTextBytes: 128 * KiB,
  maxInputBytes: 512 * MiB,
  maxTotalInputBytes: 1 * GiB,
  maxTotalOutputBytes: 512 * MiB,
  maxWorkspaceBytes: 4 * GiB,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 60,
  maxInputDurationSec: 600,
  maxImagePixels: 24_000_000,
  pipelineDeadlineSec: 900,
  queueDeadlineSec: 1200,
  downloadFileDeadlineSec: 120,
  downloadConnectTimeoutSec: 10,
  downloadStallTimeoutSec: 15,
  maxThreads: 2,
  stderrTailBytes: 64 * KiB,
};

/** Имя env верхней границы: maxInputBytes → FFMPEG_SERVER_LIMIT_MAX_INPUT_BYTES. */
export function limitEnvName(key: keyof LimitsCeiling): string {
  return 'FFMPEG_SERVER_LIMIT_' + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Дополнительные фильтры/энкодеры для /api/ready сверх capability
 * self-test executor (он сверяет сборку с allowlist корпуса команд и
 * делает смоук-рендер libx264+aac+libass). По умолчанию пусто: источник
 * правды — корпус; env нужен, если эксплуатация хочет требовать больше.
 */
export const DEFAULT_REQUIRED_FILTERS: string[] = [];
export const DEFAULT_REQUIRED_ENCODERS: string[] = [];

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, def?: string): string {
  const v = env[name]?.trim();
  if (v) return v;
  if (def !== undefined) return def;
  throw new ConfigError(`${name} не задан`);
}

function int(
  env: Env,
  name: string,
  def: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name}: ожидается целое`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name}: вне диапазона [${min}, ${max}]`);
  }
  return n;
}

function list(env: Env, name: string, def: string[]): string[] {
  const raw = env[name]?.trim();
  if (!raw) return def;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJson(env: Env, name: string): unknown {
  const raw = env[name]?.trim();
  if (!raw) throw new ConfigError(`${name} не задан`);
  try {
    return JSON.parse(raw);
  } catch {
    // Значение не выводим: там могут быть ключи.
    throw new ConfigError(`${name}: невалидный JSON`);
  }
}

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function parseClients(value: unknown): ClientConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError('FFMPEG_SERVER_CLIENTS: нужен непустой массив');
  }
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const out: ClientConfig[] = [];
  for (const [i, item] of value.entries()) {
    const at = `FFMPEG_SERVER_CLIENTS[${i}]`;
    if (!item || typeof item !== 'object') {
      throw new ConfigError(`${at}: ожидается объект`);
    }
    const rec = item as Record<string, unknown>;
    const extra = Object.keys(rec).filter(
      (k) => !['clientId', 'role', 'keySha256'].includes(k),
    );
    if (extra.length) {
      throw new ConfigError(`${at}: лишние поля ${extra.join(', ')}`);
    }
    const clientId = rec.clientId;
    if (typeof clientId !== 'string' || !ID_RE.test(clientId)) {
      throw new ConfigError(`${at}.clientId: 1–64 символа [A-Za-z0-9._-]`);
    }
    if (seenIds.has(clientId)) {
      throw new ConfigError(`${at}.clientId: дубликат ${clientId}`);
    }
    seenIds.add(clientId);
    const role = rec.role;
    if (role !== 'client' && role !== 'ops') {
      throw new ConfigError(`${at}.role: 'client' | 'ops'`);
    }
    const hashes = rec.keySha256;
    if (
      !Array.isArray(hashes) ||
      hashes.length < 1 ||
      hashes.length > 2 ||
      !hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h))
    ) {
      throw new ConfigError(
        `${at}.keySha256: 1–2 sha256 hex (ротация — не более двух активных)`,
      );
    }
    const norm = (hashes as string[]).map((h) => h.toLowerCase());
    for (const h of norm) {
      if (seenHashes.has(h)) {
        throw new ConfigError(`${at}.keySha256: ключ уже принадлежит клиенту`);
      }
      seenHashes.add(h);
    }
    out.push({ clientId, role, keySha256: norm });
  }
  return out;
}

export function parseKeyRing(
  env: Env,
  keysName: string,
  activeName: string,
): KeyRing {
  const value = parseJson(env, keysName);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${keysName}: ожидается объект {keyId: base64}`);
  }
  const keys = new Map<string, Buffer>();
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ID_RE.test(id)) throw new ConfigError(`${keysName}: плохой keyId`);
    if (typeof raw !== 'string') {
      throw new ConfigError(`${keysName}.${id}: ожидается base64`);
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32 || buf.toString('base64') !== raw.trim()) {
      throw new ConfigError(`${keysName}.${id}: нужен base64 ровно 32 байт`);
    }
    keys.set(id, buf);
  }
  if (keys.size === 0) throw new ConfigError(`${keysName}: нет ключей`);
  const active = str(env, activeName);
  if (!keys.has(active)) {
    throw new ConfigError(`${activeName}: ключа с таким id нет в ${keysName}`);
  }
  return { active, keys };
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const dataDir = path.resolve(str(env, 'FFMPEG_SERVER_DATA_DIR', '/data'));
  const workspaceRoot = path.resolve(
    str(env, 'FFMPEG_SERVER_WORKSPACE_ROOT', '/workspace'),
  );
  const outputsRoot = path.resolve(
    str(env, 'FFMPEG_SERVER_OUTPUTS_ROOT', path.join(dataDir, 'outputs')),
  );
  for (const [a, b] of [
    [workspaceRoot, outputsRoot],
    [workspaceRoot, dataDir],
  ]) {
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
      throw new ConfigError(
        'WORKSPACE_ROOT не должен совпадать/вкладываться с DATA_DIR/OUTPUTS_ROOT',
      );
    }
  }
  if (workspaceRoot === '/') throw new ConfigError('WORKSPACE_ROOT = /');

  const publicBaseUrl = str(env, 'FFMPEG_SERVER_PUBLIC_BASE_URL').replace(
    /\/+$/,
    '',
  );
  let pub: URL;
  try {
    pub = new URL(publicBaseUrl);
  } catch {
    throw new ConfigError('FFMPEG_SERVER_PUBLIC_BASE_URL: невалидный URL');
  }
  const allowHttp = env.FFMPEG_SERVER_ALLOW_HTTP_PUBLIC_URL === '1';
  if (pub.protocol !== 'https:' && !(allowHttp && pub.protocol === 'http:')) {
    throw new ConfigError('FFMPEG_SERVER_PUBLIC_BASE_URL: только https');
  }
  if (pub.username || pub.password || pub.search || pub.hash) {
    throw new ConfigError(
      'FFMPEG_SERVER_PUBLIC_BASE_URL: без userinfo/query/hash',
    );
  }

  const ceiling = { ...SPEC_LIMITS };
  for (const key of Object.keys(SPEC_LIMITS) as (keyof LimitsCeiling)[]) {
    ceiling[key] = int(env, limitEnvName(key), SPEC_LIMITS[key], 1);
  }
  if (ceiling.maxThreads > 2) {
    // ТЗ §9: threads/filter_threads не выше 2 на общем VPS.
    throw new ConfigError(`${limitEnvName('maxThreads')}: не больше 2`);
  }

  const inputAllowedHosts = list(env, 'FFMPEG_SERVER_INPUT_ALLOWED_HOSTS', []);
  if (inputAllowedHosts.length === 0) {
    throw new ConfigError(
      'FFMPEG_SERVER_INPUT_ALLOWED_HOSTS: нужен allowlist хостов входов',
    );
  }
  for (const h of inputAllowedHosts) {
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(h) || h === '*') {
      throw new ConfigError(`FFMPEG_SERVER_INPUT_ALLOWED_HOSTS: плохой хост`);
    }
  }

  const cfg: ServerConfig = {
    port: int(env, 'FFMPEG_SERVER_PORT', 8080, 1, 65535),
    host: str(env, 'FFMPEG_SERVER_HOST', '0.0.0.0'),
    publicBaseUrl,
    dataDir,
    dbPath: path.join(dataDir, 'ffmpeg-server.db'),
    controlMarkerPath: path.join(dataDir, 'control-state.json'),
    workspaceRoot,
    outputsRoot,
    clients: parseClients(parseJson(env, 'FFMPEG_SERVER_CLIENTS')),
    payloadKeys: parseKeyRing(
      env,
      'FFMPEG_SERVER_PAYLOAD_KEYS',
      'FFMPEG_SERVER_PAYLOAD_KEY_ACTIVE',
    ),
    hmacKeys: parseKeyRing(
      env,
      'FFMPEG_SERVER_HMAC_KEYS',
      'FFMPEG_SERVER_HMAC_KEY_ACTIVE',
    ),
    inputAllowedHosts: inputAllowedHosts.map((h) => h.toLowerCase()),
    limitsCeiling: ceiling,
    queue: {
      maxQueuedTotal: int(env, 'FFMPEG_SERVER_MAX_QUEUED', 20, 1, 1000),
      maxQueuedPerClient: int(
        env,
        'FFMPEG_SERVER_MAX_QUEUED_PER_CLIENT',
        10,
        1,
        1000,
      ),
    },
    disk: {
      minFreeBytes: int(env, 'FFMPEG_SERVER_DISK_MIN_FREE_BYTES', 15 * GiB),
      maxWorkspacesBytes: int(
        env,
        'FFMPEG_SERVER_DISK_MAX_WORKSPACES_BYTES',
        15 * GiB,
        1,
      ),
      maxOutputsBytes: int(
        env,
        'FFMPEG_SERVER_DISK_MAX_OUTPUTS_BYTES',
        10 * GiB,
        1,
      ),
    },
    retention: {
      outputTtlSec: int(env, 'FFMPEG_SERVER_OUTPUT_TTL_SEC', 86400, 60),
      downloadTokenTtlSec: int(
        env,
        'FFMPEG_SERVER_DOWNLOAD_TOKEN_TTL_SEC',
        1800,
        10,
        1800,
      ),
      historyDays: int(env, 'FFMPEG_SERVER_HISTORY_DAYS', 90, 1, 3650),
      tombstoneDays: int(env, 'FFMPEG_SERVER_TOMBSTONE_DAYS', 90, 90, 3650),
    },
    maxBodyBytes: int(env, 'FFMPEG_SERVER_MAX_BODY_BYTES', 512 * KiB, 1024),
    submitCommitDeadlineMs: int(
      env,
      'FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS',
      10_000,
      100,
      120_000,
    ),
    requiredFilters: list(
      env,
      'FFMPEG_SERVER_REQUIRED_FILTERS',
      DEFAULT_REQUIRED_FILTERS,
    ),
    requiredEncoders: list(
      env,
      'FFMPEG_SERVER_REQUIRED_ENCODERS',
      DEFAULT_REQUIRED_ENCODERS,
    ),
    imageDigest: env.FFMPEG_SERVER_IMAGE_DIGEST?.trim() || null,
    executor: {
      heartbeatStaleSec: int(
        env,
        'FFMPEG_SERVER_EXECUTOR_HEARTBEAT_STALE_SEC',
        30,
        2,
      ),
      pollIntervalMs: int(env, 'FFMPEG_SERVER_EXECUTOR_POLL_MS', 1000, 10),
    },
    dispatcherTickMs: int(env, 'FFMPEG_SERVER_DISPATCHER_TICK_MS', 1000, 10),
    cleanupIntervalSec: int(env, 'FFMPEG_SERVER_CLEANUP_INTERVAL_SEC', 300, 1),
    backup: {
      dir: env.FFMPEG_SERVER_BACKUP_DIR?.trim()
        ? path.resolve(env.FFMPEG_SERVER_BACKUP_DIR.trim())
        : null,
      intervalSec: int(env, 'FFMPEG_SERVER_BACKUP_INTERVAL_SEC', 900, 60),
      retentionDays: int(env, 'FFMPEG_SERVER_BACKUP_RETENTION_DAYS', 7, 1, 365),
    },
  };
  if (cfg.retention.historyDays > cfg.retention.tombstoneDays) {
    throw new ConfigError(
      'FFMPEG_SERVER_HISTORY_DAYS не может превышать TOMBSTONE_DAYS',
    );
  }
  if (!cfg.clients.some((c) => c.role === 'ops')) {
    throw new ConfigError('FFMPEG_SERVER_CLIENTS: нужен хотя бы один ops');
  }
  return cfg;
}

/** Безопасное описание конфигурации для лога старта (без секретов). */
export function describeConfig(cfg: ServerConfig): Record<string, unknown> {
  return {
    port: cfg.port,
    publicBaseUrl: cfg.publicBaseUrl,
    dataDir: cfg.dataDir,
    workspaceRoot: cfg.workspaceRoot,
    outputsRoot: cfg.outputsRoot,
    clients: cfg.clients.map((c) => ({
      clientId: c.clientId,
      role: c.role,
      keys: c.keySha256.length,
    })),
    payloadKeyActive: cfg.payloadKeys.active,
    hmacKeyActive: cfg.hmacKeys.active,
    inputAllowedHosts: cfg.inputAllowedHosts.length,
    queue: cfg.queue,
  };
}
