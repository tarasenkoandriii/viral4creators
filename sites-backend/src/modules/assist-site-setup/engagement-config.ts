/**
 * Вовлечение виджета — T (Э3; ТЗ §3.6 п.4–5, §5-тер.12, №41 MVP-триггеры,
 * №40 вопросы квалификации, §2.8): проактивные триггеры, лимиты
 * навязчивости, сценарии (короткие ветки «вопрос → тип ответа → действие»).
 *
 * Хранится ВНУТРИ конфигурации вида (`WidgetConfig.engagement`) —
 * публикуется и откатывается вместе с видом (те же 20 версий, тот же
 * `widgetVersion`), новой таблицы нет. Черновик правит
 * `PATCH /assist/sites/:id/widget/draft` (частичный `{ engagement }`) и
 * `PUT /assist/sites/:id/scenarios` (только сценарии, §4.16). Публичная
 * часть (`publicEngagement`) уходит загрузчику в `WidgetPublicConfig`
 * (W): тексты, условия, лимиты — без модели (0 цены, §5-тер.12 п.9).
 *
 * Строгий разбор, как у widget-config.ts: неизвестное поле — ошибка,
 * тексты — данные (рисуются textContent), маски путей — PATH_MASK,
 * ключи — `^[a-z0-9_-]{1,32}$`. Лимиты — ENGAGEMENT_LIMITS.
 *
 * MVP-триггеры (Start+): `time_on_page`, `scroll_depth`, `exit_intent`
 * (только `pointer: fine`), `url_match`. Триггеры по поведению
 * (`cart_exit`, `rage_click` …) и `return_visit` (нужно согласие) — Э3-бис:
 * разбор их ОТВЕРГАЕТ (`not_allowed`), чтобы владелец не включил то, чего
 * загрузчик не исполняет.
 */
import {
  PATH_MASK,
  WIDGET_TEXT_LIMITS,
  WIDGET_UI_LANGS,
  type WidgetUiLang,
} from './widget-config';

export const TRIGGER_KINDS = [
  'time_on_page',
  'scroll_depth',
  'exit_intent',
  'url_match',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const ENGAGEMENT_KEY = /^[a-z0-9_-]{1,32}$/;

export const ENGAGEMENT_LIMITS = {
  maxTriggers: 10,
  maxScenarios: 5,
  maxSteps: 8,
  maxOptions: 6,
  triggerText: 140,
  stepQuestion: 200,
  optionLabel: 60,
  scenarioTitle: 60,
  /** §5-тер.12 п.3: не раньше 10 с на странице. */
  minDelaySeconds: 10,
  maxDelaySeconds: 600,
} as const;

/** Условие триггера (§3.6 п.4). Маски — как hosts[].pathMasks. */
export type TriggerCondition =
  | { kind: 'time_on_page'; seconds: number }
  | { kind: 'scroll_depth'; percent: number }
  | { kind: 'exit_intent' }
  | { kind: 'url_match'; pathMask: string; seconds: number };

export interface TriggerConfig {
  key: string;
  enabled: boolean;
  condition: TriggerCondition;
  /** Где действует (пусто — везде, кроме исключённых); маски путей. */
  pathMasks: string[];
  /** Текст пузыря по языкам интерфейса (без модели). */
  text: Partial<Record<WidgetUiLang, string>>;
  /** Клик по пузырю — префилл вопроса (без автоотправки) или старт сценария. */
  onAccept:
    | { kind: 'prefill'; question: Partial<Record<WidgetUiLang, string>> }
    | { kind: 'scenario'; scenarioKey: string }
    | { kind: 'open' };
}

/** Лимиты навязчивости (§5-тер.12) — жёсткие, исполняет загрузчик (W). */
export interface EngagementLimits {
  /** Сигналов за визит (вкладку): 1 по умолчанию, максимум 2. */
  perVisit: 1 | 2;
  /** Маски путей, где сигналов нет никогда (шаг оплаты — по умолчанию). */
  excludedPaths: string[];
  /** Не на первом экране на телефоне (п.3) — всегда true, поле для явности. */
  notOnFirstScreenMobile: true;
}

export type ScenarioAnswerType = 'choice' | 'text' | 'number' | 'none';

export interface ScenarioStep {
  key: string;
  question: Partial<Record<WidgetUiLang, string>>;
  answer:
    | {
        type: 'choice';
        options: Array<{
          key: string;
          label: Partial<Record<WidgetUiLang, string>>;
        }>;
      }
    | { type: 'text'; maxChars: number }
    | { type: 'number'; min: number | null; max: number | null }
    | { type: 'none' };
}

/** Действие в конце сценария — только виды §4.9 (модель тут не участвует). */
export type ScenarioFinal =
  | { kind: 'lead' }
  | { kind: 'handoff' }
  | { kind: 'link'; url: string; label: Partial<Record<WidgetUiLang, string>> }
  /** Ответы сценария уходят первым вопросом в обычный чат. */
  | { kind: 'ask' };

export interface ScenarioConfig {
  key: string;
  enabled: boolean;
  title: Partial<Record<WidgetUiLang, string>>;
  steps: ScenarioStep[];
  final: ScenarioFinal;
  /** Показывать кнопкой в приветствии чата. */
  showInGreeting: boolean;
}

export interface EngagementConfig {
  schema: 1;
  triggers: TriggerConfig[];
  limits: EngagementLimits;
  scenarios: ScenarioConfig[];
}

/** Публичная часть — то же без выключенных элементов (загрузчик/iframe). */
export type PublicEngagementConfig = EngagementConfig;

export type EngagementParse =
  | { ok: true; config: EngagementConfig }
  | { ok: false; errors: Array<{ path: string; code: string }> };

/** Умолчание: триггеров и сценариев нет; шаг оплаты исключён (§5-тер.12 п.5). */
export function defaultEngagementConfig(): EngagementConfig {
  return {
    schema: 1,
    triggers: [],
    limits: {
      perVisit: 1,
      excludedPaths: ['/checkout*', '/cart/checkout*', '/payment*'],
      notOnFirstScreenMobile: true,
    },
    scenarios: [],
  };
}

// ── Разбор ───────────────────────────────────────────────────────────

/**
 * Триггеры, которые ТЗ знает, но Э3 не исполняет (по поведению — Э3-бис (б),
 * `return_visit` — нужно согласие). Отдельный список только ради понятного
 * кода ошибки: любой иной `kind` — тоже `not_allowed`.
 */
export const DEFERRED_TRIGGER_KINDS = [
  'return_visit',
  'cart_exit',
  'rage_click',
  'idle',
  'price_hover',
  'repeat_page',
  'search_no_results',
] as const;

/** Длины, которых нет в ENGAGEMENT_LIMITS (контракт-заглушка их не задал). */
export const ENGAGEMENT_EXTRA_LIMITS = {
  /** Префилл вопроса — как обычный вопрос посетителя в подсказке. */
  prefillQuestion: 200,
  /** Ответ «текстом» в сценарии. */
  textAnswerMax: 500,
  linkUrl: 500,
  /** Модуль числа в шаге «число». */
  numberAbs: 1_000_000_000,
} as const;

type Obj = Record<string, unknown>;
type Errors = Array<{ path: string; code: string }>;

const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Управляющие символы и bidi-переворачиватели (как widget-config.ts). */
const CONTROL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/;

/** Неизвестное поле — ошибка: владелец не должен думать, что оно действует. */
function onlyKeys(e: Errors, path: string, o: Obj, allowed: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) e.push({ path: join(path, k), code: 'unknown' });
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function key(e: Errors, path: string, v: unknown): string | null {
  if (typeof v !== 'string' || !ENGAGEMENT_KEY.test(v)) {
    e.push({ path, code: 'key' });
    return null;
  }
  return v;
}

function bool(e: Errors, path: string, v: unknown): boolean {
  if (typeof v !== 'boolean') {
    e.push({ path, code: 'type' });
    return false;
  }
  return v;
}

function int(
  e: Errors,
  path: string,
  v: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    e.push({ path, code: 'type' });
    return null;
  }
  if (v < min || v > max) {
    e.push({ path, code: 'range' });
    return null;
  }
  return v;
}

/**
 * Тексты по языкам интерфейса: только uk/ru/en, без управляющих символов и
 * переводов строки, длина в кодовых точках — отказ, а не обрезка (это
 * короткие подписи: обрезанный вопрос сценария менял бы смысл).
 * `required` — хотя бы один непустой язык.
 */
function texts(
  e: Errors,
  path: string,
  v: unknown,
  max: number,
  required: boolean,
): Partial<Record<WidgetUiLang, string>> {
  const out: Partial<Record<WidgetUiLang, string>> = {};
  if (!isObj(v)) {
    e.push({ path, code: v === undefined ? 'required' : 'type' });
    return out;
  }
  const before = e.length;
  for (const lang of WIDGET_UI_LANGS) {
    const t = v[lang];
    if (t === undefined || t === null) continue;
    const p = join(path, lang);
    if (typeof t !== 'string') {
      e.push({ path: p, code: 'type' });
      continue;
    }
    if (CONTROL.test(t)) {
      e.push({ path: p, code: 'control_chars' });
      continue;
    }
    const s = t.trim();
    if (Array.from(s).length > max) {
      e.push({ path: p, code: 'too_long' });
      continue;
    }
    if (s) out[lang] = s;
  }
  // «Пусто» — только если сами тексты без ошибок (иначе две ошибки на одно).
  if (required && e.length === before && Object.keys(out).length === 0) {
    e.push({ path, code: 'required' });
  }
  onlyKeys(e, path, v, [...WIDGET_UI_LANGS]);
  return out;
}

function masks(e: Errors, path: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    e.push({ path, code: 'type' });
    return [];
  }
  if (v.length > WIDGET_TEXT_LIMITS.pathMasks) {
    e.push({ path, code: 'too_many' });
    return [];
  }
  const out: string[] = [];
  v.forEach((m, i) => {
    if (!isMask(m)) {
      e.push({ path: `${path}[${i}]`, code: 'path_mask' });
    } else if (!out.includes(m)) {
      out.push(m);
    }
  });
  return out;
}

function isMask(m: unknown): m is string {
  return (
    typeof m === 'string' &&
    m.length <= WIDGET_TEXT_LIMITS.pathMask &&
    PATH_MASK.test(m)
  );
}

/**
 * Ссылка финала сценария: только https, без логина/пароля в адресе, без
 * управляющих символов. Хост (verified-хост сайта) сверяет вызывающий —
 * `opts.verifiedOrigins` (кабинет: при сохранении и при публикации).
 */
export function safeLinkUrl(v: unknown): string | null {
  if (
    typeof v !== 'string' ||
    v.length > ENGAGEMENT_EXTRA_LIMITS.linkUrl ||
    CONTROL.test(v) ||
    /\s/.test(v)
  ) {
    return null;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function condition(
  e: Errors,
  path: string,
  v: unknown,
): TriggerCondition | null {
  if (!isObj(v)) {
    e.push({ path, code: v === undefined ? 'required' : 'type' });
    return null;
  }
  const kind = v.kind;
  const L = ENGAGEMENT_LIMITS;
  switch (kind) {
    case 'time_on_page': {
      onlyKeys(e, path, v, ['kind', 'seconds']);
      const seconds = int(
        e,
        `${path}.seconds`,
        v.seconds,
        L.minDelaySeconds,
        L.maxDelaySeconds,
      );
      return seconds === null ? null : { kind, seconds };
    }
    case 'scroll_depth': {
      onlyKeys(e, path, v, ['kind', 'percent']);
      const percent = int(e, `${path}.percent`, v.percent, 10, 100);
      return percent === null ? null : { kind, percent };
    }
    case 'exit_intent':
      onlyKeys(e, path, v, ['kind']);
      return { kind };
    case 'url_match': {
      onlyKeys(e, path, v, ['kind', 'pathMask', 'seconds']);
      const seconds = int(
        e,
        `${path}.seconds`,
        v.seconds,
        L.minDelaySeconds,
        L.maxDelaySeconds,
      );
      if (!isMask(v.pathMask))
        e.push({ path: `${path}.pathMask`, code: 'path_mask' });
      return seconds === null || !isMask(v.pathMask)
        ? null
        : { kind, pathMask: v.pathMask, seconds };
    }
    default:
      // Э3-бис и всё неизвестное: загрузчик это не исполняет — не принимаем.
      e.push({ path: `${path}.kind`, code: 'not_allowed' });
      return null;
  }
}

function onAccept(
  e: Errors,
  path: string,
  v: unknown,
): TriggerConfig['onAccept'] | null {
  if (!isObj(v)) {
    e.push({ path, code: v === undefined ? 'required' : 'type' });
    return null;
  }
  switch (v.kind) {
    case 'open':
      onlyKeys(e, path, v, ['kind']);
      return { kind: 'open' };
    case 'prefill': {
      onlyKeys(e, path, v, ['kind', 'question']);
      const n = e.length;
      const question = texts(
        e,
        `${path}.question`,
        v.question,
        ENGAGEMENT_EXTRA_LIMITS.prefillQuestion,
        true,
      );
      return e.length === n ? { kind: 'prefill', question } : null;
    }
    case 'scenario': {
      onlyKeys(e, path, v, ['kind', 'scenarioKey']);
      const k = key(e, `${path}.scenarioKey`, v.scenarioKey);
      return k ? { kind: 'scenario', scenarioKey: k } : null;
    }
    default:
      e.push({ path: `${path}.kind`, code: 'not_allowed' });
      return null;
  }
}

function trigger(e: Errors, path: string, v: unknown): TriggerConfig | null {
  if (!isObj(v)) {
    e.push({ path, code: 'type' });
    return null;
  }
  const n = e.length;
  onlyKeys(e, path, v, [
    'key',
    'enabled',
    'condition',
    'pathMasks',
    'text',
    'onAccept',
  ]);
  const k = key(e, `${path}.key`, v.key);
  const enabled = bool(e, `${path}.enabled`, v.enabled);
  const cond = condition(e, `${path}.condition`, v.condition);
  const pathMasks = masks(e, `${path}.pathMasks`, v.pathMasks);
  const text = texts(
    e,
    `${path}.text`,
    v.text,
    ENGAGEMENT_LIMITS.triggerText,
    true,
  );
  const accept = onAccept(e, `${path}.onAccept`, v.onAccept);
  if (e.length !== n || !k || !cond || !accept) return null;
  return {
    key: k,
    enabled,
    condition: cond,
    pathMasks,
    text,
    onAccept: accept,
  };
}

function limits(e: Errors, v: unknown): EngagementLimits {
  const def = defaultEngagementConfig().limits;
  if (v === undefined || v === null) return def;
  if (!isObj(v)) {
    e.push({ path: 'limits', code: 'type' });
    return def;
  }
  onlyKeys(e, 'limits', v, [
    'perVisit',
    'excludedPaths',
    'notOnFirstScreenMobile',
  ]);
  let perVisit: 1 | 2 = def.perVisit;
  if (v.perVisit !== undefined) {
    if (v.perVisit === 1 || v.perVisit === 2) perVisit = v.perVisit;
    else e.push({ path: 'limits.perVisit', code: 'range' });
  }
  // §5-тер.12 п.3: на первом экране телефона — никогда; выключить нельзя.
  if (
    v.notOnFirstScreenMobile !== undefined &&
    v.notOnFirstScreenMobile !== true
  ) {
    e.push({ path: 'limits.notOnFirstScreenMobile', code: 'not_allowed' });
  }
  const excludedPaths =
    v.excludedPaths === undefined
      ? def.excludedPaths
      : masks(e, 'limits.excludedPaths', v.excludedPaths);
  return { perVisit, excludedPaths, notOnFirstScreenMobile: true };
}

function step(e: Errors, path: string, v: unknown): ScenarioStep | null {
  if (!isObj(v)) {
    e.push({ path, code: 'type' });
    return null;
  }
  const n = e.length;
  onlyKeys(e, path, v, ['key', 'question', 'answer']);
  const k = key(e, `${path}.key`, v.key);
  const question = texts(
    e,
    `${path}.question`,
    v.question,
    ENGAGEMENT_LIMITS.stepQuestion,
    true,
  );
  const a = v.answer;
  const ap = `${path}.answer`;
  let answer: ScenarioStep['answer'] | null = null;
  if (!isObj(a)) {
    e.push({ path: ap, code: a === undefined ? 'required' : 'type' });
  } else if (a.type === 'none') {
    onlyKeys(e, ap, a, ['type']);
    answer = { type: 'none' };
  } else if (a.type === 'text') {
    onlyKeys(e, ap, a, ['type', 'maxChars']);
    const max = int(
      e,
      `${ap}.maxChars`,
      a.maxChars,
      1,
      ENGAGEMENT_EXTRA_LIMITS.textAnswerMax,
    );
    if (max !== null) answer = { type: 'text', maxChars: max };
  } else if (a.type === 'number') {
    onlyKeys(e, ap, a, ['type', 'min', 'max']);
    const abs = ENGAGEMENT_EXTRA_LIMITS.numberAbs;
    const lim = (p: string, x: unknown): number | null | undefined =>
      x === null || x === undefined
        ? null
        : (int(e, p, x, -abs, abs) ?? undefined);
    const min = lim(`${ap}.min`, a.min);
    const max = lim(`${ap}.max`, a.max);
    if (min !== undefined && max !== undefined) {
      if (min !== null && max !== null && min > max) {
        e.push({ path: ap, code: 'range' });
      } else {
        answer = { type: 'number', min, max };
      }
    }
  } else if (a.type === 'choice') {
    onlyKeys(e, ap, a, ['type', 'options']);
    const opts = a.options;
    if (!Array.isArray(opts) || opts.length === 0) {
      e.push({
        path: `${ap}.options`,
        code: Array.isArray(opts) ? 'required' : 'type',
      });
    } else if (opts.length > ENGAGEMENT_LIMITS.maxOptions) {
      e.push({ path: `${ap}.options`, code: 'too_many' });
    } else {
      const options: Array<{
        key: string;
        label: Partial<Record<WidgetUiLang, string>>;
      }> = [];
      opts.forEach((o, i) => {
        const op = `${ap}.options[${i}]`;
        if (!isObj(o)) {
          e.push({ path: op, code: 'type' });
          return;
        }
        onlyKeys(e, op, o, ['key', 'label']);
        const ok = key(e, `${op}.key`, o.key);
        const label = texts(
          e,
          `${op}.label`,
          o.label,
          ENGAGEMENT_LIMITS.optionLabel,
          true,
        );
        if (!ok) return;
        if (options.some((x) => x.key === ok)) {
          e.push({ path: `${op}.key`, code: 'duplicate' });
          return;
        }
        options.push({ key: ok, label });
      });
      answer = { type: 'choice', options };
    }
  } else {
    e.push({ path: `${ap}.type`, code: 'not_allowed' });
  }
  if (e.length !== n || !k || !answer) return null;
  return { key: k, question, answer };
}

function final(
  e: Errors,
  path: string,
  v: unknown,
  verifiedOrigins: string[] | undefined,
): ScenarioFinal | null {
  if (!isObj(v)) {
    e.push({ path, code: v === undefined ? 'required' : 'type' });
    return null;
  }
  switch (v.kind) {
    case 'lead':
    case 'handoff':
    case 'ask':
      onlyKeys(e, path, v, ['kind']);
      return { kind: v.kind };
    case 'link': {
      onlyKeys(e, path, v, ['kind', 'url', 'label']);
      const n = e.length;
      const url = safeLinkUrl(v.url);
      if (!url) {
        e.push({ path: `${path}.url`, code: 'url' });
      } else if (
        verifiedOrigins &&
        !verifiedOrigins.includes(new URL(url).origin)
      ) {
        // Ссылка ведёт только на подтверждённый хост сайта (§4.9).
        e.push({ path: `${path}.url`, code: 'host_not_verified' });
      }
      const label = texts(
        e,
        `${path}.label`,
        v.label,
        ENGAGEMENT_LIMITS.optionLabel,
        true,
      );
      return e.length === n && url ? { kind: 'link', url, label } : null;
    }
    default:
      // Модели и иных действий сценарий не запускает — только §4.9.
      e.push({ path: `${path}.kind`, code: 'not_allowed' });
      return null;
  }
}

function scenario(
  e: Errors,
  path: string,
  v: unknown,
  verifiedOrigins: string[] | undefined,
): ScenarioConfig | null {
  if (!isObj(v)) {
    e.push({ path, code: 'type' });
    return null;
  }
  const n = e.length;
  onlyKeys(e, path, v, [
    'key',
    'enabled',
    'title',
    'steps',
    'final',
    'showInGreeting',
  ]);
  const k = key(e, `${path}.key`, v.key);
  const enabled = bool(e, `${path}.enabled`, v.enabled);
  const title = texts(
    e,
    `${path}.title`,
    v.title,
    ENGAGEMENT_LIMITS.scenarioTitle,
    true,
  );
  const steps: ScenarioStep[] = [];
  if (!Array.isArray(v.steps)) {
    e.push({
      path: `${path}.steps`,
      code: v.steps === undefined ? 'required' : 'type',
    });
  } else if (v.steps.length > ENGAGEMENT_LIMITS.maxSteps) {
    e.push({ path: `${path}.steps`, code: 'too_many' });
  } else {
    v.steps.forEach((s, i) => {
      const st = step(e, `${path}.steps[${i}]`, s);
      if (!st) return;
      if (steps.some((x) => x.key === st.key)) {
        e.push({ path: `${path}.steps[${i}].key`, code: 'duplicate' });
        return;
      }
      steps.push(st);
    });
  }
  const fin = final(e, `${path}.final`, v.final, verifiedOrigins);
  const showInGreeting =
    v.showInGreeting === undefined
      ? false
      : bool(e, `${path}.showInGreeting`, v.showInGreeting);
  if (e.length !== n || !k || !fin) return null;
  return { key: k, enabled, title, steps, final: fin, showInGreeting };
}

/** Сценарии отдельно — для `PUT /assist/sites/:id/scenarios`. */
export function parseScenarios(
  input: unknown,
  opts: { verifiedOrigins?: string[]; path?: string } = {},
): { ok: true; scenarios: ScenarioConfig[] } | { ok: false; errors: Errors } {
  const e: Errors = [];
  const base = opts.path ?? 'scenarios';
  const out: ScenarioConfig[] = [];
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ path: base, code: 'type' }] };
  }
  if (input.length > ENGAGEMENT_LIMITS.maxScenarios) {
    return { ok: false, errors: [{ path: base, code: 'too_many' }] };
  }
  input.forEach((s, i) => {
    const sc = scenario(e, `${base}[${i}]`, s, opts.verifiedOrigins);
    if (!sc) return;
    if (out.some((x) => x.key === sc.key)) {
      e.push({ path: `${base}[${i}].key`, code: 'duplicate' });
      return;
    }
    out.push(sc);
  });
  return e.length ? { ok: false, errors: e } : { ok: true, scenarios: out };
}

/**
 * Строгий разбор (T). Ссылка `link` — только https; с `opts.verifiedOrigins`
 * — ещё и на verified-хост сайта (кабинет передаёт origins при сохранении и
 * публикации; без параметра — только форма, как в чистых тестах/зеркалах).
 */
export function parseEngagementConfig(
  input: unknown,
  opts: { verifiedOrigins?: string[] } = {},
): EngagementParse {
  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '', code: 'type' }] };
  }
  const e: Errors = [];
  onlyKeys(e, '', input, ['schema', 'triggers', 'limits', 'scenarios']);
  if (input.schema !== undefined && input.schema !== 1) {
    e.push({ path: 'schema', code: 'schema' });
  }
  const sc = parseScenarios(input.scenarios ?? [], {
    verifiedOrigins: opts.verifiedOrigins,
  });
  if (!sc.ok) e.push(...sc.errors);
  const scenarios = sc.ok ? sc.scenarios : [];

  const triggers: TriggerConfig[] = [];
  const rawT = input.triggers ?? [];
  if (!Array.isArray(rawT)) {
    e.push({ path: 'triggers', code: 'type' });
  } else if (rawT.length > ENGAGEMENT_LIMITS.maxTriggers) {
    e.push({ path: 'triggers', code: 'too_many' });
  } else {
    rawT.forEach((t, i) => {
      const p = `triggers[${i}]`;
      const tr = trigger(e, p, t);
      if (!tr) return;
      if (triggers.some((x) => x.key === tr.key)) {
        e.push({ path: `${p}.key`, code: 'duplicate' });
        return;
      }
      if (
        tr.onAccept.kind === 'scenario' &&
        sc.ok &&
        !scenarios.some(
          (s) =>
            tr.onAccept.kind === 'scenario' &&
            s.key === tr.onAccept.scenarioKey,
        )
      ) {
        e.push({ path: `${p}.onAccept.scenarioKey`, code: 'scenario_unknown' });
        return;
      }
      triggers.push(tr);
    });
  }
  const lim = limits(e, input.limits);
  if (e.length) return { ok: false, errors: e };
  return {
    ok: true,
    config: { schema: 1, triggers, limits: lim, scenarios },
  };
}

/**
 * Что уходит загрузчику: только enabled-элементы, тексты как есть (данные).
 * Триггер, ведущий в выключенный сценарий, не уходит (он открыл бы пустоту).
 * Нет поля (вид Э2) — умолчание: триггеров и сценариев нет, лимиты есть.
 * Битое значение из базы (старый код) — тоже умолчание, а не исключение.
 */
export function publicEngagement(
  config: EngagementConfig | undefined,
): PublicEngagementConfig {
  const parsed = config === undefined ? null : parseEngagementConfig(config);
  const c = parsed?.ok ? parsed.config : defaultEngagementConfig();
  const scenarios = c.scenarios.filter((s) => s.enabled);
  const triggers = c.triggers.filter(
    (t) =>
      t.enabled &&
      (t.onAccept.kind !== 'scenario' ||
        scenarios.some(
          (s) =>
            t.onAccept.kind === 'scenario' && s.key === t.onAccept.scenarioKey,
        )),
  );
  return {
    schema: 1,
    triggers,
    limits: {
      perVisit: c.limits.perVisit,
      excludedPaths: [...c.limits.excludedPaths],
      notOnFirstScreenMobile: true,
    },
    scenarios,
  };
}
