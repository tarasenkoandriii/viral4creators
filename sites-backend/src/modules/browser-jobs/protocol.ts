/**
 * Протокол очереди браузерного воркера (Э-С Ш3) — ОДИН источник правды для
 * обеих сторон: sites-backend (ставит задания, проверяет результат) и
 * `browser-worker/` (забирает и исполняет). Копия у воркера —
 * `browser-worker/src/shared/browser-job-protocol.ts` (scripts/sync-worker-shared.mjs,
 * CI сверяет `--check`).
 *
 * ЧИСТЫЙ модуль: только встроенные возможности JS — без Nest, Prisma и Node.
 *
 * Что здесь:
 *  - виды заданий и их параметры (без секретов: учётка Ш2 приходит ТОЛЬКО
 *    отдельным запросом воркера `credentials`, в параметрах её нет);
 *  - маршруты внутреннего API (`/internal/worker/v1/*`) и вызывающий;
 *  - лимиты (элементов, страниц, кадров, байтов результата);
 *  - коды ошибок — ЗАКРЫТЫЙ список: свободного текста от воркера сервер не
 *    принимает (в тексте ошибки браузера бывают адрес с query и ПД);
 *  - строгий разбор параметров и результата: лишнее поле, чужой хост,
 *    превышение лимита — отказ, а не «тихо обрезали».
 */

export const WORKER_CALLER = 'browser-worker';

export const WORKER_API_PREFIX = '/internal/worker/v1';

export const WORKER_ROUTES = {
  claim: '/internal/worker/v1/jobs/claim',
  heartbeat: '/internal/worker/v1/jobs/heartbeat',
  complete: '/internal/worker/v1/jobs/complete',
  fail: '/internal/worker/v1/jobs/fail',
  credentials: '/internal/worker/v1/jobs/credentials',
  artifact: '/internal/worker/v1/jobs/artifact',
} as const;

export const BROWSER_JOB_KINDS = [
  'ui-snapshot',
  'admin-crawl',
  'descriptor-resolve',
  'frames-capture',
] as const;
export type BrowserJobKind = (typeof BROWSER_JOB_KINDS)[number];

export const BROWSER_VIEWPORTS = ['mobile', 'desktop'] as const;
export type BrowserViewport = (typeof BROWSER_VIEWPORTS)[number];

/** Размер окна по виду (мобильный — как `CAPTURE_VIEWPORT` обучалки). */
export const VIEWPORT_SIZE: Readonly<
  Record<BrowserViewport, { width: number; height: number }>
> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};

export const WORKER_LIMITS = {
  /** Заданий за один claim. */
  claimMax: 4,
  /** Срок аренды задания; продлевается heartbeat. */
  leaseMs: 60_000,
  /** Как часто воркер шлёт heartbeat. */
  heartbeatMs: 15_000,
  /** Тела запросов воркера (байты). */
  smallBodyBytes: 8 * 1024,
  completeBodyBytes: 384 * 1024,
  artifactBodyBytes: 2_200_000,
  /** Результат задания (JSON) — после разбора. */
  resultBytes: 320 * 1024,
  /** Один артефакт (скриншот JPEG) — байты до base64. */
  artifactBytes: 1_500_000,
  artifactsPerJob: 12,
  /** Хостов в замке задания. */
  allowedHosts: 10,
  snapshotElements: 150,
  mapElements: 60,
  crawlPages: 30,
  crawlDepth: 3,
  pageTextChars: 6000,
  descriptorPages: 10,
  descriptorTargets: 60,
  selectorsPerTarget: 4,
  frames: 10,
  /** Подресурсов на страницу (картинки, скрипты, XHR) — дальше обрыв. */
  requestsPerPage: 400,
  urlChars: 2000,
  textChars: 80,
  titleChars: 200,
  selectorChars: 200,
} as const;

/** Потолок времени исполнения задания (стена), мс. */
export const JOB_WALL_MS: Readonly<Record<BrowserJobKind, number>> = {
  'ui-snapshot': 60_000,
  'descriptor-resolve': 150_000,
  'admin-crawl': 300_000,
  'frames-capture': 120_000,
};

/**
 * Коды отказа воркера — закрытый список. Повтор решает СЕРВЕР по коду
 * (`RETRYABLE_ERRORS`), а не воркер: воркер не может «назначить» себе
 * бесконечные попытки.
 */
export const WORKER_ERROR_CODES = [
  'bad_params',
  'nav_failed',
  'nav_timeout',
  'egress_blocked',
  'offhost_redirect',
  'login_form_missing',
  'login_failed',
  'credentials_unavailable',
  'host_not_verified',
  'too_large',
  // Потолок трафика воркера (Ш3-хвост (9)): тело ответа или весь трафик
  // задания больше потолка — не повторяется (сайт тот же).
  'traffic_limit',
  'browser_crashed',
  'job_timeout',
  'cancelled',
  'shutdown',
  'internal',
] as const;
export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

export const RETRYABLE_ERRORS: ReadonlySet<WorkerErrorCode> = new Set([
  'nav_timeout',
  'browser_crashed',
  'job_timeout',
  'shutdown',
  'internal',
]);

export function isWorkerErrorCode(v: unknown): v is WorkerErrorCode {
  return (
    typeof v === 'string' &&
    (WORKER_ERROR_CODES as readonly string[]).includes(v)
  );
}

// ── параметры заданий ──────────────────────────────────────────────────────

export interface UiSnapshotParams {
  url: string;
  allowedHosts: string[];
  viewport: BrowserViewport;
  /** Скриншот видимой области — артефактом (режим «Снимок»). */
  screenshot: boolean;
  /** Элементы в форме общей карты Ш4 (`ingestUiSnapshot`). */
  mapElements: boolean;
}

export interface DescriptorResolveParams {
  pages: string[];
  allowedHosts: string[];
  viewport: BrowserViewport;
  /** Цели карты: ключ и CSS-кандидаты (разметка, test-id, id, css). */
  targets: Array<{ key: string; selectors: string[] }>;
}

export interface AdminCrawlParams {
  startUrl: string;
  allowedHosts: string[];
  viewport: BrowserViewport;
  maxPages: number;
  maxDepth: number;
  /** Как входить: пароль (форма), готовая сессия (куки) или «как получится». */
  loginMethod: 'password' | 'session' | 'sso';
}

export interface FramesCaptureParams {
  url: string;
  allowedHosts: string[];
  viewport: BrowserViewport;
  frames: number;
}

export type BrowserJobParams =
  | UiSnapshotParams
  | DescriptorResolveParams
  | AdminCrawlParams
  | FramesCaptureParams;

// ── результаты ────────────────────────────────────────────────────────────

export interface WorkerBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Элемент снимка: поля `UiSnapElement` (assist-ui-core) + рамка. */
export interface WorkerSnapElement {
  ref: string;
  role: string;
  tag: string;
  text: string;
  hiddenLabel: string | null;
  assistId: string | null;
  inputType: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  selected: string | null;
  options: string[];
  heading: string | null;
  submit: boolean;
  inForm: boolean;
  confirmZone: boolean;
  pd: boolean;
  toggle: boolean;
  gesture: string | null;
  inView: boolean;
  box: WorkerBox | null;
}

export interface WorkerSnapshot {
  url: string;
  title: string;
  elements: WorkerSnapElement[];
}

/** Элемент в форме общей карты Ш4 (`cleanUiSnapshot` разбирает ещё раз). */
export interface WorkerMapElement {
  tag: string;
  label: string;
  role: string | null;
  assistId: string | null;
  selector: string | null;
}

export interface UiSnapshotResult {
  finalUrl: string;
  snapshot: WorkerSnapshot;
  mapElements: WorkerMapElement[];
  /** Номер артефакта скриншота (загружен отдельным запросом) или null. */
  screenshot: number | null;
  viewport: { width: number; height: number };
  blockedRequests: number;
}

export interface DescriptorResolveResult {
  pages: Array<{
    url: string;
    ok: boolean;
    error: WorkerErrorCode | null;
    /** Ключ цели → число совпадений на каждый селектор (порядок — как в параметрах). */
    counts: Record<string, number[]>;
    snapshot: WorkerSnapshot | null;
  }>;
}

export interface AdminCrawlResult {
  loggedIn: boolean;
  pages: Array<{ url: string; title: string; text: string }>;
  /** Сколько кликов отклонено стоп-листом (опасные цели). */
  refusedClicks: number;
  /** Сколько ссылок пропущено (опасные, выход, чужой хост, лимит). */
  skippedLinks: number;
}

export interface FramesCaptureResult {
  finalUrl: string;
  frames: Array<{ artifact: number; scrollY: number }>;
}

export type BrowserJobResult =
  | UiSnapshotResult
  | DescriptorResolveResult
  | AdminCrawlResult
  | FramesCaptureResult;

// ── разбор ────────────────────────────────────────────────────────────────

export class ProtocolError extends Error {
  constructor(readonly field: string) {
    super(`browser-job protocol: ${field}`);
    this.name = 'ProtocolError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function exactKeys(
  o: Record<string, unknown>,
  keys: readonly string[],
  where: string,
): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw new ProtocolError(`${where}.${k}`);
  }
  for (const k of keys) {
    if (!(k in o)) throw new ProtocolError(`${where}.${k}`);
  }
}

const HOST_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;

/** Хост замка: имя в нижнем регистре (+ необязательный порт), без IP-литералов. */
export function isLockHost(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 260 || !HOST_RE.test(v)) return false;
  const bare = v.replace(/:\d+$/, '');
  // IPv4-литерал как имя (`10.0.0.1`) — не хост замка.
  return !/^\d+(\.\d+){3}$/.test(bare);
}

/** Хост URL в форме замка (`host` или `host:port`, порт — если нестандартный). */
export function lockHostOf(u: URL): string {
  const def = u.protocol === 'https:' ? '443' : '80';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return u.port && u.port !== def ? `${host}:${u.port}` : host;
}

/**
 * Адрес задания: http(s), без логина в адресе, хост — из замка задания.
 * Возвращает нормализованную строку.
 */
export function lockedUrl(
  raw: unknown,
  allowedHosts: readonly string[],
): string {
  if (typeof raw !== 'string' || raw.length > WORKER_LIMITS.urlChars) {
    throw new ProtocolError('url');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProtocolError('url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ProtocolError('url.scheme');
  }
  if (u.username || u.password) throw new ProtocolError('url.userinfo');
  if (!allowedHosts.includes(lockHostOf(u))) {
    throw new ProtocolError('url.host');
  }
  u.hash = '';
  return u.toString();
}

function hostsOf(v: unknown): string[] {
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    v.length > WORKER_LIMITS.allowedHosts ||
    !v.every(isLockHost)
  ) {
    throw new ProtocolError('allowedHosts');
  }
  return [...new Set(v as string[])];
}

function viewportOf(v: unknown): BrowserViewport {
  if (!(BROWSER_VIEWPORTS as readonly unknown[]).includes(v)) {
    throw new ProtocolError('viewport');
  }
  return v as BrowserViewport;
}

function intIn(v: unknown, min: number, max: number, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ProtocolError(field);
  }
  return v;
}

const TARGET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// Тот же набор символов, что `CSS_RE` дескриптора карты (voice-map.ts).
const SELECTOR_RE = /^[A-Za-z0-9\s#.:()[\]="'_*^$|~+>,\\-]{1,200}$/;

export function isSafeSelector(v: unknown): v is string {
  return typeof v === 'string' && SELECTOR_RE.test(v);
}

/** Строгий разбор параметров задания (обе стороны). */
export function parseJobParams(
  kind: BrowserJobKind,
  raw: unknown,
): BrowserJobParams {
  if (!isObj(raw)) throw new ProtocolError('params');
  switch (kind) {
    case 'ui-snapshot': {
      exactKeys(
        raw,
        ['url', 'allowedHosts', 'viewport', 'screenshot', 'mapElements'],
        'params',
      );
      const allowedHosts = hostsOf(raw.allowedHosts);
      if (
        typeof raw.screenshot !== 'boolean' ||
        typeof raw.mapElements !== 'boolean'
      ) {
        throw new ProtocolError('params.flags');
      }
      return {
        url: lockedUrl(raw.url, allowedHosts),
        allowedHosts,
        viewport: viewportOf(raw.viewport),
        screenshot: raw.screenshot,
        mapElements: raw.mapElements,
      };
    }
    case 'descriptor-resolve': {
      exactKeys(
        raw,
        ['pages', 'allowedHosts', 'viewport', 'targets'],
        'params',
      );
      const allowedHosts = hostsOf(raw.allowedHosts);
      if (
        !Array.isArray(raw.pages) ||
        raw.pages.length === 0 ||
        raw.pages.length > WORKER_LIMITS.descriptorPages
      ) {
        throw new ProtocolError('params.pages');
      }
      const pages = [
        ...new Set(raw.pages.map((p) => lockedUrl(p, allowedHosts))),
      ];
      if (
        !Array.isArray(raw.targets) ||
        raw.targets.length > WORKER_LIMITS.descriptorTargets
      ) {
        throw new ProtocolError('params.targets');
      }
      const seen = new Set<string>();
      const targets = raw.targets.map((t, i) => {
        if (!isObj(t)) throw new ProtocolError(`params.targets.${i}`);
        exactKeys(t, ['key', 'selectors'], `params.targets.${i}`);
        if (typeof t.key !== 'string' || !TARGET_KEY_RE.test(t.key)) {
          throw new ProtocolError(`params.targets.${i}.key`);
        }
        if (seen.has(t.key)) throw new ProtocolError(`params.targets.${i}.key`);
        seen.add(t.key);
        if (
          !Array.isArray(t.selectors) ||
          t.selectors.length > WORKER_LIMITS.selectorsPerTarget ||
          !t.selectors.every(isSafeSelector)
        ) {
          throw new ProtocolError(`params.targets.${i}.selectors`);
        }
        return { key: t.key, selectors: [...(t.selectors as string[])] };
      });
      return {
        pages,
        allowedHosts,
        viewport: viewportOf(raw.viewport),
        targets,
      };
    }
    case 'admin-crawl': {
      exactKeys(
        raw,
        [
          'startUrl',
          'allowedHosts',
          'viewport',
          'maxPages',
          'maxDepth',
          'loginMethod',
        ],
        'params',
      );
      const allowedHosts = hostsOf(raw.allowedHosts);
      if (!['password', 'session', 'sso'].includes(raw.loginMethod as string)) {
        throw new ProtocolError('params.loginMethod');
      }
      return {
        startUrl: lockedUrl(raw.startUrl, allowedHosts),
        allowedHosts,
        viewport: viewportOf(raw.viewport),
        maxPages: intIn(
          raw.maxPages,
          1,
          WORKER_LIMITS.crawlPages,
          'params.maxPages',
        ),
        maxDepth: intIn(
          raw.maxDepth,
          0,
          WORKER_LIMITS.crawlDepth,
          'params.maxDepth',
        ),
        loginMethod: raw.loginMethod as AdminCrawlParams['loginMethod'],
      };
    }
    case 'frames-capture': {
      exactKeys(raw, ['url', 'allowedHosts', 'viewport', 'frames'], 'params');
      const allowedHosts = hostsOf(raw.allowedHosts);
      return {
        url: lockedUrl(raw.url, allowedHosts),
        allowedHosts,
        viewport: viewportOf(raw.viewport),
        frames: intIn(raw.frames, 1, WORKER_LIMITS.frames, 'params.frames'),
      };
    }
    default:
      throw new ProtocolError('kind');
  }
}

export function isBrowserJobKind(v: unknown): v is BrowserJobKind {
  return (
    typeof v === 'string' &&
    (BROWSER_JOB_KINDS as readonly string[]).includes(v)
  );
}

// ── разбор результата ─────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

function text(v: unknown, max: number, field: string): string {
  if (typeof v !== 'string' || v.length > max) throw new ProtocolError(field);
  return v.replace(CONTROL, ' ');
}

function textOrNull(v: unknown, max: number, field: string): string | null {
  if (v === null) return null;
  return text(v, max, field);
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new ProtocolError(field);
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) {
    throw new ProtocolError(field);
  }
  return Math.round(v);
}

/** Адрес, который вернул воркер: http(s) на хосте замка; query и фрагмент — вон. */
function resultUrl(
  v: unknown,
  allowedHosts: readonly string[],
  field: string,
): string {
  let u: URL;
  try {
    u = new URL(lockedUrl(v, allowedHosts));
  } catch {
    throw new ProtocolError(field);
  }
  return `${u.origin}${u.pathname}`;
}

const SNAP_KEYS = [
  'ref',
  'role',
  'tag',
  'text',
  'hiddenLabel',
  'assistId',
  'inputType',
  'href',
  'disabled',
  'checked',
  'selected',
  'options',
  'heading',
  'submit',
  'inForm',
  'confirmZone',
  'pd',
  'toggle',
  'gesture',
  'inView',
  'box',
] as const;

/**
 * Адрес ссылки элемента снимка: `null` или http(s) без логина в адресе,
 * только origin + путь (≤ 300). Аудит Ш3: раньше проверялась лишь длина —
 * воркер (он живёт рядом с чужим JS) мог бы сдать `javascript:`/`data:`,
 * а снимок уходит в TMA владельца.
 */
function snapHref(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 300) throw new ProtocolError(field);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ProtocolError(field);
  }
  if (
    (u.protocol !== 'https:' && u.protocol !== 'http:') ||
    u.username ||
    u.password
  ) {
    throw new ProtocolError(field);
  }
  const out = `${u.origin}${u.pathname}`;
  if (out.length > 300) throw new ProtocolError(field);
  return out;
}

function snapElement(raw: unknown, i: number): WorkerSnapElement {
  const f = `snapshot.elements.${i}`;
  if (!isObj(raw)) throw new ProtocolError(f);
  exactKeys(raw, SNAP_KEYS, f);
  const L = WORKER_LIMITS.textChars;
  let box: WorkerBox | null = null;
  if (raw.box !== null) {
    if (!isObj(raw.box)) throw new ProtocolError(`${f}.box`);
    exactKeys(raw.box, ['x', 'y', 'w', 'h'], `${f}.box`);
    box = {
      x: num(raw.box.x, `${f}.box.x`),
      y: num(raw.box.y, `${f}.box.y`),
      w: num(raw.box.w, `${f}.box.w`),
      h: num(raw.box.h, `${f}.box.h`),
    };
  }
  if (
    !Array.isArray(raw.options) ||
    raw.options.length > 12 ||
    !raw.options.every((o) => typeof o === 'string' && o.length <= L)
  ) {
    throw new ProtocolError(`${f}.options`);
  }
  const href = snapHref(raw.href, `${f}.href`);
  if (raw.checked !== null && typeof raw.checked !== 'boolean') {
    throw new ProtocolError(`${f}.checked`);
  }
  return {
    ref: text(raw.ref, 8, `${f}.ref`),
    role: text(raw.role, 20, `${f}.role`),
    tag: text(raw.tag, 10, `${f}.tag`),
    text: text(raw.text, L, `${f}.text`),
    hiddenLabel: textOrNull(raw.hiddenLabel, L, `${f}.hiddenLabel`),
    assistId: textOrNull(raw.assistId, 64, `${f}.assistId`),
    inputType: textOrNull(raw.inputType, 20, `${f}.inputType`),
    href,
    disabled: bool(raw.disabled, `${f}.disabled`),
    checked: raw.checked as boolean | null,
    selected: textOrNull(raw.selected, L, `${f}.selected`),
    options: [...(raw.options as string[])],
    heading: textOrNull(raw.heading, L, `${f}.heading`),
    submit: bool(raw.submit, `${f}.submit`),
    inForm: bool(raw.inForm, `${f}.inForm`),
    confirmZone: bool(raw.confirmZone, `${f}.confirmZone`),
    pd: bool(raw.pd, `${f}.pd`),
    toggle: bool(raw.toggle, `${f}.toggle`),
    gesture: textOrNull(raw.gesture, 20, `${f}.gesture`),
    inView: bool(raw.inView, `${f}.inView`),
    box,
  };
}

function snapshotOf(
  raw: unknown,
  allowedHosts: readonly string[],
): WorkerSnapshot {
  if (!isObj(raw)) throw new ProtocolError('snapshot');
  exactKeys(raw, ['url', 'title', 'elements'], 'snapshot');
  if (
    !Array.isArray(raw.elements) ||
    raw.elements.length > WORKER_LIMITS.snapshotElements
  ) {
    throw new ProtocolError('snapshot.elements');
  }
  return {
    url: resultUrl(raw.url, allowedHosts, 'snapshot.url'),
    title: text(raw.title, WORKER_LIMITS.titleChars, 'snapshot.title'),
    elements: raw.elements.map(snapElement),
  };
}

function mapElementsOf(raw: unknown): WorkerMapElement[] {
  if (!Array.isArray(raw) || raw.length > WORKER_LIMITS.mapElements) {
    throw new ProtocolError('mapElements');
  }
  return raw.map((e, i) => {
    const f = `mapElements.${i}`;
    if (!isObj(e)) throw new ProtocolError(f);
    exactKeys(e, ['tag', 'label', 'role', 'assistId', 'selector'], f);
    const selector = e.selector === null ? null : e.selector;
    if (selector !== null && !isSafeSelector(selector)) {
      throw new ProtocolError(`${f}.selector`);
    }
    return {
      tag: text(e.tag, 10, `${f}.tag`),
      label: text(e.label, WORKER_LIMITS.textChars, `${f}.label`),
      role: textOrNull(e.role, 20, `${f}.role`),
      assistId: textOrNull(e.assistId, 64, `${f}.assistId`),
      selector: selector as string | null,
    };
  });
}

function artifactRef(v: unknown, field: string): number {
  return intIn(v, 0, WORKER_LIMITS.artifactsPerJob - 1, field);
}

/**
 * Строгий разбор результата по виду и параметрам задания: адреса — только
 * хосты замка, лимиты — те же, что у воркера. Сервер зовёт это ДО записи
 * результата; воркер — перед отправкой (самопроверка).
 */
export function parseJobResult(
  kind: BrowserJobKind,
  params: BrowserJobParams,
  raw: unknown,
): BrowserJobResult {
  if (!isObj(raw)) throw new ProtocolError('result');
  const hosts = (params as { allowedHosts: string[] }).allowedHosts;
  switch (kind) {
    case 'ui-snapshot': {
      exactKeys(
        raw,
        [
          'finalUrl',
          'snapshot',
          'mapElements',
          'screenshot',
          'viewport',
          'blockedRequests',
        ],
        'result',
      );
      if (!isObj(raw.viewport)) throw new ProtocolError('result.viewport');
      exactKeys(raw.viewport, ['width', 'height'], 'result.viewport');
      return {
        finalUrl: resultUrl(raw.finalUrl, hosts, 'result.finalUrl'),
        snapshot: snapshotOf(raw.snapshot, hosts),
        mapElements: mapElementsOf(raw.mapElements),
        screenshot:
          raw.screenshot === null
            ? null
            : artifactRef(raw.screenshot, 'result.screenshot'),
        viewport: {
          width: intIn(raw.viewport.width, 200, 4000, 'result.viewport.width'),
          height: intIn(
            raw.viewport.height,
            200,
            4000,
            'result.viewport.height',
          ),
        },
        blockedRequests: intIn(
          raw.blockedRequests,
          0,
          1e6,
          'result.blockedRequests',
        ),
      };
    }
    case 'descriptor-resolve': {
      exactKeys(raw, ['pages'], 'result');
      const p = params as DescriptorResolveParams;
      if (!Array.isArray(raw.pages) || raw.pages.length > p.pages.length) {
        throw new ProtocolError('result.pages');
      }
      const keys = new Map(p.targets.map((t) => [t.key, t.selectors.length]));
      return {
        pages: raw.pages.map((pg, i) => {
          const f = `result.pages.${i}`;
          if (!isObj(pg)) throw new ProtocolError(f);
          exactKeys(pg, ['url', 'ok', 'error', 'counts', 'snapshot'], f);
          if (pg.error !== null && !isWorkerErrorCode(pg.error)) {
            throw new ProtocolError(`${f}.error`);
          }
          if (!isObj(pg.counts)) throw new ProtocolError(`${f}.counts`);
          const counts: Record<string, number[]> = {};
          for (const [k, v] of Object.entries(pg.counts)) {
            const n = keys.get(k);
            if (
              n === undefined ||
              !Array.isArray(v) ||
              v.length !== n ||
              !v.every((c) => Number.isInteger(c) && c >= 0 && c <= 10_000)
            ) {
              throw new ProtocolError(`${f}.counts.${k}`);
            }
            counts[k] = [...(v as number[])];
          }
          return {
            url: resultUrl(pg.url, hosts, `${f}.url`),
            ok: bool(pg.ok, `${f}.ok`),
            error: pg.error as WorkerErrorCode | null,
            counts,
            snapshot:
              pg.snapshot === null ? null : snapshotOf(pg.snapshot, hosts),
          };
        }),
      };
    }
    case 'admin-crawl': {
      exactKeys(
        raw,
        ['loggedIn', 'pages', 'refusedClicks', 'skippedLinks'],
        'result',
      );
      const p = params as AdminCrawlParams;
      if (!Array.isArray(raw.pages) || raw.pages.length > p.maxPages) {
        throw new ProtocolError('result.pages');
      }
      return {
        loggedIn: bool(raw.loggedIn, 'result.loggedIn'),
        pages: raw.pages.map((pg, i) => {
          const f = `result.pages.${i}`;
          if (!isObj(pg)) throw new ProtocolError(f);
          exactKeys(pg, ['url', 'title', 'text'], f);
          return {
            url: resultUrl(pg.url, hosts, `${f}.url`),
            title: text(pg.title, WORKER_LIMITS.titleChars, `${f}.title`),
            text: text(pg.text, WORKER_LIMITS.pageTextChars, `${f}.text`),
          };
        }),
        refusedClicks: intIn(raw.refusedClicks, 0, 1e6, 'result.refusedClicks'),
        skippedLinks: intIn(raw.skippedLinks, 0, 1e6, 'result.skippedLinks'),
      };
    }
    case 'frames-capture': {
      exactKeys(raw, ['finalUrl', 'frames'], 'result');
      const p = params as FramesCaptureParams;
      if (!Array.isArray(raw.frames) || raw.frames.length > p.frames) {
        throw new ProtocolError('result.frames');
      }
      return {
        finalUrl: resultUrl(raw.finalUrl, hosts, 'result.finalUrl'),
        frames: raw.frames.map((fr, i) => {
          const f = `result.frames.${i}`;
          if (!isObj(fr)) throw new ProtocolError(f);
          exactKeys(fr, ['artifact', 'scrollY'], f);
          return {
            artifact: artifactRef(fr.artifact, `${f}.artifact`),
            scrollY: intIn(fr.scrollY, 0, 1e6, `${f}.scrollY`),
          };
        }),
      };
    }
    default:
      throw new ProtocolError('kind');
  }
}

/** Задание, как его отдаёт claim (секретов нет — см. `credentials`). */
export interface ClaimedJob {
  id: string;
  kind: BrowserJobKind;
  attempt: number;
  leaseToken: string;
  leaseUntil: string;
  wallMs: number;
  params: BrowserJobParams;
  /** Учётка нужна (admin-crawl): секреты — запросом `credentials`. */
  needsCredentials: boolean;
}

export const LEASE_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
export const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const ARTIFACT_TYPES = ['image/jpeg', 'image/png'] as const;
