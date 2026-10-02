/**
 * `@v4c/assist-widget` — T (Э3; ТЗ §3-бис.2 «React/Vue/Next.js»): функция
 * `loadAssist(opts)` вставляет ТОТ ЖЕ тег загрузчика с CDN (не вшивает его
 * — обновления виджета без пересборки сайта), очередь `V4CAssist.q` до
 * загрузки, типизированные вызовы JS API (§3-бис.2 + цели §5-тер.1).
 * Без зависимостей; SSR-безопасно (на сервере — no-op). Повторный вызов —
 * тот же экземпляр (один тег на страницу).
 *
 * Тег собирается через `setAttribute` (не строкой HTML): ключ и маски из
 * чужого кода не могут дописать разметку. Атрибуты — те же, что читает
 * загрузчик (`widget/src/loader/attrs.ts`); он же повторно проверяет их.
 */
import {
  WIDGET_GLOBAL,
  WIDGET_LOADER_PATH,
  WIDGET_ORIGIN_DEFAULT,
} from "./brand";

export type AssistPosition =
  "bottom-right" | "bottom-left" | "top-right" | "top-left";

export interface LoadAssistOptions {
  /** `pk_live_…` / `pk_test_…` (публичный ключ сайта). */
  siteKey: string;
  /** Origin виджета; по умолчанию — из кода вставки TMA (WIDGET_ORIGIN_DEFAULT до В-1). */
  origin?: string;
  position?: AssistPosition;
  offsetX?: number;
  offsetY?: number;
  lang?: "auto" | "uk" | "ru" | "en";
  mobile?: "fullscreen" | "sheet" | "bubble";
  launcher?: "default" | "none";
  /** CSS-селектор контейнера inline. */
  container?: string;
  zIndex?: number;
  hideOn?: string[];
  /** CSP nonce страницы для тега script. */
  nonce?: string;
}

export interface AssistGoalParams {
  value?: number;
  currency?: string;
  orderId?: string;
}

/** Типизированный JS API (те же имена, что `window.V4CAssist(…)`). */
export interface AssistApi {
  open(): void;
  close(): void;
  toggle(): void;
  ask(question: string): void;
  identify(p: {
    name?: string;
    email?: string;
    externalId?: string;
    userHash?: string;
  }): void;
  context(data: Record<string, string | number>): void;
  position(p: AssistPosition): void;
  hide(): void;
  show(): void;
  route(): void;
  goal(key: string, params?: AssistGoalParams): void;
  on(
    event: "open" | "close" | "lead" | "handoff" | "goal",
    cb: (e: { type: string; at: number }) => void,
  ): void;
  destroy(): void;
}

/** Публичный ключ — только безопасные символы (формат проверит загрузчик). */
const SITE_KEY = /^[A-Za-z0-9_]{8,64}$/;
const POSITIONS: readonly AssistPosition[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
];
const LANGS = ["uk", "ru", "en"] as const;
const MOBILE = ["fullscreen", "sheet", "bubble"] as const;
const PATH_MASK = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

type Queued = IArguments | unknown[];
type GlobalFn = ((...args: unknown[]) => void) & { q?: Queued[]; l?: 1 };

/**
 * Origin виджета: https (или http://localhost стенда), без пути и логина.
 * Иное — ошибка разработчика сайта, а не тихое умолчание.
 */
export function widgetOriginOf(raw: string | undefined): string {
  const v = raw ?? WIDGET_ORIGIN_DEFAULT;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`loadAssist: origin «${v}» — не адрес`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.username || u.password) {
    throw new Error("loadAssist: origin без логина и пароля");
  }
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error("loadAssist: origin виджета — только https");
  }
  return u.origin;
}

/** Атрибуты тега загрузчика — чистая функция (тестируется без DOM). */
export function loaderAttributes(
  opts: LoadAssistOptions,
): Array<[string, string]> {
  if (typeof opts?.siteKey !== "string" || !SITE_KEY.test(opts.siteKey)) {
    throw new Error("loadAssist: siteKey — публичный ключ из TMA (pk_…)");
  }
  const origin = widgetOriginOf(opts.origin);
  const out: Array<[string, string]> = [
    ["src", `${origin}${WIDGET_LOADER_PATH}`],
    ["data-site", opts.siteKey],
  ];
  const int = (v: unknown, max: number): string | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max
      ? String(v)
      : null;
  const add = (name: string, v: string | null | undefined) => {
    if (v) out.push([name, v]);
  };
  add(
    "data-position",
    POSITIONS.includes(opts.position as AssistPosition) ? opts.position : null,
  );
  add("data-offset-x", int(opts.offsetX, 200));
  add("data-offset-y", int(opts.offsetY, 200));
  add(
    "data-lang",
    (LANGS as readonly string[]).includes(opts.lang ?? "") ? opts.lang : null,
  );
  add(
    "data-mobile",
    (MOBILE as readonly string[]).includes(opts.mobile ?? "")
      ? opts.mobile
      : null,
  );
  add(
    "data-launcher",
    opts.launcher === "none" || opts.launcher === "default"
      ? opts.launcher
      : null,
  );
  add(
    "data-container",
    typeof opts.container === "string" && opts.container.length <= 200
      ? opts.container
      : null,
  );
  add("data-z-index", int(opts.zIndex, 2147483647));
  const masks = (opts.hideOn ?? [])
    .filter(
      (m): m is string =>
        typeof m === "string" && m.length <= 200 && PATH_MASK.test(m),
    )
    .filter((m) => !m.includes(","))
    .slice(0, 20);
  add("data-hide-on", masks.length ? masks.join(",") : null);
  return out;
}

const noop = () => undefined;

/** API без страницы (SSR, Node): все вызовы — пустые. */
function serverApi(): AssistApi {
  return {
    open: noop,
    close: noop,
    toggle: noop,
    ask: noop,
    identify: noop,
    context: noop,
    position: noop,
    hide: noop,
    show: noop,
    route: noop,
    goal: noop,
    on: noop,
    destroy: noop,
  };
}

let current: { api: AssistApi; script: HTMLScriptElement } | null = null;

export function loadAssist(opts: LoadAssistOptions): AssistApi {
  const attrs = loaderAttributes(opts);
  if (typeof window === "undefined" || typeof document === "undefined") {
    return serverApi();
  }
  if (current) return current.api;
  const w = window as unknown as Record<string, GlobalFn | undefined>;
  // Очередь до загрузки — ровно то, что загрузчик забирает из `.q`.
  if (!w[WIDGET_GLOBAL]) {
    const stub: GlobalFn = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    };
    w[WIDGET_GLOBAL] = stub;
  }
  const call = (...args: unknown[]) => {
    const g = w[WIDGET_GLOBAL];
    if (typeof g === "function") g(...args);
  };
  const script = document.createElement("script");
  script.async = true;
  if (opts.nonce) script.nonce = opts.nonce;
  for (const [k, v] of attrs) script.setAttribute(k, v);
  (document.head || document.body).appendChild(script);

  const api: AssistApi = {
    open: () => call("open"),
    close: () => call("close"),
    toggle: () => call("toggle"),
    ask: (q) => call("ask", q),
    identify: (p) => call("identify", p),
    context: (d) => call("context", d),
    position: (p) => call("position", p),
    hide: () => call("hide"),
    show: () => call("show"),
    route: () => call("route"),
    goal: (key, params) =>
      params === undefined ? call("goal", key) : call("goal", key, params),
    on: (event, cb) => call("on", event, cb),
    destroy: () => {
      call("destroy");
      script.parentNode?.removeChild(script);
      // Загрузчик снимает глобал сам; заглушку очереди убираем мы.
      if (w[WIDGET_GLOBAL] && !w[WIDGET_GLOBAL]!.l) delete w[WIDGET_GLOBAL];
      if (current?.api === api) current = null;
    },
  };
  current = { api, script };
  return api;
}
