/**
 * AI Publisher (P-G2): тонкий слой над общими декодерами P-G1
 * (`lib/publisher/decode.ts`) для клиентов денег, заявок и отчётов —
 * короткие имена и пара помощников, которых нет в общем модуле
 * (`arr` без отображения, списки строк, словари чисел). Ошибка формы —
 * та же `PUB_RESPONSE_INVALID` (502): ноль вместо неизвестного не
 * подставляется.
 */
import { seg, type PublisherHttp, type Query } from './common-api';
import {
  PubDecodeError,
  completeness,
  computable,
  int,
  intOrNull,
  isoOrNull,
  iso,
  itemsOf,
  listPage,
  minor,
  minorOrNull,
  num,
  obj,
  oneOf,
  oneOfOrNull,
  str,
  strOrNull,
  bool,
  type Computable,
  type Completeness,
  type ListPage,
  type Rec,
} from './decode';

export {
  bool,
  completeness,
  computable,
  int,
  iso,
  minor,
  num,
  obj,
  type Computable,
  type Completeness,
  type ListPage,
  type Rec,
};
export const strN = strOrNull;
export const intN = intOrNull;
export const minorN = minorOrNull;
export const isoN = isoOrNull;
export const choice = oneOf;
export const choiceN = oneOfOrNull;
export const page = listPage;
export const items = itemsOf;
export { str };

export function bad(where: string): never {
  throw new PubDecodeError(where);
}

export function boolN(v: unknown, where = 'bool?'): boolean | null {
  return v === null || v === undefined ? null : bool(v, where);
}

/** Массив без отображения (элементы разбирает вызывающий). */
export function arr(v: unknown, where = 'array'): unknown[] {
  return Array.isArray(v) ? v : bad(where);
}

export function strList(v: unknown, where = 'string[]'): string[] {
  return arr(v, where).map((x) => str(x, where));
}

export function numRecord(
  v: unknown,
  where = 'record'
): Record<string, number> {
  const o = obj(v, where);
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(o)) out[k] = num(x, `${where}.${k}`);
  return out;
}

/** Путь продукта от `/publisher/` (§11.3): `products/<pid>`. */
export const productPath = (pid: string) => `products/${seg(pid)}`;
export { seg };

/** Короткие обёртки клиента P-G1 (`PublisherHttp`). */
export function verbs(http: PublisherHttp) {
  return {
    get: (path: string, query?: Query) => http.get<unknown>(path, query),
    post: (path: string, body: Record<string, unknown>, opKey: string) =>
      http.send<unknown>('POST', path, body, opKey),
    patch: (path: string, body: Record<string, unknown>, opKey: string) =>
      http.send<unknown>('PATCH', path, body, opKey),
    put: (path: string, body: Record<string, unknown>, opKey: string) =>
      http.send<unknown>('PUT', path, body, opKey),
  };
}
