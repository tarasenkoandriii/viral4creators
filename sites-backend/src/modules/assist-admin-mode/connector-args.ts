/**
 * Проверка и раскладка аргументов операции коннектора «Админки» по месту
 * (path/query/body) — ЧИСТЫЙ модуль без сети и зависимостей сервера.
 * Вынесен из `connector-exec.ts` (сквозной CI 06793bd): ядро мемо
 * «Админки» (`assist-actions/admin-memo.ts`) импортируется стендом e2e
 * виджета, а `connector-exec` тянет `pinned-fetch` → undici/Prisma/Nest,
 * которых в джобе widget нет. `connector-exec` реэкспортирует всё отсюда.
 */
import type { OperationParam } from './openapi-import';

export class ParamValidationError extends Error {
  constructor(readonly detail: string) {
    super(`Параметры не прошли проверку: ${detail}`);
    this.name = 'ParamValidationError';
  }
}

const PATH_VALUE = /^[A-Za-z0-9_\-.~@:+=,]{1,200}$/;

/** Скаляр по схеме параметра → типизированное значение. Бросает ParamValidationError. */
function scalarValue(
  p: Pick<
    OperationParam,
    'name' | 'enum' | 'maxLength' | 'minimum' | 'maximum'
  >,
  type: 'string' | 'integer' | 'number' | 'boolean',
  v: unknown,
): string | number | boolean {
  let out: string | number | boolean;
  if (type === 'integer' || type === 'number') {
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string' && v.trim()
          ? Number(v)
          : NaN;
    if (!Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) {
      throw new ParamValidationError(`${p.name}: не число`);
    }
    if (p.minimum !== undefined && n < p.minimum) {
      throw new ParamValidationError(`${p.name}: меньше минимума`);
    }
    if (p.maximum !== undefined && n > p.maximum) {
      throw new ParamValidationError(`${p.name}: больше максимума`);
    }
    out = n;
  } else if (type === 'boolean') {
    if (v !== true && v !== false && v !== 'true' && v !== 'false') {
      throw new ParamValidationError(`${p.name}: не true/false`);
    }
    out = v === true || v === 'true';
  } else {
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new ParamValidationError(`${p.name}: не строка`);
    }
    out = String(v);
    const max = Math.min(p.maxLength ?? 200, 500);
    if (out.length > max)
      throw new ParamValidationError(`${p.name}: длиннее ${max}`);
  }
  if (p.enum && !p.enum.map(String).includes(String(out))) {
    throw new ParamValidationError(`${p.name}: не из списка`);
  }
  return out;
}

/** Проверенные аргументы: путь и запрос — строками, тело — типизированным JSON. */
export interface ValidatedArgs {
  path: Record<string, string>;
  query: Record<string, string | string[]>;
  body: Record<string, unknown> | null;
}

/**
 * Проверить аргументы модели по параметрам операции (§5.4 п.3). Лишние —
 * отказ (модель не подставляет то, чего нет в схеме), обязательные — есть,
 * типы/enum/диапазоны — по схеме; массив — только из скаляров, не длиннее
 * `maxItems`. Бросает ParamValidationError.
 */
export function validateArgs(
  params: readonly OperationParam[],
  args: Record<string, unknown>,
): ValidatedArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ParamValidationError('аргументы — объект');
  }
  const known = new Map(params.map((p) => [p.name, p]));
  for (const k of Object.keys(args)) {
    if (!known.has(k))
      throw new ParamValidationError(`неизвестный параметр ${k}`);
  }
  const path: Record<string, string> = {};
  const query: Record<string, string | string[]> = {};
  let body: Record<string, unknown> | null = params.some((p) => p.in === 'body')
    ? {}
    : null;
  for (const p of params) {
    const v = args[p.name];
    if (
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0)
    ) {
      if (p.required) throw new ParamValidationError(`нет параметра ${p.name}`);
      continue;
    }
    if (p.type === 'array') {
      if (!Array.isArray(v)) {
        throw new ParamValidationError(`${p.name}: нужен список`);
      }
      const max = Math.min(p.maxItems ?? 100, 100);
      if (v.length > max) {
        throw new ParamValidationError(`${p.name}: больше ${max} элементов`);
      }
      const items = v.map((x) => scalarValue(p, p.items ?? 'string', x));
      if (p.in === 'body') body = { ...(body ?? {}), [p.name]: items };
      else if (p.in === 'query') query[p.name] = items.map(String);
      continue;
    }
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
      throw new ParamValidationError(`${p.name}: не скаляр`);
    }
    const val = scalarValue(p, p.type, v);
    if (p.in === 'path') {
      const s = String(val);
      if (!PATH_VALUE.test(s) || /^\.+$/.test(s)) {
        throw new ParamValidationError(
          `${p.name}: недопустимые символы в пути`,
        );
      }
      path[p.name] = s;
    } else if (p.in === 'query') {
      query[p.name] = String(val);
    } else {
      body = { ...(body ?? {}), [p.name]: val };
    }
  }
  return { path, query, body };
}
