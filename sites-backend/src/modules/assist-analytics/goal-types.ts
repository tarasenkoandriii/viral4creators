/**
 * Цели и детекторы — A (ТЗ §5-тер.1, Р-40). ЧИСТЫЙ модуль (без Nest,
 * Prisma, env): его читают кабинет (A), публичный приём целей (A, public/),
 * публичный конфиг загрузчика (W) и TMA (T повторяет в
 * `assist/src/lib/goals-types.ts`). Загрузчик (W) повторяет проверку
 * дескриптора и orderId у себя (`widget/src/shared/goals.ts`).
 */
import { maskSensitiveEcho } from '../../shared/assist-chat-core/post-filter';

export const GOAL_TEMPLATES = [
  'lead',
  'purchase',
  'call',
  'booking',
  'subscribe',
  'messenger',
  'custom',
] as const;
export type GoalTemplate = (typeof GOAL_TEMPLATES)[number];

export const GOAL_KEY = /^[a-z0-9_-]{1,40}$/;
/** §5-тер.1: `^[A-Za-z0-9._:-]{1,64}$` и не похож на контакт (maskSensitiveEcho). */
export const ORDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const GOAL_LIMITS = {
  perSite: 30,
  detectorsPerGoal: 5,
  nameChars: 60,
} as const;

/**
 * Дескриптор элемента (WYSIWYG-выбор / разметка): `data-assist-goal` /
 * `data-assist-id`, иначе роль + видимый текст + маска пути (как
 * дескрипторы голосовых команд §4-тер.5). НЕ CSS-селектор. Поле ввода
 * выбрать нельзя (§5-тер.8): `tag` input|textarea|select — отказ.
 */
export interface ElementDescriptor {
  assistGoal: string | null;
  assistId: string | null;
  /** button | link | form | … (ARIA-роль или тег). */
  role: string | null;
  /** Видимый текст ≤ 80 символов (данные, сравнение без регистра). */
  text: string | null;
  tag: string | null;
}

export type GoalDetector =
  | { kind: 'url'; config: { pathMask: string; fromPathMask: string | null } }
  | {
      kind: 'click';
      config: { descriptor: ElementDescriptor; pathMask: string | null };
    }
  | { kind: 'click'; config: { auto: 'tel' | 'messenger' } }
  | {
      kind: 'form_submit';
      config: { descriptor: ElementDescriptor; pathMask: string | null };
    }
  | { kind: 'js'; config: Record<string, never> }
  | { kind: 'builtin'; config: { event: 'lead' } }
  | { kind: 's2s'; config: Record<string, never> }
  | { kind: 'crm'; config: { provider: 'woocommerce' } };

export type DetectorKind = GoalDetector['kind'];

/** Уровень доверия события (§5-тер.1 «Дедуп и доверие»). */
export type GoalTrust = 'verified' | 'builtin' | 'page';
export type GoalAttribution = 'direct' | 'assisted' | 'unassisted' | 'unknown';
export type GoalEventSource = 'loader' | 'iframe' | 's2s' | 'crm' | 'builtin';

export interface GoalInput {
  key: string;
  template: GoalTemplate;
  name: string;
  detectors: GoalDetector[];
  valueMode: 'none' | 'fixed' | 'event';
  fixedValue: number | null;
  currency: string | null;
}

export type GoalParse =
  | { ok: true; goal: GoalInput }
  | { ok: false; errors: Array<{ path: string; code: string }> };

type FieldErrors = Array<{ path: string; code: string }>;

const GOAL_INPUT_KEYS = [
  'key',
  'template',
  'name',
  'detectors',
  'valueMode',
  'fixedValue',
  'currency',
] as const;
const DESCRIPTOR_KEYS = ['assistGoal', 'assistId', 'role', 'text', 'tag'];
/** Поле ввода выбрать нельзя (§5-тер.8: значения не собираются никогда). */
const INPUT_TAGS = new Set(['input', 'textarea', 'select', 'option']);
/** Маска пути: `/`, буквы/цифры, `*` — подстановка (как маски хостов вида). */
const PATH_MASK = /^\/[A-Za-z0-9/_.*~%:@!$&'()+,;=-]{0,199}$/;
const ATTR_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
export const CURRENCY = /^[A-Z]{3}$/;
/** Потолок суммы одного события (≈ 1 млрд — защита от мусора, не бизнес-правило). */
export const GOAL_VALUE_MAX = 1_000_000_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function extraKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: FieldErrors,
): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      errors.push({ path: path ? `${path}.${k}` : k, code: 'unknown' });
    }
  }
}

/** Сумма: число ≥ 0, ≤ GOAL_VALUE_MAX, не больше двух знаков после запятой. */
export function validGoalValue(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= GOAL_VALUE_MAX &&
    Math.abs(Math.round(v * 100) - v * 100) < 1e-6
  );
}

function parsePathMask(
  v: unknown,
  path: string,
  errors: FieldErrors,
  nullable: boolean,
): string | null {
  if (v === null || v === undefined) {
    if (!nullable) errors.push({ path, code: 'required' });
    return null;
  }
  if (typeof v !== 'string' || !PATH_MASK.test(v)) {
    errors.push({ path, code: 'path_mask' });
    return null;
  }
  return v;
}

/** Дескриптор элемента: не CSS-селектор; поле ввода — отказ. */
export function parseDescriptor(
  v: unknown,
  path: string,
  errors: FieldErrors,
): ElementDescriptor | null {
  if (!isObj(v)) {
    errors.push({ path, code: 'type' });
    return null;
  }
  const before = errors.length;
  extraKeys(v, DESCRIPTOR_KEYS, path, errors);
  const str = (k: string, re: RegExp | null, max: number): string | null => {
    const x = v[k];
    if (x === null || x === undefined) return null;
    if (typeof x !== 'string' || CONTROL.test(x)) {
      errors.push({ path: `${path}.${k}`, code: 'type' });
      return null;
    }
    let t = x.normalize('NFKC').replace(/\s+/g, ' ').trim();
    // Тег из DOM приходит заглавными (`BUTTON`) — сравниваем в нижнем.
    if (k === 'tag') t = t.toLowerCase();
    if (!t) return null;
    if (t.length > max || (re && !re.test(t))) {
      errors.push({ path: `${path}.${k}`, code: 'format' });
      return null;
    }
    return t;
  };
  const d: ElementDescriptor = {
    assistGoal: str('assistGoal', ATTR_VALUE, 64),
    assistId: str('assistId', ATTR_VALUE, 64),
    role: str('role', ROLE, 32),
    text: str('text', null, 80),
    tag: str('tag', TAG, 32),
  };
  if (d.tag && INPUT_TAGS.has(d.tag)) {
    errors.push({ path: `${path}.tag`, code: 'input_not_allowed' });
  }
  if (d.role && ['textbox', 'searchbox', 'combobox'].includes(d.role)) {
    errors.push({ path: `${path}.role`, code: 'input_not_allowed' });
  }
  if (!d.assistGoal && !d.assistId && !d.text) {
    errors.push({ path, code: 'descriptor_empty' });
  }
  return errors.length === before ? d : null;
}

function parseDetector(
  v: unknown,
  path: string,
  template: GoalTemplate | null,
  errors: FieldErrors,
): GoalDetector | null {
  if (!isObj(v)) {
    errors.push({ path, code: 'type' });
    return null;
  }
  extraKeys(v, ['kind', 'config'], path, errors);
  const c = v.config === undefined ? {} : v.config;
  if (!isObj(c)) {
    errors.push({ path: `${path}.config`, code: 'type' });
    return null;
  }
  const cp = `${path}.config`;
  const before = errors.length;
  switch (v.kind) {
    case 'url': {
      extraKeys(c, ['pathMask', 'fromPathMask'], cp, errors);
      const pathMask = parsePathMask(
        c.pathMask,
        `${cp}.pathMask`,
        errors,
        false,
      );
      const fromPathMask = parsePathMask(
        c.fromPathMask,
        `${cp}.fromPathMask`,
        errors,
        true,
      );
      return errors.length === before && pathMask
        ? { kind: 'url', config: { pathMask, fromPathMask } }
        : null;
    }
    case 'click':
    case 'form_submit': {
      if (v.kind === 'click' && 'auto' in c) {
        extraKeys(c, ['auto'], cp, errors);
        if (c.auto !== 'tel' && c.auto !== 'messenger') {
          errors.push({ path: `${cp}.auto`, code: 'enum' });
          return null;
        }
        return errors.length === before
          ? { kind: 'click', config: { auto: c.auto } }
          : null;
      }
      extraKeys(c, ['descriptor', 'pathMask'], cp, errors);
      const descriptor = parseDescriptor(
        c.descriptor,
        `${cp}.descriptor`,
        errors,
      );
      const pathMask = parsePathMask(
        c.pathMask,
        `${cp}.pathMask`,
        errors,
        true,
      );
      if (errors.length !== before || !descriptor) return null;
      return v.kind === 'click'
        ? { kind: 'click', config: { descriptor, pathMask } }
        : { kind: 'form_submit', config: { descriptor, pathMask } };
    }
    case 'js':
    case 's2s':
      extraKeys(c, [], cp, errors);
      return errors.length === before ? { kind: v.kind, config: {} } : null;
    case 'builtin':
      extraKeys(c, ['event'], cp, errors);
      if (c.event !== 'lead') {
        errors.push({ path: `${cp}.event`, code: 'enum' });
        return null;
      }
      // Встроенная заявка Помощника — только у шаблона «Заявка» (§5-тер.1).
      if (template !== 'lead') {
        errors.push({ path, code: 'builtin_template' });
        return null;
      }
      return errors.length === before
        ? { kind: 'builtin', config: { event: 'lead' } }
        : null;
    case 'crm':
      extraKeys(c, ['provider'], cp, errors);
      if (c.provider !== 'woocommerce') {
        errors.push({ path: `${cp}.provider`, code: 'enum' });
        return null;
      }
      return errors.length === before
        ? { kind: 'crm', config: { provider: 'woocommerce' } }
        : null;
    default:
      errors.push({ path: `${path}.kind`, code: 'enum' });
      return null;
  }
}

/** Строгий разбор цели из кабинета (A). */
export function parseGoalInput(input: unknown): GoalParse {
  const errors: FieldErrors = [];
  if (!isObj(input)) return { ok: false, errors: [{ path: '', code: 'type' }] };
  extraKeys(input, GOAL_INPUT_KEYS, '', errors);
  const key =
    typeof input.key === 'string' && GOAL_KEY.test(input.key)
      ? input.key
      : null;
  if (!key) errors.push({ path: 'key', code: 'format' });
  const template = (GOAL_TEMPLATES as readonly unknown[]).includes(
    input.template,
  )
    ? (input.template as GoalTemplate)
    : null;
  if (!template) errors.push({ path: 'template', code: 'enum' });
  let name: string | null = null;
  if (typeof input.name !== 'string' || CONTROL.test(input.name)) {
    errors.push({ path: 'name', code: 'type' });
  } else {
    name = input.name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!name) errors.push({ path: 'name', code: 'required' });
    else if (name.length > GOAL_LIMITS.nameChars) {
      errors.push({ path: 'name', code: 'too_long' });
    }
  }
  const detectors: GoalDetector[] = [];
  if (!Array.isArray(input.detectors)) {
    errors.push({ path: 'detectors', code: 'type' });
  } else if (
    input.detectors.length < 1 ||
    input.detectors.length > GOAL_LIMITS.detectorsPerGoal
  ) {
    errors.push({ path: 'detectors', code: 'count' });
  } else {
    input.detectors.forEach((d, i) => {
      const det = parseDetector(d, `detectors.${i}`, template, errors);
      if (det) detectors.push(det);
    });
  }
  const valueMode =
    input.valueMode === undefined
      ? 'none'
      : input.valueMode === 'none' ||
          input.valueMode === 'fixed' ||
          input.valueMode === 'event'
        ? input.valueMode
        : null;
  if (!valueMode) errors.push({ path: 'valueMode', code: 'enum' });
  let fixedValue: number | null = null;
  if (input.fixedValue !== undefined && input.fixedValue !== null) {
    if (!validGoalValue(input.fixedValue)) {
      errors.push({ path: 'fixedValue', code: 'format' });
    } else fixedValue = input.fixedValue;
  }
  if (valueMode === 'fixed' && fixedValue === null) {
    errors.push({ path: 'fixedValue', code: 'required' });
  }
  if (valueMode !== 'fixed') fixedValue = null;
  let currency: string | null = null;
  if (input.currency !== undefined && input.currency !== null) {
    if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) {
      errors.push({ path: 'currency', code: 'format' });
    } else currency = input.currency;
  }
  if (errors.length || !key || !template || !name || !valueMode) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    goal: { key, template, name, detectors, valueMode, fixedValue, currency },
  };
}

/** Цель-умолчание сайта при первом входе в «Цели»: «Заявка» (встроенная) + tel/мессенджеры. */
export function defaultGoals(): GoalInput[] {
  const base = { valueMode: 'none' as const, fixedValue: null, currency: null };
  return [
    {
      key: 'lead',
      template: 'lead',
      name: 'Заявка',
      detectors: [{ kind: 'builtin', config: { event: 'lead' } }],
      ...base,
    },
    {
      key: 'call',
      template: 'call',
      name: 'Звонок',
      detectors: [{ kind: 'click', config: { auto: 'tel' } }],
      ...base,
    },
    {
      key: 'messenger',
      template: 'messenger',
      name: 'Переход в мессенджер',
      detectors: [{ kind: 'click', config: { auto: 'messenger' } }],
      ...base,
    },
  ];
}

/** orderId: формат и «не похож на e-mail/телефон» (иначе 422, §5-тер.16 п.1). */
export function validOrderId(orderId: string): boolean {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return false;
  // maskSensitiveEcho что-то заменил — значит, похоже на контакт (§5-тер.1):
  // иначе в orderId начнут слать телефоны и почты.
  return maskSensitiveEcho(orderId) === orderId;
}

/** Виды детекторов, которые исполняет загрузчик (остальные — сервер). */
export const LOADER_DETECTOR_KINDS = [
  'url',
  'click',
  'form_submit',
  'js',
] as const;

/** Детекторы цели, которые нужны загрузчику (для PublicGoal). */
export function loaderDetectors(
  detectors: GoalDetector[],
): PublicGoal['detectors'] {
  return detectors.filter((d): d is PublicGoal['detectors'][number] =>
    (LOADER_DETECTOR_KINDS as readonly string[]).includes(d.kind),
  );
}

/** Детекторы из базы (JSON) — тем же строгим разбором; битое — пропуск. */
export function storedDetectors(
  raw: unknown,
  template: string,
): GoalDetector[] {
  if (!Array.isArray(raw)) return [];
  const t = (GOAL_TEMPLATES as readonly string[]).includes(template)
    ? (template as GoalTemplate)
    : null;
  const out: GoalDetector[] = [];
  raw.forEach((d, i) => {
    const det = parseDetector(d, `${i}`, t, []);
    if (det) out.push(det);
  });
  return out;
}

/** Маска пути (`*` — любая подстрока) → проверка пути без query. */
export function pathMatchesMask(path: string, mask: string): boolean {
  const re = new RegExp(
    `^${mask
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(path);
}

/** Что из цели нужно загрузчику (url/click/form_submit/js, без builtin/s2s/crm). */
export interface PublicGoal {
  key: string;
  detectors: Array<
    Extract<GoalDetector, { kind: 'url' | 'click' | 'form_submit' | 'js' }>
  >;
  /** event — загрузчик передаёт value/currency из `V4CAssist('goal', …)`. */
  valueMode: 'none' | 'fixed' | 'event';
}
