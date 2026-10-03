/**
 * Правила голосового управления из кабинета (§5-бис.2): разрешённые зоны,
 * запреты, подтверждение заполнения, лимит шагов. Чистый разбор: кабинет —
 * строго (лишние ключи и мусор — ошибка с путём), публичный код — то, что
 * лежит в базе (мусор старой версии → умолчания, запреты при этом НЕ
 * теряются молча: битое правило denylist — весь режим как «выключен»).
 */
import type { VoiceControlRules } from './types';

export const RULE_LIMITS = {
  listItems: 30,
  item: 200,
  word: 60,
  /** «Сайт» — 6 по умолчанию, «Админка» — 10; не выше 15 (§5-бис.2). */
  maxStepsCap: 15,
  siteDefaultSteps: 6,
} as const;

export function defaultVoiceControlRules(): VoiceControlRules {
  return {
    schema: 1,
    allowPaths: [],
    allowSelectors: [],
    denySelectors: [],
    denyPaths: [],
    denyWords: [],
    confirmFill: false,
    maxSteps: RULE_LIMITS.siteDefaultSteps,
  };
}

/** Маска пути — как PATH_MASK кабинета (`/catalog*`). */
export const PATH_MASK_RE = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;
/** Селектор: печатный CSS без `<`, обратных кавычек и управляющих (как карта). */
export const RULE_SELECTOR_RE = /^[\p{L}\p{N}\s#.:()[\]="'_*^$|~+>,\\/-]+$/u;

type Errors = Array<{ path: string; code: string }>;

const KEYS = [
  'schema',
  'allowPaths',
  'allowSelectors',
  'denySelectors',
  'denyPaths',
  'denyWords',
  'confirmFill',
  'maxSteps',
];

function list(
  raw: unknown,
  path: string,
  ok: (s: string) => boolean,
  max: number,
  errors: Errors,
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path, code: 'type' });
    return [];
  }
  if (raw.length > RULE_LIMITS.listItems)
    errors.push({ path, code: 'too_many' });
  const out: string[] = [];
  raw.forEach((v, i) => {
    const s = typeof v === 'string' ? v.trim() : null;
    if (!s || s.length > max || !ok(s)) {
      errors.push({ path: `${path}.${i}`, code: 'format' });
      return;
    }
    if (!out.includes(s)) out.push(s);
  });
  return out.slice(0, RULE_LIMITS.listItems);
}

export type RulesParse =
  { ok: true; rules: VoiceControlRules } | { ok: false; errors: Errors };

/** Строгий разбор (кабинет). */
export function parseVoiceControlRules(raw: unknown): RulesParse {
  if (raw === null || raw === undefined)
    return { ok: true, rules: defaultVoiceControlRules() };
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, errors: [{ path: '', code: 'type' }] };
  const o = raw as Record<string, unknown>;
  const errors: Errors = [];
  for (const k of Object.keys(o))
    if (!KEYS.includes(k)) errors.push({ path: k, code: 'unknown' });
  if (o.schema !== undefined && o.schema !== 1)
    errors.push({ path: 'schema', code: 'schema' });
  const sel = (s: string) => RULE_SELECTOR_RE.test(s) && !/[<`]/.test(s);
  const rules: VoiceControlRules = {
    schema: 1,
    allowPaths: list(
      o.allowPaths,
      'allowPaths',
      (s) => PATH_MASK_RE.test(s),
      RULE_LIMITS.item,
      errors,
    ),
    allowSelectors: list(
      o.allowSelectors,
      'allowSelectors',
      sel,
      RULE_LIMITS.item,
      errors,
    ),
    denySelectors: list(
      o.denySelectors,
      'denySelectors',
      sel,
      RULE_LIMITS.item,
      errors,
    ),
    denyPaths: list(
      o.denyPaths,
      'denyPaths',
      (s) => PATH_MASK_RE.test(s),
      RULE_LIMITS.item,
      errors,
    ),
    denyWords: list(
      o.denyWords,
      'denyWords',
      // eslint-disable-next-line no-control-regex
      (s) => !/[\u0000-\u001f<>`]/.test(s),
      RULE_LIMITS.word,
      errors,
    ),
    confirmFill: false,
    maxSteps: RULE_LIMITS.siteDefaultSteps,
  };
  if (o.confirmFill !== undefined) {
    if (typeof o.confirmFill !== 'boolean')
      errors.push({ path: 'confirmFill', code: 'type' });
    else rules.confirmFill = o.confirmFill;
  }
  if (o.maxSteps !== undefined) {
    const n = o.maxSteps;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > RULE_LIMITS.maxStepsCap
    )
      errors.push({ path: 'maxSteps', code: 'range' });
    else rules.maxSteps = n;
  }
  return errors.length ? { ok: false, errors } : { ok: true, rules };
}

/**
 * Сохранённые правила → действующие (публичный код). Не разобралось —
 * `null`: вызывающий считает голосовое управление выключенным (запреты
 * владельца не могут пропасть тихо).
 */
export function rulesOf(raw: unknown): VoiceControlRules | null {
  const p = parseVoiceControlRules(raw);
  return p.ok ? p.rules : null;
}

/** Путь подходит под маску (`*` — любой хвост, без `*` — точно). */
export function pathMatches(path: string, mask: string): boolean {
  if (mask.endsWith('*')) return path.startsWith(mask.slice(0, -1));
  return path === mask || path === `${mask}/`;
}

/**
 * Страница в разрешённой зоне (§5-бис.2): не под запрещённой маской и,
 * если зоны заданы, — под одной из разрешённых. Нет — плана нет вовсе.
 */
export function zoneAllowed(path: string, rules: VoiceControlRules): boolean {
  if (rules.denyPaths.some((m) => pathMatches(path, m))) return false;
  return (
    rules.allowPaths.length === 0 ||
    rules.allowPaths.some((m) => pathMatches(path, m))
  );
}
