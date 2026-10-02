/**
 * События лендинга (ТЗ §10.1–§10.2) → `POST <API>/public/landing/event`
 * (`sites-backend` W2, форма — `LandingEventBatch` в
 * `sites-backend/src/modules/assist-widget/landing/landing-types.ts`;
 * копия здесь, совпадение типов и правил держит `scripts/api-contract.test.ts`).
 *
 * Без cookie и без идентификатора посетителя: сервер считает суточный
 * ipHash сам. Без ПДн: имя события — из фиксированного списка, свойства —
 * только перечисленные ключи с короткими значениями из перечней (никакого
 * текста, который ввёл человек), путь — без query и якоря (в query бывают
 * utm, токены, e-mail).
 *
 * Модуль чистый (без DOM): сборка и отправка батча — `lib/track.ts`.
 */
import { isLocale, type Locale } from './i18n';

/**
 * Имена событий фиксируются в коде (§10.2), как `AssistantEvent` у
 * консультанта. Из списка §10.2 здесь нет: `widget_question` — загрузчик
 * наружу не отдаёт ни текста, ни факта вопроса (§3-бис.2; вопросы считает
 * сам продукт), `web_login` — В-13, `pricing_calc` — калькулятора ещё нет.
 * `sandbox_*` (Л4) — только перечни: ни адреса сайта, ни текста вопроса.
 */
export const LANDING_EVENT_NAMES = [
  'page_view',
  'cta_click',
  'widget_open',
  'widget_corner_change',
  'configurator_change',
  'configurator_save',
  'tma_click',
  'pilot_submit',
  'sandbox_start',
  'sandbox_ready',
  'sandbox_question',
  'sandbox_limit_hit',
] as const;
export type LandingEventName = (typeof LANDING_EVENT_NAMES)[number];

/**
 * Разрешённые свойства каждого события: ключ → перечень значений (или
 * `number`). Всё остальное отбрасывается до отправки — второй замок
 * после сервера (`cleanLandingEvent` отбрасывает событие целиком).
 */
const PLACES = ['hero', 'header', 'recording', 'playground', 'branding', 'pilot', 'pricing', 'faq', 'final', 'configurator', 'try', 'integrations', 'docs', 'bot', 'install'] as const;
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
export const CONFIGURATOR_PARAMS = [
  'color',
  'button_text',
  'avatar',
  'name',
  'font',
  'preset',
  'theme',
  'position',
  'offset',
  'mobile',
  'launcher',
  'greeting',
  'suggestions',
  'logo',
  'device',
  'surface',
  'backdrop',
  'snippet',
] as const;
const SAVE_RESULTS = ['ok', 'rate_limited', 'invalid', 'denied', 'error'] as const;
const PILOT_RESULTS = ['sent', 'invalid', 'limited', 'unavailable', 'error'] as const;
const PAYLOAD_KINDS = ['wd', 'lp', 'pl', 'sb'] as const;
/** Исход запуска песочницы — по проблеме (`lib/sandbox.ts` `SandboxProblem`), без подробностей. */
export const SANDBOX_START_RESULTS = ['ok', 'unavailable', 'limit', 'rejected', 'opted_out', 'blocked', 'error'] as const;
export const SANDBOX_LIMITS_HIT = ['ip', 'domain', 'questions', 'budget'] as const;

type PropSpec = Record<string, readonly string[] | 'number'>;
export const EVENT_PROPS: Record<LandingEventName, PropSpec> = {
  page_view: {},
  cta_click: { place: PLACES },
  widget_open: { place: [...PLACES, 'widget'] },
  widget_corner_change: { corner: CORNERS, place: PLACES },
  configurator_change: { param: CONFIGURATOR_PARAMS, place: PLACES },
  configurator_save: { result: SAVE_RESULTS },
  tma_click: { payload: PAYLOAD_KINDS, place: PLACES },
  pilot_submit: { result: PILOT_RESULTS },
  sandbox_start: { result: SANDBOX_START_RESULTS },
  sandbox_ready: {},
  sandbox_question: { source: ['suggested', 'typed'] },
  sandbox_limit_hit: { kind: SANDBOX_LIMITS_HIT },
};

/** Пределы сервера (`landing.service.ts`, `LANDING_DEFAULTS`) — сверяет api-contract.test. */
export const EVENT_LIMITS = {
  nameRe: /^[a-z0-9_.-]{1,64}$/,
  propKeyRe: /^[A-Za-z0-9_.-]{1,40}$/,
  maxProps: 20,
  maxPropChars: 200,
  maxPathChars: 200,
  eventsPerBatch: 20,
  bodyMaxBytes: 4 * 1024,
} as const;

export interface LandingEvent {
  name: LandingEventName;
  props?: Record<string, string | number | boolean>;
  locale?: Locale;
  path?: string;
}

export interface LandingEventBatch {
  events: LandingEvent[];
}

export function isEventName(v: unknown): v is LandingEventName {
  return typeof v === 'string' && (LANDING_EVENT_NAMES as readonly string[]).includes(v);
}

/** Путь страницы без query/якоря; не похожий на наш путь — null. */
export function cleanPath(raw: string): string | null {
  const path = raw.split(/[?#]/, 1)[0];
  if (!path.startsWith('/') || path.length > EVENT_LIMITS.maxPathChars) return null;
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) return null;
  return path;
}

/** Событие → безопасная форма или null (неизвестное имя/свойство — отброс). */
export function makeEvent(
  name: string,
  props: Record<string, unknown> = {},
  ctx: { locale?: string | null; path?: string | null } = {},
): LandingEvent | null {
  if (!isEventName(name)) return null;
  const spec = EVENT_PROPS[name];
  const out: LandingEvent = { name };
  const clean: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(props)) {
    const allowed = spec[key];
    if (!allowed) return null;
    if (allowed === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      clean[key] = value;
    } else {
      if (typeof value !== 'string' || !allowed.includes(value)) return null;
      clean[key] = value;
    }
  }
  if (Object.keys(clean).length) out.props = clean;
  if (ctx.locale && isLocale(ctx.locale)) out.locale = ctx.locale;
  if (ctx.path) {
    const p = cleanPath(ctx.path);
    if (p) out.path = p;
  }
  return out;
}

/**
 * Очередь → батчи ≤ 20 событий и ≤ 4 КБ тела (пределы сервера). Событие,
 * которое одно больше предела, отбрасывается (не может быть при наших
 * перечнях, но очередь не должна застрять).
 */
export function packBatches(queue: readonly LandingEvent[]): string[] {
  const out: string[] = [];
  let current: LandingEvent[] = [];
  const body = (events: LandingEvent[]) => JSON.stringify({ events } satisfies LandingEventBatch);
  for (const e of queue) {
    const next = [...current, e];
    if (next.length > EVENT_LIMITS.eventsPerBatch || new TextEncoder().encode(body(next)).length > EVENT_LIMITS.bodyMaxBytes) {
      if (current.length) out.push(body(current));
      current = new TextEncoder().encode(body([e])).length > EVENT_LIMITS.bodyMaxBytes ? [] : [e];
    } else {
      current = next;
    }
  }
  if (current.length) out.push(body(current));
  return out;
}
