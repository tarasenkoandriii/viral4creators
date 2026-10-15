/**
 * Клиент внутреннего API sites-backend для вкладки «Reddit» админки
 * (пакет P-R-ADM) — по образцу `AdminAssistClient`: генератор не получает
 * DSN схемы `sites`, только HTTP к `SITES_BACKEND_URL` с секретом
 * `SITES_INTERNAL_SECRET` (`X-Sites-Internal-Secret`) и id оператора
 * (`X-Admin-Actor`; на стороне sites-backend он становится актором
 * `admin:<userId>`, Р-RD-ADM-2).
 *
 * Адрес строится ТОЛЬКО по таблице `ADMIN_REDDIT_ROUTES` (имя маршрута →
 * метод и шаблон пути): параметры пути проверяются по формату, query
 * фильтруется по списку маршрута, тело — JSON-объект в пределах лимита.
 * Невалидное — 400 без запроса к sites-backend.
 *
 * Ошибки (как у помощника): не настроено — 503 с понятным текстом; 4xx
 * sites-backend — тот же код, машинный код ошибки и её `details`
 * (PUB_VALIDATION `fields`, PUB_CONFLICT `reason`/`existingId`,
 * PUB_GATE_CLOSED `missing` …) — без `meta`, с вычищенным секретом;
 * 401 (секреты не совпали) и прочие 5xx — 502. Исключение (Р-RD-ADM-B3):
 * 503 `PUB_BUSY`/`PUB_AI_UNAVAILABLE` — «повторите», а не авария, —
 * уходят 503 с тем же кодом. Таймаут, сеть и 504 самого sites-backend
 * (функция не уложилась в лимит) — 504 `UPSTREAM_TIMEOUT` (Р-RD-AUD-7):
 * результат неизвестен, повтор с тем же `opKey` безопасен (идемпотентность
 * sites-backend вернёт прежний ответ, а не создаст дубль). Тела запросов и ответов НЕ логируются — в
 * журнале только имя маршрута, статус и класс сетевой ошибки.
 */
import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ForbiddenException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ADMIN_REDDIT_PARAM_KEYS,
  ADMIN_REDDIT_ROUTES,
  AdminRedditRoute,
  AdminRedditRouteName,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUT_MS,
  PATH_PARAM_KIND,
  PUB_ID_RE,
} from './admin-reddit.routes';

/** Предел одного значения query (поиск `q`, курсор `before`). */
const QUERY_VALUE_MAX = 200;
/** Предел текста ошибки и `details`, которые уходят оператору. */
const ERROR_MESSAGE_MAX = 500;
const ERROR_DETAILS_MAX_BYTES = 16 * 1024;
/** Предел ответа sites-backend, который мы готовы разобрать. */
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
/** 503 sites-backend, которые значат «повторите», а не «сломалось». */
const RETRYABLE_503 = new Set(['PUB_BUSY', 'PUB_AI_UNAVAILABLE']);
/**
 * Машинный код 504: sites-backend не ответил (таймаут, сеть, его 504).
 * Админка считает его повторяемым с тем же `opKey` (Р-RD-AUD-7).
 */
export const UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT';
const UPSTREAM_TIMEOUT_MESSAGE =
  'Бэкенд клиентских сайтов не ответил вовремя — результат неизвестен, повтор безопасен';
const MACHINE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** `X-Admin-Actor` по контракту: id пользователя backend (cuid). */
const ACTOR_RE = /^[A-Za-z0-9_-]{1,58}$/;
const CSV_FILENAME_RE = /^[A-Za-z0-9._-]{1,100}\.csv$/;
const REDACTED = '[скрыто]';

export interface AdminRedditCall {
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface AdminRedditResult<T = unknown> {
  /** Статус ответа sites-backend (200/201/202) — контроллер отдаёт его же. */
  status: number;
  data: T;
  /**
   * Выгрузка `?format=csv` (только маршруты с `csv: true`). `nextBefore` —
   * заголовок `X-Next-Before` sites-backend (курсор следующей части, если
   * строк больше предела части); только формата id, иначе отброшен.
   */
  csv?: { text: string; filename: string; nextBefore: string | null };
}

/**
 * Ключ, под которым клиент кладёт `details` ответа sites-backend в
 * HttpException; `HttpExceptionFilter` разворачивает его в `error.details`
 * (тот же вид, что у sites-backend, — Админка переиспользует разбор
 * причин кабинета assist).
 */
export const UPSTREAM_DETAILS_KEY = 'upstreamDetails';

@Injectable()
export class AdminRedditClient {
  private readonly logger = new Logger(AdminRedditClient.name);
  /** Тесты подменяют сеть и env. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  env: NodeJS.ProcessEnv = process.env;

  configured(): boolean {
    return !!this.base() && !!this.secret();
  }

  private base(): string | null {
    const raw = this.env.SITES_BACKEND_URL?.trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (
        u.protocol !== 'https:' &&
        u.hostname !== 'localhost' &&
        u.hostname !== 'sites-backend'
      ) {
        return null;
      }
      return u.origin;
    } catch {
      return null;
    }
  }

  private secret(): string | null {
    const s = this.env.SITES_INTERNAL_SECRET?.trim();
    return s && s.length >= 16 ? s : null;
  }

  /** Внутренний путь маршрута (без origin) — или 400, если вход негоден. */
  buildPath(name: AdminRedditRouteName, call: AdminRedditCall = {}): string {
    const route: AdminRedditRoute | undefined =
      Object.prototype.hasOwnProperty.call(ADMIN_REDDIT_ROUTES, name)
        ? ADMIN_REDDIT_ROUTES[name]
        : undefined;
    if (!route) throw new BadRequestException('Маршрут не разрешён');
    const params = call.params ?? {};
    const segments = route.path.split('/').map((seg) => {
      if (!seg.startsWith(':')) return seg;
      const key = seg.slice(1);
      const value = params[key];
      if (typeof value !== 'string' || !validParam(key, value)) {
        throw new BadRequestException({
          message: `Некорректный параметр пути «${key}»`,
          error: 'BAD_PATH_PARAM',
        });
      }
      return encodeURIComponent(value);
    });
    const qs = new URLSearchParams();
    for (const key of route.query ?? []) {
      const raw = call.query?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'string' || raw.length > QUERY_VALUE_MAX) {
        throw new BadRequestException({
          message: `Некорректный параметр «${key}»`,
          error: 'BAD_QUERY_PARAM',
        });
      }
      qs.set(key, raw);
    }
    const q = qs.toString();
    return `/internal/admin/reddit/${segments.join('/')}${q ? `?${q}` : ''}`;
  }

  async call<T = unknown>(
    name: AdminRedditRouteName,
    actor: string,
    call: AdminRedditCall = {},
  ): Promise<AdminRedditResult<T>> {
    const route: AdminRedditRoute = ADMIN_REDDIT_ROUTES[name];
    const path = this.buildPath(name, call);
    if (!ACTOR_RE.test(actor)) {
      throw new ForbiddenException('Некорректный id оператора');
    }
    let payload: string | undefined;
    if (route.method !== 'GET') {
      const body = call.body ?? {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestException({
          message: 'Ожидается JSON-объект',
          error: 'BAD_REQUEST',
        });
      }
      payload = JSON.stringify(body);
      const limit = route.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      if (Buffer.byteLength(payload, 'utf8') > limit) {
        throw new PayloadTooLargeException({
          message: `Тело запроса больше ${Math.round(limit / 1024)} КБ`,
          error: 'PAYLOAD_TOO_LARGE',
        });
      }
    }
    const base = this.base();
    const secret = this.secret();
    if (!base || !secret) {
      throw new ServiceUnavailableException(
        'Раздел Reddit не подключён к админке: задайте SITES_BACKEND_URL и SITES_INTERNAL_SECRET (doc/DEPLOYMENT.md §6.12)',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method: route.method,
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'X-Sites-Internal-Secret': secret,
          'X-Admin-Actor': actor,
          Accept: route.csv
            ? 'application/json, text/csv;q=0.9'
            : 'application/json',
          'Accept-Language': 'ru',
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        ...(payload !== undefined ? { body: payload } : {}),
      });
      text = await readCapped(res, RESPONSE_MAX_BYTES);
    } catch (err) {
      this.logger.warn(
        `sites-backend не ответил на reddit.${name}: ${(err as Error)?.name ?? 'Error'}`,
      );
      // Ответ пришёл, но больше предела — исход известен, это не таймаут.
      if (err instanceof RangeError) {
        throw new BadGatewayException('Бэкенд клиентских сайтов вернул ошибку');
      }
      throw upstreamTimeout();
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && route.csv && isCsv(res)) {
      return {
        status: res.status,
        data: null as T,
        csv: {
          text,
          filename: csvFilename(res, name),
          nextBefore: nextBeforeOf(res),
        },
      };
    }
    const json = parseJson(text) as {
      data?: T;
      error?: { code?: unknown; message?: unknown; details?: unknown };
    } | null;
    if (!res.ok) {
      this.logger.warn(`sites-backend ответил ${res.status} на reddit.${name}`);
      throw this.mapError(res.status, json?.error, secret);
    }
    // sites-backend отвечает конвертом { success, data, meta }.
    return { status: res.status, data: (json?.data ?? null) as T };
  }

  private mapError(
    status: number,
    error: { code?: unknown; message?: unknown; details?: unknown } | undefined,
    secret: string,
  ): HttpException {
    const code =
      typeof error?.code === 'string' && MACHINE_CODE.test(error.code)
        ? error.code
        : null;
    const passThrough =
      (status >= 400 && status < 500 && status !== 401) ||
      (status === 503 && code !== null && RETRYABLE_503.has(code));
    if (status === 504) return upstreamTimeout();
    if (!passThrough) {
      return new BadGatewayException(
        status === 401
          ? 'Неверный SITES_INTERNAL_SECRET: секреты генератора и sites-backend не совпадают'
          : status === 503 && code === 'SERVICE_UNAVAILABLE'
            ? 'На sites-backend не задан SITES_INTERNAL_SECRET — внутренний API закрыт'
            : 'Бэкенд клиентских сайтов вернул ошибку',
      );
    }
    const message =
      typeof error?.message === 'string' && error.message.trim()
        ? redact(error.message, secret).slice(0, ERROR_MESSAGE_MAX)
        : 'Запрос отклонён';
    const details = safeDetails(error?.details, secret);
    return new HttpException(
      {
        message,
        error: code ?? 'SITES_BACKEND_ERROR',
        ...(details ? { [UPSTREAM_DETAILS_KEY]: details } : {}),
      },
      status === 503 ? HttpStatus.SERVICE_UNAVAILABLE : status,
    );
  }
}

/** 504 `UPSTREAM_TIMEOUT`: исход запроса к sites-backend неизвестен. */
function upstreamTimeout(): GatewayTimeoutException {
  return new GatewayTimeoutException({
    message: UPSTREAM_TIMEOUT_MESSAGE,
    error: UPSTREAM_TIMEOUT,
  });
}

function validParam(key: string, value: string): boolean {
  const kind = PATH_PARAM_KIND[key];
  if (kind === 'id') return PUB_ID_RE.test(value);
  if (kind === 'paramKey') {
    return (ADMIN_REDDIT_PARAM_KEYS as readonly string[]).includes(value);
  }
  return false;
}

function nextBeforeOf(res: Response): string | null {
  const v = res.headers.get('x-next-before')?.trim();
  return v && PUB_ID_RE.test(v) ? v : null;
}

function isCsv(res: Response): boolean {
  return /^text\/csv\b/i.test(res.headers.get('content-type') ?? '');
}

/** Имя файла выгрузки — из ответа, если оно безопасное, иначе своё. */
function csvFilename(res: Response, name: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const fromUpstream = m?.[1]?.trim();
  return fromUpstream && CSV_FILENAME_RE.test(fromUpstream)
    ? fromUpstream
    : `reddit-${name}.csv`;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Тело ответа целиком, но не больше `max` байт (иначе — ошибка сети). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new RangeError('response too large');
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > max) throw new RangeError('response too large');
  return new TextDecoder().decode(buf);
}

/** Секрет не уходит наружу ни в тексте, ни в details — даже если эхо. */
function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join(REDACTED) : text;
}

function safeDetails(
  details: unknown,
  secret: string,
): Record<string, unknown> | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  let raw: string;
  try {
    raw = JSON.stringify(details);
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, 'utf8') > ERROR_DETAILS_MAX_BYTES) return null;
  return scrub(JSON.parse(raw), secret) as Record<string, unknown>;
}

/** Глубокая копия JSON с вычищенным секретом в ключах и строках. */
function scrub(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return redact(value, secret);
  if (Array.isArray(value)) return value.map((v) => scrub(v, secret));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[redact(k, secret)] = scrub(v, secret);
    }
    return out;
  }
  return value;
}
