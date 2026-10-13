/**
 * AI Publisher — маленький валидатор JSON-структур (P-A1, проектный
 * документ §12.1, §6.2): значения параметров, тела запросов, ответы AI.
 * Чистый модуль без зависимостей.
 *
 * Правила (как у строгой JSON-схемы ответа AI):
 *  - объект — только перечисленные ключи (`additionalProperties: false`),
 *    лишний ключ — `unknown_field`; обязательные — все, кроме `s.optional`;
 *  - `null` — только где схема `s.nullable(...)`;
 *  - строки и массивы — с потолком длины (по умолчанию 2000 и 30, как у
 *    схем генераторов §12.2), целые — `Number.isSafeInteger`.
 *
 * Ошибки — список `{field, code}` (путь `a.b[2].c`), а не исключение:
 * сервис отдаёт его в `PUB_VALIDATION.details.fields`.
 */
import type { FieldIssue } from '../contracts/errors';

export interface SchemaLite<T> {
  /** Проверка; пустой список — значение подходит. */
  validate(value: unknown, path?: string): FieldIssue[];
  /** Фантомный тип для `Infer` (значения не бывает). */
  readonly __type?: T;
  readonly isOptional?: boolean;
}

export type Infer<S> = S extends SchemaLite<infer T> ? T : never;

type Check = (v: unknown, path: string, out: FieldIssue[]) => void;

function node<T>(check: Check, isOptional = false): SchemaLite<T> {
  return {
    isOptional,
    validate(value: unknown, path = ''): FieldIssue[] {
      const out: FieldIssue[] = [];
      check(value, path, out);
      return out;
    },
  };
}

function run(
  schema: SchemaLite<unknown>,
  v: unknown,
  path: string,
  out: FieldIssue[],
): void {
  out.push(...schema.validate(v, path));
}

const at = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

const issue = (out: FieldIssue[], field: string, code: string): void => {
  out.push({ field: field || '$', code });
};

export interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Обрезанная строка должна быть непустой (по умолчанию — при min ≥ 1). */
  trimmed?: boolean;
}

export const s = {
  string(opts: StringOpts = {}): SchemaLite<string> {
    const min = opts.min ?? 0;
    const max = opts.max ?? 2000;
    return node<string>((v, path, out) => {
      if (typeof v !== 'string') return issue(out, path, 'type');
      const len = [...v].length;
      if (len < min || len > max) return issue(out, path, 'length');
      if ((opts.trimmed ?? min >= 1) && min >= 1 && v.trim().length === 0) {
        return issue(out, path, 'length');
      }
      if (opts.pattern && !opts.pattern.test(v)) issue(out, path, 'format');
    });
  },

  int(opts: { min?: number; max?: number } = {}): SchemaLite<number> {
    return node<number>((v, path, out) => {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
        return issue(out, path, 'type');
      }
      if (
        (opts.min !== undefined && v < opts.min) ||
        (opts.max !== undefined && v > opts.max)
      ) {
        issue(out, path, 'range');
      }
    });
  },

  number(opts: { min?: number; max?: number } = {}): SchemaLite<number> {
    return node<number>((v, path, out) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return issue(out, path, 'type');
      }
      if (
        (opts.min !== undefined && v < opts.min) ||
        (opts.max !== undefined && v > opts.max)
      ) {
        issue(out, path, 'range');
      }
    });
  },

  boolean(): SchemaLite<boolean> {
    return node<boolean>((v, path, out) => {
      if (typeof v !== 'boolean') issue(out, path, 'type');
    });
  },

  enum<const V extends readonly string[]>(values: V): SchemaLite<V[number]> {
    return node<V[number]>((v, path, out) => {
      if (typeof v !== 'string') return issue(out, path, 'type');
      if (!(values as readonly string[]).includes(v)) issue(out, path, 'enum');
    });
  },

  literal<const V extends string | number | boolean>(value: V): SchemaLite<V> {
    return node<V>((v, path, out) => {
      if (v !== value) issue(out, path, 'enum');
    });
  },

  array<T>(
    item: SchemaLite<T>,
    opts: { min?: number; max?: number; unique?: boolean } = {},
  ): SchemaLite<T[]> {
    const min = opts.min ?? 0;
    const max = opts.max ?? 30;
    return node<T[]>((v, path, out) => {
      if (!Array.isArray(v)) return issue(out, path, 'type');
      if (v.length < min || v.length > max) issue(out, path, 'length');
      v.forEach((x, i) => run(item, x, at(path, i), out));
      if (opts.unique) {
        const seen = new Set(v.map((x) => JSON.stringify(x)));
        if (seen.size !== v.length) issue(out, path, 'duplicate');
      }
    });
  },

  object<S extends Record<string, SchemaLite<unknown>>>(
    shape: S,
  ): SchemaLite<InferObject<S>> {
    return node<InferObject<S>>((v, path, out) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return issue(out, path, 'type');
      }
      const o = v as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        if (!Object.prototype.hasOwnProperty.call(shape, key)) {
          issue(out, at(path, key), 'unknown_field');
        }
      }
      for (const [key, schema] of Object.entries(shape)) {
        if (
          !Object.prototype.hasOwnProperty.call(o, key) ||
          o[key] === undefined
        ) {
          if (!schema.isOptional) issue(out, at(path, key), 'required');
          continue;
        }
        run(schema, o[key], at(path, key), out);
      }
    });
  },

  /** Словарь: ключи из списка/по шаблону, значения одной схемы. */
  record<T>(
    values: SchemaLite<T>,
    opts: {
      keys?: readonly string[];
      keyPattern?: RegExp;
      maxKeys?: number;
    } = {},
  ): SchemaLite<Record<string, T>> {
    return node<Record<string, T>>((v, path, out) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return issue(out, path, 'type');
      }
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > (opts.maxKeys ?? 50)) issue(out, path, 'length');
      for (const [key, val] of entries) {
        const okKey =
          (!opts.keys || opts.keys.includes(key)) &&
          (!opts.keyPattern || opts.keyPattern.test(key));
        if (!okKey) {
          issue(out, at(path, key), 'unknown_field');
          continue;
        }
        run(values, val, at(path, key), out);
      }
    });
  },

  nullable<T>(schema: SchemaLite<T>): SchemaLite<T | null> {
    return node<T | null>((v, path, out) => {
      if (v === null) return;
      run(schema, v, path, out);
    }, schema.isOptional);
  },

  /** Ключ объекта может отсутствовать (значение — как у схемы). */
  optional<T>(schema: SchemaLite<T>): SchemaLite<T | undefined> {
    return node<T | undefined>(
      (v, path, out) => run(schema, v, path, out),
      true,
    );
  },

  /** Любое JSON-значение (размер проверяет вызывающий). */
  json(): SchemaLite<unknown> {
    return node<unknown>((v, path, out) => {
      if (v === undefined || typeof v === 'function' || typeof v === 'bigint') {
        issue(out, path, 'type');
      }
    });
  },

  /** Схема + дополнительная проверка целого значения (межполевые условия). */
  refine<T>(
    schema: SchemaLite<T>,
    check: (v: T) => FieldIssue | null,
  ): SchemaLite<T> {
    return node<T>((v, path, out) => {
      const before = out.length;
      run(schema, v, path, out);
      if (out.length > before) return;
      const extra = check(v as T);
      if (extra) {
        issue(out, extra.field ? at(path, extra.field) : path, extra.code);
      }
    }, schema.isOptional);
  },
};

/** Тип объекта схемы (у `s.optional` значение может быть `undefined`). */
export type InferObject<S extends Record<string, SchemaLite<unknown>>> = {
  [K in keyof S]: Infer<S[K]>;
};

/** Значение подходит под схему (сужение типа). */
export function conforms<T>(schema: SchemaLite<T>, v: unknown): v is T {
  return schema.validate(v).length === 0;
}

/** Размер JSON в байтах UTF-8 (потолки §6.1: метаданные ≤ 64 КБ). */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}
