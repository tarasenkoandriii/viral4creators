/**
 * FfmpegApiService — тонкий клиент хостед-ffmpeg (ТЗ §16.1, этап 34).
 *
 * У Vercel Functions нет ffmpeg и не может быть: это не про лимит, а про
 * то, что рендер видео — не задача для функции с потолком в 300 секунд.
 * Поднимать свой воркер ради одной операции (обрезать кадр) дороже, чем
 * отдать её сервису, который только это и делает.
 *
 * Подход и форма запроса взяты из рабочего кода соседнего проекта
 * владельца (`vgffmpeg.service.ts` в atm-travel): один POST с картой
 * входных URL, списком команд и списком имён выходных файлов; сервис сам
 * скачивает входы, подставляет их вместо `{{ключ}}` и отдаёт ссылки на
 * результат. Здесь тот же протокол, но без манифеста клипов: команду
 * собирает `common/reframe.ts`.
 *
 * Что перенесено дословно, потому что проверено на живом API:
 *  - ответы завёрнуты в `data` — и у submit, и у status;
 *  - готовая задача приходит со статусом `succeeded`, а не `completed`;
 *  - `error_message` — пустая строка, а не null, когда ошибки нет;
 *  - повтор при 429 и 5xx с ростом паузы, при 4xx — сразу наружу.
 *
 * ## Два провайдера: hosted и selfhosted (ТЗ FFmpeg-server v1.1 §11)
 *
 * `hosted` — прежний внешний сервис (`FFMPEG_API_BASE_URL`/`FFMPEG_API_KEY`).
 * `selfhosted` — собственный `ffmpeg-server/` (`FFMPEG_SELFHOSTED_BASE_URL`/
 * `FFMPEG_SELFHOSTED_KEY`). Правила, на которых держится переход:
 *
 *  - **Статус маршрутизируется только по префиксу id.** Новые задачи
 *    своего сервера получают id `selfhosted:<uuid>`; всё без префикса —
 *    hosted, всегда, при любой текущей настройке. Поэтому rollback
 *    (смена настройки) не трогает уже принятые задачи: они дорабатывают
 *    у того, кто их принял. Адреса и ключи в id не попадают.
 *  - **Провайдер новой задачи** — строка `ffmpeg_routing` (default +
 *    canary-список продуктов) под env-гейтом `FFMPEG_SELFHOSTED_ENABLED`;
 *    без гейта — всегда hosted, что бы ни лежало в таблице.
 *  - **Fallback к hosted** (решение владельца 21.10.2026 поверх ТЗ §11):
 *    selfhosted — основной, hosted — запасной (`FFMPEG_FALLBACK_HOSTED`, по
 *    умолчанию включён, нужен `FFMPEG_API_KEY`). Тем же телом к hosted
 *    уходит задача, которую свой сервер не принял ДОКАЗАННО: соединение/
 *    DNS/TLS не установлено; ответ самого сервера (`X-FFmpeg-Server: 1`)
 *    503 NOT_ACCEPTING|NOT_READY|SUBMIT_DEADLINE, 429 QUEUE_FULL|
 *    CLIENT_QUOTA_EXCEEDED, 422 UNSUPPORTED_COMMAND, 403 FORBIDDEN_SOURCE;
 *    413. 503 RECOVERY — без fallback. Неизвестный исход (тайм-аут/обрыв,
 *    5xx без кода, ответ не от сервера) сверяется `GET /api/jobs/by-key`:
 *    «нет записи» доказательна только как 404 сервера с `NOT_FOUND` ПОСЛЕ
 *    его дедлайна фиксации (`FFMPEG_SELFHOSTED_COMMIT_DEADLINE_MS`, 10 с) от
 *    начала отправки; иначе — ошибка без fallback.
 *  - **Отправка закреплена за операцией** (`ffmpeg_submissions`, FF-INT-02):
 *    строка пишется до сетевого вызова; повтор той же операции с
 *    неподтверждённой отправкой своему серверу сначала сверяется у него —
 *    при любом breaker, default и гейте; принятая своим сервером — тот же
 *    jobId без новой отправки; fallback записывается в ту же строку.
 *  - **Circuit breaker** (`ffmpeg_routing.breaker*`, учтённые задачи —
 *    `ffmpeg_breaker_jobs`): ≥3 отказа в окне 15 мин — новые задачи к hosted
 *    на `FFMPEG_SELFHOSTED_BREAKER_MINUTES` (10); затем ровно одна пробная
 *    (аренда в БД), остальные — к hosted, пока проба не завершена; её
 *    успешное завершение закрывает breaker.
 *  - **Idempotency-Key selfhosted** — стабильный ключ операции, если
 *    потребитель его дал (`operationKey`), иначе прежний sha256 тела.
 *    `X-Client-Operation-Id` несёт `<product>:<ключ>` — по нему вкладка
 *    «FFmpeg» связывает задачу с продуктом.
 *  - Безопасный `error_code` своего сервера сохраняется в
 *    `FfmpegJobStatus.errorCode` (у hosted разбор статуса прежний).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

export type FfmpegProvider = 'hosted' | 'selfhosted';

/**
 * Продукты-потребители (ТЗ v1.1 §2.1 + инвентаризация по инъекциям
 * `FfmpegApiService`, а не только по `this.ffmpeg`). `tutorial-quality` —
 * сигналы декодера проверки качества демо (`demo-quality.service.ts`):
 * в перечне ТЗ его не было, нашёлся при инвентаризации.
 */
export const FFMPEG_PRODUCTS = [
  'postprod',
  'actors',
  'audio-track',
  'portfolio',
  'story',
  'tutorial-runner',
  'tutorial-video-versions',
  'shared-video',
  'client-site-tutorial',
  'tutorial-quality',
] as const;
export type FfmpegProduct = (typeof FFMPEG_PRODUCTS)[number];

export const SELFHOSTED_JOB_PREFIX = 'selfhosted:';

/** Провайдер задачи — только по префиксу её id (ТЗ §11). */
export function ffmpegProviderOfJobId(jobId: string): FfmpegProvider {
  return jobId.startsWith(SELFHOSTED_JOB_PREFIX) ? 'selfhosted' : 'hosted';
}

/**
 * Поле `provider` для журнала расходов (ТЗ §12). Для hosted — пусто:
 * строка расхода остаётся прежней (`FFMPEG` из прайса модели
 * `ffmpeg-api`). Для своего сервера — `FFMPEG_SELFHOSTED`: расход тот же
 * (`model: ffmpeg-api`, та же оценка — пользовательские списания и
 * суточные потолки не меняются), но в отчёте он отделён от счёта
 * внешнего провайдера и не выдаётся за его invoice.
 */
export function ffmpegUsageProvider(jobId: string | null | undefined): {
  provider?: 'FFMPEG_SELFHOSTED';
} {
  return jobId && ffmpegProviderOfJobId(jobId) === 'selfhosted'
    ? { provider: 'FFMPEG_SELFHOSTED' }
    : {};
}

/** Idempotency-Key / X-Client-Operation-Id: 1–128 печатных ASCII (ТЗ §8). */
const OPERATION_KEY = /^[\x21-\x7e]{1,128}$/;

export interface FfmpegJobRef {
  jobId: string;
  status: string;
  /** Кто принял задачу; тот же провайдер выводится из префикса `jobId`. */
  provider: FfmpegProvider;
}

export interface FfmpegJobStatus {
  /** Наш словарь: pending | completed | failed. */
  status: 'pending' | 'completed' | 'failed';
  /** Имя файла → ссылка на скачивание; есть только у завершённой задачи. */
  outputs?: Record<string, string>;
  error?: string;
  /**
   * Стабильный безопасный код ошибки (`error_code` своего сервера, ТЗ
   * §5.3: `OUTPUT_EXPIRED`, `TIMEOUT`, …). У hosted обычно отсутствует.
   */
  errorCode?: string;
  /**
   * `true` — инфраструктурный провал задачи своего сервера
   * (`FFMPEG_INFRA_ERROR_CODES`): повтор той же операции осмыслен и уйдёт по
   * маршрутизации (с открытым breaker — к hosted). Сам сервис ничего не
   * повторяет: решает потребитель, который уже умеет повторять.
   */
  retryOnFallback?: boolean;
  /**
   * Свой сервер: исполнение завершилось успешно (`execution_status:
   * succeeded`), даже если сейчас `failed` из-за OUTPUT_EXPIRED/PURGED —
   * такой операции новый рендер не положен (ТЗ §5.3).
   */
  executionSucceeded?: boolean;
}

export interface FfmpegRoutingState {
  revision: number;
  defaultProvider: FfmpegProvider;
  canaryProducts: string[];
  updatedAt: Date | null;
  updatedBy: string | null;
  breakerFailures: number;
  breakerOpenUntil: Date | null;
  breakerProbeUntil: Date | null;
}

/** Куда идёт новая задача и почему. */
export interface FfmpegRouteDecision {
  provider: FfmpegProvider;
  /** Hosted вместо своего сервера из-за открытого breaker. */
  fallback?: 'breaker-open';
  /** Единственная пробная задача half-open (аренда взята). */
  probe?: boolean;
}

const SUCCESS = new Set([
  'succeeded',
  'completed',
  'success',
  'done',
  'finished',
]);
const FAILURE = new Set([
  'failed',
  'error',
  'errored',
  'cancelled',
  'canceled',
]);

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Отказ своего сервера ДО приёма задачи — тело можно отдать hosted.
 * Коды принимаются только из ответа самого сервера (`X-FFmpeg-Server: 1`):
 * прокси перед ним (Traefik) такие коды не выдаёт, а его 5xx/404 ничего не
 * доказывают (FF-INT-01).
 */
const REFUSED_BEFORE_ACCEPT: Readonly<Record<number, ReadonlySet<string>>> = {
  503: new Set(['NOT_ACCEPTING', 'NOT_READY', 'SUBMIT_DEADLINE']),
  429: new Set(['QUEUE_FULL', 'CLIENT_QUOTA_EXCEEDED']),
  422: new Set(['UNSUPPORTED_COMMAND']),
  403: new Set(['FORBIDDEN_SOURCE']),
};

/**
 * Сетевые ошибки, при которых тело точно не ушло: соединение/DNS/TLS не
 * установлены. Всё прочее (обрыв, тайм-аут запроса) — исход неизвестен.
 */
const PRE_SEND_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/**
 * Инфраструктурные провалы принятой задачи своего сервера: не вина входа,
 * повтор той же операции может уйти по маршрутизации (с открытым breaker —
 * к hosted). Ошибки входа (`INPUT_*`, `COMMAND_FAILED`, `OUTPUT_*`) сюда не
 * входят: повтор у другого провайдера их не исправит.
 */
export const FFMPEG_INFRA_ERROR_CODES: readonly string[] = [
  'INTERNAL',
  'INTERRUPTED',
  'QUEUE_TIMEOUT',
  'TIMEOUT',
  'OOM',
];

export const FFMPEG_BREAKER_THRESHOLD = 3;
/** Окно счёта отказов (FF-INT-07): старше — счёт начинается заново. */
export const FFMPEG_BREAKER_WINDOW_MS = 15 * 60_000;
/** Аренда пробы half-open до приёма задачи. */
const PROBE_LEASE_MS = 2 * 60_000;
/** Аренда пробы после приёма — до её завершения (весь pipeline ≤15 мин, ТЗ §9). */
const PROBE_JOB_LEASE_MS = 20 * 60_000;
/**
 * Запас поверх дедлайна фиксации сервера (FF-INT-09): сервер считает
 * дедлайн от прихода заголовков, клиент — от начала fetch; запас покрывает
 * установку соединения и доставку через прокси.
 */
const COMMIT_MARGIN_DEFAULT_MS = 5_000;
/** Повтор после терминального провала: ключ `<ключ>:r<n>` (FF-INT-14). */
export function ffmpegAttemptKey(base: string, attempt: number): string {
  if (attempt <= 0) return base;
  const suffix = `:r${attempt}`;
  const head =
    base.length + suffix.length <= 128
      ? base
      : createHash('sha256').update(base).digest('hex');
  return `${head}${suffix}`;
}
/** Тайм-аут отправки своему серверу (обычные потребители), > дедлайна + запас. */
const SELFHOSTED_SUBMIT_TIMEOUT_MS = 30_000;
/** Story (`retrySubmit: false`): весь submit, вместе со сверкой и hosted. */
export const STORY_SUBMIT_BUDGET_MS = 25_000;
/** Меньше этого на hosted в бюджете Story не остаётся — ошибка без fallback. */
const STORY_HOSTED_MIN_MS = 8_000;
/** Сверка по ключу после неизвестного исхода — не дольше. */
const RECONCILE_MAX_MS = 10_000;

type SelfhostedSubmitOutcome =
  | { kind: 'accepted'; data: Record<string, unknown> }
  | { kind: 'refused'; code: string; error: Error }
  | { kind: 'rejected'; error: Error }
  | { kind: 'blocked'; code: string; error: Error }
  | { kind: 'unknown'; code: string; error: Error };

type ByKeyResult =
  | { kind: 'found'; data: Record<string, unknown> }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

export type FfmpegFallbackReason = 'refused' | 'not-found' | 'breaker-open';
type SubmissionState = 'sending' | 'accepted' | 'refused' | 'unknown';

function errorCodeOf(text: string): string | undefined {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    const nested = (v: unknown) =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const raw =
      p.error_code ??
      nested(p.error).code ??
      nested(p.error).error_code ??
      nested(p.data).error_code ??
      p.code;
    return typeof raw === 'string' && ERROR_CODE.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function networkCodeOf(e: unknown): string {
  // undici: `TypeError: fetch failed` с `cause` — ошибкой сокета или
  // AggregateError (IPv4/IPv6) с `errors[]`; код может лежать на любом уровне.
  const seen = new Set<unknown>();
  const find = (x: unknown, depth: number): string | undefined => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 4) return;
    seen.add(x);
    const o = x as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof o.code === 'string') return o.code;
    for (const sub of o.errors ?? []) {
      const c = find(sub, depth + 1);
      if (c) return c;
    }
    return find(o.cause, depth + 1);
  };
  const name = (e as { name?: string })?.name;
  const code =
    find(e, 0) ??
    (name === 'TimeoutError' || name === 'AbortError' ? name : undefined);
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
    ? code
    : 'NETWORK';
}

/** Ответ самого ffmpeg-server, а не прокси перед ним (FF-INT-01). */
function fromServer(res: Response): boolean {
  return res.headers?.get?.('x-ffmpeg-server') === '1';
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

function truthy(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw?.trim() ?? '');
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

interface ProviderEndpoint {
  base: string;
  key: string;
}

interface SubmitBody {
  input_files: Record<string, string>;
  output_files: string[];
  ffmpeg_commands: string[];
}

interface SubmitContext {
  body: SubmitBody;
  bodyHash: string;
  /** Ключ строки `ffmpeg_submissions`: ключ операции или sha256 тела. */
  rowKey: string;
  /** Номер попытки этой операции (0 — первая). */
  attempt: number;
  /** Idempotency-Key своего сервера: `rowKey` или `rowKey:r<attempt>`. */
  key: string;
  product?: FfmpegProduct;
  operationKey?: string;
  retrySubmit?: boolean;
  /** Story: абсолютный срок всего submit (epoch ms). */
  budgetEnd?: number;
  /** Вести ли `ffmpeg_submissions` (только когда свой сервер настроен). */
  track: boolean;
  label: string;
}

@Injectable()
export class FfmpegApiService {
  private readonly logger = new Logger(FfmpegApiService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  private base(): string {
    return (
      process.env.FFMPEG_API_BASE_URL?.replace(/\/+$/, '') ||
      'https://verygoodffmpeg.com/api'
    );
  }

  private key(): string | undefined {
    const raw = process.env.FFMPEG_API_KEY?.trim();
    return raw || undefined;
  }

  /** Адрес и ключ своего сервера; `undefined` — не настроен. */
  private selfhosted(): ProviderEndpoint | undefined {
    const base = process.env.FFMPEG_SELFHOSTED_BASE_URL?.trim().replace(
      /\/+$/,
      '',
    );
    const key = process.env.FFMPEG_SELFHOSTED_KEY?.trim();
    if (!base || !key) return undefined;
    return { base, key };
  }

  /** Env-гейт: без него новые задачи всегда уходят к hosted. */
  selfhostedEnabled(): boolean {
    return truthy(process.env.FFMPEG_SELFHOSTED_ENABLED);
  }

  /** Заданы ли адрес и ключ своего сервера (без раскрытия значений). */
  selfhostedConfigured(): boolean {
    return !!this.selfhosted();
  }

  hostedConfigured(): boolean {
    return !!this.key();
  }

  /**
   * Настроен ли сервис. Не настроен — не ошибка: продукт продолжает
   * работать, просто ролик остаётся в родном формате Veo, а
   * `reframePending` честно висит флагом, как и до этого этапа.
   */
  configured(): boolean {
    return (
      !!this.key() || (this.selfhostedEnabled() && this.selfhostedConfigured())
    );
  }

  /** Fallback к hosted разрешён env (по умолчанию да) и hosted настроен. */
  fallbackEnabled(): boolean {
    const raw = process.env.FFMPEG_FALLBACK_HOSTED?.trim();
    const on = raw === undefined || raw === '' ? true : truthy(raw);
    return on && !!this.key();
  }

  private breakerMs(): number {
    const raw = Number(process.env.FFMPEG_SELFHOSTED_BREAKER_MINUTES);
    const minutes =
      Number.isFinite(raw) && raw > 0 ? Math.min(raw, 24 * 60) : 10;
    return minutes * 60_000;
  }

  /** Запас сверки поверх дедлайна (`FFMPEG_SELFHOSTED_COMMIT_MARGIN_MS`, 5 с). */
  private commitMarginMs(): number {
    const raw = Number(process.env.FFMPEG_SELFHOSTED_COMMIT_MARGIN_MS);
    return Number.isFinite(raw) && raw >= 1_000 && raw <= 30_000
      ? raw
      : COMMIT_MARGIN_DEFAULT_MS;
  }

  /** Дедлайн фиксации задачи своим сервером (как `FFMPEG_SERVER_SUBMIT_COMMIT_DEADLINE_MS`). */
  private commitDeadlineMs(): number {
    const raw = Number(process.env.FFMPEG_SELFHOSTED_COMMIT_DEADLINE_MS);
    return Number.isFinite(raw) && raw >= 1_000 && raw <= 60_000 ? raw : 10_000;
  }

  /**
   * Сохранённая маршрутизация (строка `ffmpeg_routing`). Нет таблицы/строки
   * или сбой чтения — `null`, и новые задачи идут к hosted.
   */
  async readRouting(): Promise<FfmpegRoutingState | null> {
    if (!this.prisma) return null;
    try {
      const row = await this.prisma.ffmpegRouting.findUnique({
        where: { id: 'default' },
      });
      if (!row) return null;
      return {
        revision: row.revision,
        defaultProvider:
          row.defaultProvider === 'hosted' ? 'hosted' : 'selfhosted',
        canaryProducts: row.canaryProducts ?? [],
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        breakerFailures: row.breakerFailures ?? 0,
        breakerOpenUntil: row.breakerOpenUntil ?? null,
        breakerProbeUntil: row.breakerProbeUntil ?? null,
      };
    } catch (e) {
      this.logger.warn(
        `маршрутизация ffmpeg не прочитана, новые задачи — hosted: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  /**
   * Провайдер для НОВОЙ задачи. Уже принятые от него не зависят.
   *
   * Без гейта — hosted. С гейтом: непустой canary-список — к своему серверу
   * только эти продукты; пустой — по `defaultProvider` (по умолчанию
   * selfhosted). Открытый breaker при доступном fallback — hosted;
   * half-open — одна пробная задача (аренда CAS), остальные — hosted.
   */
  async route(product?: FfmpegProduct): Promise<FfmpegRouteDecision> {
    if (!this.selfhostedEnabled()) return { provider: 'hosted' };
    if (!this.selfhostedConfigured()) {
      this.logger.warn(
        'FFMPEG_SELFHOSTED_ENABLED включён, но адрес/ключ своего сервера не заданы — новые задачи идут к hosted',
      );
      return { provider: 'hosted' };
    }
    const routing = await this.readRouting();
    if (!routing) return { provider: 'hosted' };
    const wantsSelf =
      routing.canaryProducts.length > 0
        ? !!product && routing.canaryProducts.includes(product)
        : routing.defaultProvider === 'selfhosted';
    if (!wantsSelf) return { provider: 'hosted' };
    if (
      routing.breakerFailures < FFMPEG_BREAKER_THRESHOLD ||
      !this.fallbackEnabled()
    )
      return { provider: 'selfhosted' };
    const now = Date.now();
    if (routing.breakerOpenUntil && routing.breakerOpenUntil.getTime() > now)
      return { provider: 'hosted', fallback: 'breaker-open' };
    // Half-open: пробу получает тот, кто взял аренду.
    if (await this.takeProbe(now))
      return { provider: 'selfhosted', probe: true };
    return { provider: 'hosted', fallback: 'breaker-open' };
  }

  async chooseProvider(product?: FfmpegProduct): Promise<FfmpegProvider> {
    return (await this.route(product)).provider;
  }

  private async takeProbe(now: number): Promise<boolean> {
    if (!this.prisma) return false;
    try {
      const r = await this.prisma.ffmpegRouting.updateMany({
        where: {
          id: 'default',
          breakerFailures: { gte: FFMPEG_BREAKER_THRESHOLD },
          OR: [
            { breakerProbeUntil: null },
            { breakerProbeUntil: { lt: new Date(now) } },
          ],
        },
        data: {
          breakerProbeUntil: new Date(now + PROBE_LEASE_MS),
          breakerProbeJobId: null,
        },
      });
      return r.count === 1;
    } catch (e) {
      this.logger.warn(
        `аренда пробы ffmpeg не взята: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /** Принятая проба: аренда — до её завершения, id — для закрытия breaker. */
  private async probeAccepted(jobId: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.ffmpegRouting
      .updateMany({
        where: { id: 'default' },
        data: {
          breakerProbeJobId: jobId,
          breakerProbeUntil: new Date(Date.now() + PROBE_JOB_LEASE_MS),
        },
      })
      .catch(() => undefined);
  }

  /**
   * Отказ своего сервера в счёт breaker — атомарными UPDATE без чтения
   * (FF-INT-08). `jobId` — провал принятой задачи: учитывается один раз
   * (`ffmpeg_breaker_jobs`, уникальный ключ).
   */
  private async breakerFailure(jobId?: string): Promise<void> {
    if (!this.prisma) return;
    try {
      if (jobId) {
        try {
          await this.prisma.ffmpegBreakerJob.create({ data: { jobId } });
        } catch (e) {
          if (isUniqueViolation(e)) return;
          throw e;
        }
      }
      const now = new Date();
      // Закрытый breaker и последний отказ старше окна — счёт заново.
      const fresh = await this.prisma.ffmpegRouting.updateMany({
        where: {
          id: 'default',
          breakerOpenUntil: null,
          OR: [
            { breakerLastFailureAt: null },
            {
              breakerLastFailureAt: {
                lt: new Date(now.getTime() - FFMPEG_BREAKER_WINDOW_MS),
              },
            },
          ],
        },
        data: { breakerFailures: 1, breakerLastFailureAt: now },
      });
      if (fresh.count === 0)
        await this.prisma.ffmpegRouting.updateMany({
          where: { id: 'default' },
          data: {
            breakerFailures: { increment: 1 },
            breakerLastFailureAt: now,
          },
        });
      const until = new Date(now.getTime() + this.breakerMs());
      const opened = await this.prisma.ffmpegRouting.updateMany({
        where: {
          id: 'default',
          breakerFailures: { gte: FFMPEG_BREAKER_THRESHOLD },
          OR: [{ breakerOpenUntil: null }, { breakerOpenUntil: { lt: now } }],
        },
        data: {
          breakerOpenUntil: until,
          breakerProbeUntil: null,
          breakerProbeJobId: null,
        },
      });
      if (opened.count === 1)
        this.logger.warn(
          `ffmpeg breaker открыт: отказы своего сервера подряд — новые задачи к hosted до ${until.toISOString()}`,
        );
    } catch (e) {
      this.logger.warn(
        `ffmpeg breaker не обновлён: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Успешно завершённая задача своего сервера. Закрытый breaker — сброс
   * счёта отказов; открытый/half-open закрывает только пробная задача.
   */
  private async breakerSuccess(jobId: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.ffmpegRouting.updateMany({
        where: {
          id: 'default',
          OR: [
            {
              breakerFailures: { gt: 0, lt: FFMPEG_BREAKER_THRESHOLD },
              breakerOpenUntil: null,
            },
            { breakerProbeJobId: jobId },
          ],
        },
        data: {
          breakerFailures: 0,
          breakerLastFailureAt: null,
          breakerOpenUntil: null,
          breakerProbeUntil: null,
          breakerProbeJobId: null,
        },
      });
    } catch (e) {
      this.logger.warn(
        `ffmpeg breaker не сброшен: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Учёт fallback (лог + событие для вкладки «FFmpeg»; не журнал оператора). */
  private async recordFallback(
    reason: FfmpegFallbackReason,
    code: string | null,
    product: FfmpegProduct | undefined,
  ): Promise<void> {
    this.logger.warn(
      `ffmpeg fallback → hosted: ${reason}${code ? ` (${code})` : ''}${product ? `, продукт ${product}` : ''}`,
    );
    if (!this.prisma) return;
    try {
      await this.prisma.ffmpegFallbackEvent.create({
        data: { reason, code, product: product ?? null },
      });
    } catch (e) {
      this.logger.warn(
        `событие fallback не записано: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── ffmpeg_submissions ────────────────────────────────────────────

  private async findSubmission(key: string) {
    if (!this.prisma) return null;
    return this.prisma.ffmpegSubmission.findUnique({
      where: { idempotencyKey: key },
    });
  }

  /** Строка ДО сетевого вызова: провайдер и ключ закреплены за операцией. */
  private async markSending(
    ctx: SubmitContext,
    provider: FfmpegProvider,
    fallbackReason: FfmpegFallbackReason | null,
  ): Promise<void> {
    if (!ctx.track || !this.prisma) return;
    const now = new Date();
    const data = {
      bodyHash: ctx.bodyHash,
      attempt: ctx.attempt,
      product: ctx.product ?? null,
      operationKey: ctx.operationKey ?? null,
      provider,
      state: 'sending',
      jobId: null,
      fallbackReason,
      sentAt: now,
      updatedAt: now,
    };
    await this.prisma.ffmpegSubmission.upsert({
      where: { idempotencyKey: ctx.rowKey },
      create: { idempotencyKey: ctx.rowKey, ...data },
      update: data,
    });
  }

  private async markOutcome(
    ctx: SubmitContext,
    state: SubmissionState,
    jobId?: string,
  ): Promise<void> {
    if (!ctx.track || !this.prisma) return;
    await this.prisma.ffmpegSubmission
      .updateMany({
        where: { idempotencyKey: ctx.rowKey },
        data: { state, jobId: jobId ?? null, updatedAt: new Date() },
      })
      .catch((e: unknown) =>
        this.logger.warn(
          `исход отправки ffmpeg не записан: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        const status = (e as { status?: number }).status;
        // 4xx — это наша ошибка в запросе, повтор её не исправит.
        const transient = !status || status === 429 || status >= 500;
        this.logger.warn(
          `${label}: попытка ${attempt}/3 не удалась — ${
            e instanceof Error ? e.message : String(e)
          }${transient ? ', повторяем' : ', повтор не поможет'}`,
        );
        if (!transient || attempt === 3) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw last;
  }

  private async call(
    base: string,
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      const err = Object.assign(
        new Error(`ffmpeg api ${res.status}: ${text.slice(0, 400)}`),
        { status: res.status },
      );
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // Ответы завёрнуты в `data`; разворачиваем в одном месте, чтобы
      // остальной код не помнил про конверт.
      return (parsed.data as Record<string, unknown>) ?? parsed;
    } catch {
      throw new Error(`ffmpeg api вернул не-JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Отправить задачу. `idempotencyKey` считается из содержимого и уходит
   * заголовком `Idempotency-Key` — по документации протокола это ДОЛЖНО
   * значить, что повтор того же запроса не создаёт вторую задачу и
   * второй счёт. В отличие от списка выше (`data`-обёртка, `succeeded`,
   * `error_message`), это поведение НЕ проверено на живом API (аудит
   * 2026-09-09, Д-4) — считать защитой-по-умолчанию, а не гарантией.
   * Вызывающий код, для которого повторная отправка была бы дорогой
   * ошибкой (двойное списание), обязан САМ не допускать двух вызовов
   * `submit()` для одной и той же задачи — так, как это делает
   * `ActorsService.advanceSubtitleBurn` (замок сессии + свежее чтение из
   * БД под замком непосредственно перед вызовом), а не полагаться на то,
   * что этот заголовок где-то на стороне провайдера спасёт от дубля.
   *
   * `product` — кто заказал (маршрутизация canary и вкладка «FFmpeg»).
   * `operationKey` — стабильный ключ операции продукта (≤128 ASCII):
   * у своего сервера он становится Idempotency-Key, и потерянный ответ
   * сверяется по нему (`GET /api/jobs/by-key/{key}`). Давать его можно
   * только там, где один ключ = одна попытка с одним телом: тот же ключ с
   * другим телом свой сервер отвергнет 409.
   */
  async submit(opts: {
    inputs: Record<string, string>;
    outputs: string[];
    commands: string[];
    retrySubmit?: boolean;
    product?: FfmpegProduct;
    operationKey?: string;
  }): Promise<FfmpegJobRef> {
    if (
      opts.operationKey !== undefined &&
      !OPERATION_KEY.test(opts.operationKey)
    )
      throw new Error(
        'operationKey ffmpeg: 1–128 печатных ASCII-символов без пробелов',
      );
    const started = Date.now();
    const body: SubmitBody = {
      input_files: opts.inputs,
      output_files: opts.outputs,
      ffmpeg_commands: opts.commands,
    };
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const endpoint = this.selfhosted();
    const gate = this.selfhostedEnabled();
    const rowKey = opts.operationKey ?? bodyHash;
    const ctx: SubmitContext = {
      body,
      bodyHash,
      rowKey,
      attempt: 0,
      key: rowKey,
      product: opts.product,
      operationKey: opts.operationKey,
      retrySubmit: opts.retrySubmit,
      budgetEnd:
        opts.retrySubmit === false
          ? started + STORY_SUBMIT_BUDGET_MS
          : undefined,
      // Пишем отправки только при включённом гейте (FF-INT-15): без него
      // путь hosted не пишет в БД ничего.
      track: gate && !!endpoint && !!this.prisma,
      label: `ffmpeg submit${opts.product ? ` [${opts.product}]` : ''}`,
    };

    // FF-INT-02: прежняя отправка этой операции важнее текущей маршрутизации.
    // Без гейта читаем только ради уже существующей selfhosted-строки
    // (сверка у своего сервера после rollback); сбой чтения не мешает hosted.
    if (endpoint && this.prisma) {
      let prev: Awaited<ReturnType<FfmpegApiService['findSubmission']>> = null;
      try {
        prev = await this.findSubmission(rowKey);
      } catch (e) {
        if (gate) throw e;
        this.logger.warn(
          `отправки ffmpeg не прочитаны (гейт выключен — hosted): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (prev && !gate && prev.provider !== 'selfhosted') prev = null;
      if (prev && prev.bodyHash === bodyHash) {
        ctx.attempt = prev.attempt ?? 0;
        ctx.key = ffmpegAttemptKey(rowKey, ctx.attempt);
        if (
          prev.provider === 'selfhosted' &&
          prev.state === 'accepted' &&
          prev.jobId
        ) {
          if (!(await this.selfhostedTerminalFailure(prev.jobId))) {
            this.logger.log(
              `${ctx.label}: операция уже принята своим сервером (${prev.jobId}) — без новой отправки`,
            );
            return {
              jobId: prev.jobId,
              status: 'queued',
              provider: 'selfhosted',
            };
          }
          // FF-INT-14: прошлая попытка терминально провалилась — новая
          // попытка с новым ключом и заново по маршрутизации.
          ctx.attempt += 1;
          ctx.key = ffmpegAttemptKey(rowKey, ctx.attempt);
          this.logger.warn(
            `${ctx.label}: задача ${prev.jobId} провалилась — попытка ${ctx.attempt}`,
          );
        } else if (
          prev.provider === 'selfhosted' &&
          (prev.state === 'sending' || prev.state === 'unknown')
        ) {
          const found = await this.findSelfhostedByKey(
            endpoint,
            ctx.key,
            prev.sentAt.getTime(),
            this.reconcileEnd(ctx, prev.sentAt.getTime()),
          );
          if (found.kind === 'found') {
            const ref = this.selfhostedRef(found.data, ctx.label);
            await this.markOutcome(ctx, 'accepted', ref.jobId);
            return ref;
          }
          if (found.kind === 'unavailable')
            throw new Error(
              'ffmpeg: прошлая отправка этой операции своему серверу не сверена (by-key недоступен) — новая не отправляется',
            );
          // Доказанно нет записи — обычная маршрутизация ниже.
        } else if (prev.provider === 'hosted' && prev.state !== 'refused') {
          // Операция уже у hosted: повтор — туда же, как и до перехода.
          return this.submitHosted(ctx, null);
        }
      }
    }

    const decision = await this.route(opts.product);
    if (decision.provider === 'hosted') {
      if (decision.fallback)
        await this.recordFallback(decision.fallback, null, opts.product);
      return this.submitHosted(ctx, decision.fallback ?? null);
    }
    return this.submitSelfhosted(ctx, endpoint!, decision.probe === true);
  }

  /**
   * Принятая своим сервером задача терминально провалилась/отменена?
   * Ошибка связи — «нет» (вернём прежний jobId: опрос сам покажет исход,
   * второго рендера не будет).
   */
  private async selfhostedTerminalFailure(jobId: string): Promise<boolean> {
    try {
      const st = await this.status(jobId, 5_000, { retry: false });
      // FF-INT-14: новая попытка — только если провалилось само исполнение;
      // истёкшие/отозванные результаты успешной задачи — без нового рендера.
      return st.status === 'failed' && !st.executionSucceeded;
    } catch {
      return false;
    }
  }

  /** Конец окна сверки по ключу для отправки, начатой в `sentAt`. */
  private reconcileEnd(ctx: SubmitContext, sentAt: number): number {
    const conclusive = sentAt + this.commitDeadlineMs() + this.commitMarginMs();
    const end = Math.max(Date.now() + this.reconcileMaxMs, conclusive + 1_000);
    return ctx.budgetEnd ? Math.min(end, ctx.budgetEnd) : end;
  }

  private async submitSelfhosted(
    ctx: SubmitContext,
    endpoint: ProviderEndpoint,
    probe: boolean,
  ): Promise<FfmpegJobRef> {
    const label = `${ctx.label} [selfhosted${probe ? ', проба' : ''}]`;
    await this.markSending(ctx, 'selfhosted', null);
    const sentAt = Date.now();
    // Тайм-аут клиента больше дедлайна фиксации сервера + запас: после него
    // by-key 404 доказывает «не принято» (FF-INT-09). Story — в своём бюджете.
    const minTimeout = this.commitDeadlineMs() + this.commitMarginMs() + 1_000;
    const timeoutMs = ctx.budgetEnd ? minTimeout : SELFHOSTED_SUBMIT_TIMEOUT_MS;
    const outcome = await this.postSelfhosted(endpoint, ctx, timeoutMs);

    if (outcome.kind === 'accepted') {
      const ref = this.selfhostedRef(outcome.data, label);
      await this.markOutcome(ctx, 'accepted', ref.jobId);
      if (probe) await this.probeAccepted(ref.jobId);
      return ref;
    }
    if (outcome.kind === 'rejected') {
      await this.markOutcome(ctx, 'refused');
      throw outcome.error;
    }
    if (outcome.kind === 'blocked') {
      // RECOVERY: ключ мог быть принят до потери БД — ни повтора, ни hosted.
      this.logger.warn(`${label}: сервер в recovery — без fallback`);
      await this.markOutcome(ctx, 'unknown');
      throw outcome.error;
    }
    if (outcome.kind === 'refused') {
      this.logger.warn(`${label}: отказ до приёма (${outcome.code})`);
      await this.markOutcome(ctx, 'refused');
      // A rejected command/source is job-specific, not a server outage.
      if (
        !['UNSUPPORTED_COMMAND', 'FORBIDDEN_SOURCE'].includes(
          outcome.code ?? '',
        )
      )
        await this.breakerFailure();
      return this.fallbackOrThrow(ctx, 'refused', outcome.code, outcome.error);
    }

    this.logger.warn(
      `${label}: исход неизвестен (${outcome.code}) — сверка по ключу`,
    );
    const found = await this.findSelfhostedByKey(
      endpoint,
      ctx.key,
      sentAt,
      this.reconcileEnd(ctx, sentAt),
    );
    if (found.kind === 'found') {
      this.logger.log(`${label}: задача найдена по ключу — без повтора`);
      const ref = this.selfhostedRef(found.data, label);
      await this.markOutcome(ctx, 'accepted', ref.jobId);
      if (probe) await this.probeAccepted(ref.jobId);
      return ref;
    }
    await this.breakerFailure();
    if (found.kind === 'unavailable') {
      await this.markOutcome(ctx, 'unknown');
      this.logger.warn(
        `${label}: сверка по ключу не дала доказательного ответа — к hosted не отправляем`,
      );
      throw outcome.error;
    }
    await this.markOutcome(ctx, 'refused');
    return this.fallbackOrThrow(ctx, 'not-found', outcome.code, outcome.error);
  }

  private async fallbackOrThrow(
    ctx: SubmitContext,
    reason: FfmpegFallbackReason,
    code: string,
    error: Error,
  ): Promise<FfmpegJobRef> {
    if (!this.fallbackEnabled()) throw error;
    if (ctx.budgetEnd && ctx.budgetEnd - Date.now() < STORY_HOSTED_MIN_MS) {
      this.logger.warn(
        `${ctx.label}: на hosted не осталось времени в бюджете ${STORY_SUBMIT_BUDGET_MS / 1000} с — ошибка без fallback`,
      );
      throw error;
    }
    await this.recordFallback(reason, code, ctx.product);
    return this.submitHosted(ctx, reason);
  }

  private selfhostedRef(
    data: Record<string, unknown>,
    label: string,
  ): FfmpegJobRef {
    const rawId = (data.id ?? data.jobId ?? data.job_id) as string | undefined;
    if (!rawId)
      throw new Error(
        'ответ ffmpeg-сервиса не содержит id задачи — см. лог для формата ответа',
      );
    const jobId = `${SELFHOSTED_JOB_PREFIX}${String(rawId)}`;
    this.logger.log(`${label}: задача ${jobId} принята`);
    return {
      jobId,
      status: String(data.status ?? 'queued'),
      provider: 'selfhosted',
    };
  }

  /** Прежний путь hosted — запрос байт в байт прежний (ключ от содержимого). */
  private async submitHosted(
    ctx: SubmitContext,
    fallbackReason: FfmpegFallbackReason | null,
  ): Promise<FfmpegJobRef> {
    const key = this.key();
    if (!key) throw new Error('FFMPEG_API_KEY не задан');
    const label = `${ctx.label} [hosted]`;
    if (ctx.track)
      await this.markSending(ctx, 'hosted', fallbackReason).catch(
        (e: unknown) =>
          this.logger.warn(
            `отправка ffmpeg не закреплена: ${e instanceof Error ? e.message : String(e)}`,
          ),
      );
    const timeout = ctx.budgetEnd
      ? Math.min(25_000, Math.max(1_000, ctx.budgetEnd - Date.now()))
      : 25_000;
    const request = () =>
      this.call(this.base(), '/ffmpeg', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': ctx.bodyHash,
        },
        body: JSON.stringify(ctx.body),
        ...(ctx.retrySubmit === false
          ? { signal: AbortSignal.timeout(timeout) }
          : {}),
      });
    let data: Record<string, unknown>;
    try {
      data =
        ctx.retrySubmit === false
          ? await request()
          : await this.withRetry(request, label);
    } catch (e) {
      await this.markOutcome(ctx, 'unknown');
      throw e;
    }
    const jobId = (data.id ?? data.jobId ?? data.job_id) as string | undefined;
    if (!jobId) {
      await this.markOutcome(ctx, 'unknown');
      throw new Error(
        'ответ ffmpeg-сервиса не содержит id задачи — см. лог для формата ответа',
      );
    }
    await this.markOutcome(ctx, 'accepted', String(jobId));
    return {
      jobId: String(jobId),
      status: String(data.status ?? 'queued'),
      provider: 'hosted',
    };
  }

  /** Одна отправка своему серверу с классификацией исхода. */
  private async postSelfhosted(
    endpoint: ProviderEndpoint,
    ctx: SubmitContext,
    timeoutMs: number,
  ): Promise<SelfhostedSubmitOutcome> {
    let res: Response;
    try {
      res = await fetch(`${endpoint.base}/ffmpeg`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': ctx.key,
          'X-Client-Operation-Id': `${ctx.product ?? 'unknown'}:${
            ctx.operationKey ?? ctx.bodyHash.slice(0, 32)
          }`.slice(0, 128),
        },
        body: JSON.stringify(ctx.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const code = networkCodeOf(e);
      const error = new Error(`ffmpeg api (selfhosted) недоступен: ${code}`);
      return PRE_SEND_ERRORS.has(code)
        ? { kind: 'refused', code, error }
        : { kind: 'unknown', code, error };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      // Заголовки пришли, тело оборвалось: принято ли — неизвестно.
      const code = networkCodeOf(e);
      return {
        kind: 'unknown',
        code,
        error: new Error(`ffmpeg api (selfhosted): обрыв ответа (${code})`),
      };
    }
    if (res.ok) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const data = (parsed.data as Record<string, unknown>) ?? parsed;
        if (data.id ?? data.jobId ?? data.job_id)
          return { kind: 'accepted', data };
      } catch {
        // ниже
      }
      return {
        kind: 'unknown',
        code: `HTTP_${res.status}`,
        error: new Error(
          `ffmpeg api (selfhosted) ${res.status}: ответ без id задачи`,
        ),
      };
    }
    const server = fromServer(res);
    const code = server ? errorCodeOf(text) : undefined;
    const error = Object.assign(
      new Error(`ffmpeg api ${res.status}: ${text.slice(0, 400)}`),
      { status: res.status, code },
    );
    // 413 — тело отвергнуто до приёма (сервером или прокси перед ним).
    if (res.status === 413)
      return { kind: 'refused', code: code ?? 'HTTP_413', error };
    if (!server) return { kind: 'unknown', code: `PROXY_${res.status}`, error };
    if (code === 'RECOVERY') return { kind: 'blocked', code, error };
    if (code && REFUSED_BEFORE_ACCEPT[res.status]?.has(code))
      return { kind: 'refused', code, error };
    if (res.status >= 500 || res.status === 429)
      return { kind: 'unknown', code: code ?? `HTTP_${res.status}`, error };
    return { kind: 'rejected', error };
  }

  /** Шаг между попытками сверки и её минимальное окно (тесты сокращают). */
  protected reconcileStepMs = 1_000;
  protected reconcileMaxMs = RECONCILE_MAX_MS;

  /**
   * Сверка потерянного ответа: `GET /api/jobs/by-key/{key}` с короткими
   * повторами до `endAt`. «Нет записи» доказательна только как 404 самого
   * сервера (`X-FFmpeg-Server: 1`, `error.code = NOT_FOUND`) и только после
   * его дедлайна фиксации от начала отправки (FF-INT-01, FF-INT-09): до
   * него запрос мог ещё идти к транзакции. Иначе — `unavailable`.
   */
  private async findSelfhostedByKey(
    endpoint: ProviderEndpoint,
    key: string,
    sentAt: number,
    endAt: number,
  ): Promise<ByKeyResult> {
    const conclusiveAt =
      sentAt + this.commitDeadlineMs() + this.commitMarginMs();
    for (;;) {
      const left = endAt - Date.now();
      if (left <= 0) break;
      try {
        const res = await fetch(
          `${endpoint.base}/jobs/by-key/${encodeURIComponent(key)}`,
          {
            headers: { Authorization: `Bearer ${endpoint.key}` },
            signal: AbortSignal.timeout(Math.min(3_000, left)),
          },
        );
        const text = await res.text();
        if (res.ok) {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const data = (parsed.data as Record<string, unknown>) ?? parsed;
          if (data.id ?? data.jobId ?? data.job_id)
            return { kind: 'found', data };
        } else if (
          res.status === 404 &&
          fromServer(res) &&
          errorCodeOf(text) === 'NOT_FOUND'
        ) {
          if (Date.now() >= conclusiveAt) return { kind: 'absent' };
          // Дедлайн фиксации не прошёл — ждём его и спрашиваем снова.
          await sleep(Math.min(conclusiveAt - Date.now(), endAt - Date.now()));
          continue;
        }
      } catch {
        // сеть — ещё попытка
      }
      await sleep(Math.min(this.reconcileStepMs, endAt - Date.now()));
    }
    return { kind: 'unavailable' };
  }

  /**
   * Статус задачи. `opts.retry: false` — одна попытка без повторов
   * (сверка из админки: ответ за ≤ тайм-аута, а не за три попытки).
   */
  async status(
    jobId: string,
    timeoutMs?: number,
    opts: { retry?: boolean } = {},
  ): Promise<FfmpegJobStatus> {
    const provider = ffmpegProviderOfJobId(jobId);
    let base: string;
    let key: string | undefined;
    let remoteId = jobId;
    if (provider === 'selfhosted') {
      // Гейт `FFMPEG_SELFHOSTED_ENABLED` здесь НЕ проверяется: rollback
      // выключает только новые задачи, принятые дорабатывают у нас.
      const endpoint = this.selfhosted();
      if (!endpoint)
        throw new Error(
          'FFMPEG_SELFHOSTED_BASE_URL/FFMPEG_SELFHOSTED_KEY не заданы — задачу своего сервера опросить нечем (к hosted она не уходит)',
        );
      base = endpoint.base;
      key = endpoint.key;
      remoteId = jobId.slice(SELFHOSTED_JOB_PREFIX.length);
    } else {
      base = this.base();
      key = this.key();
      if (!key) throw new Error('FFMPEG_API_KEY не задан');
    }

    const request = () =>
      this.call(base, `/jobs/${encodeURIComponent(remoteId)}`, {
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        headers: { Authorization: `Bearer ${key}` },
      });
    const data =
      opts.retry === false
        ? await request()
        : await this.withRetry(request, `ffmpeg status [${provider}]`);

    const raw = String(data.status ?? '');
    const status = SUCCESS.has(raw)
      ? 'completed'
      : FAILURE.has(raw)
        ? 'failed'
        : 'pending';

    const files = data.output_files as Record<string, string> | undefined;
    const outputs = files && Object.keys(files).length > 0 ? files : undefined;

    // `error_message` приходит пустой строкой, а не null, когда ошибки
    // нет — сравнение с undefined тут дало бы ложное «ошибка есть».
    const message = (data.error_message ?? data.error) as string | undefined;
    if (provider === 'hosted')
      // FF-INT-10: разбор статуса hosted — как до перехода, без error_code.
      return { status, outputs, error: message ? message : undefined };

    const code =
      typeof data.error_code === 'string' && ERROR_CODE.test(data.error_code)
        ? data.error_code
        : undefined;
    const result: FfmpegJobStatus = {
      status,
      outputs,
      error: message ? message : code,
    };
    if (code) result.errorCode = code;
    if (
      data.execution_status === 'succeeded' ||
      code === 'OUTPUT_EXPIRED' ||
      code === 'OUTPUT_PURGED'
    )
      result.executionSucceeded = true;
    if (status === 'completed') await this.breakerSuccess(jobId);
    else if (
      status === 'failed' &&
      code &&
      FFMPEG_INFRA_ERROR_CODES.includes(code)
    ) {
      result.retryOnFallback = true;
      await this.breakerFailure(jobId);
    }
    return result;
  }
}
