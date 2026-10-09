/**
 * «Только чтение» под сессией учётки (заход 11, Р-З11-Г1…Г4): обход
 * «Админки» идёт в браузере, где у страницы — права живого сотрудника
 * заказчика. Стоп-лист кликов (`click-guard.ts`) решает, ЧТО нажимать, но
 * не то, что сделает обработчик клика (или сама страница при загрузке):
 * «раскрывашка», которая шлёт POST «отметить прочитанным», автосохранение,
 * beacon, отправка формы скриптом, `location.href='/orders/9/cancel'`.
 * Поэтому под сессией учётки на ВСЁ время задания (кроме самого шага входа)
 * сеть пропускает только чтение:
 *
 *  - методы: GET, HEAD, OPTIONS (безопасные по RFC 9110; OPTIONS — CORS
 *    preflight). Всё прочее — обрыв: POST/PUT/PATCH/DELETE, `sendBeacon`,
 *    отправка формы (переход POST), `fetch(..., {keepalive})`;
 *  - исключение — ДОКАЗАННОЕ чтение GraphQL: POST на путь, где сегмент —
 *    `graphql`/`gql` (или содержит `graphql`, или последний сегмент
 *    `query`), тело JSON (или `application/graphql`), каждая операция —
 *    `query` (или краткая форма `{…}`), фрагменты допустимы. Не доказано
 *    (→ обрыв): `mutation`/`subscription`, неизвестные поля тела, повтор
 *    ключа в JSON (сервер «первый ключ выигрывает» исполнил бы другой
 *    документ), persisted query (`extensions.persistedQuery` — с текстом
 *    или без: сервер может исполнить хранимую операцию по хешу), параметры
 *    операции в АДРЕСЕ POST (`?query=` у express-graphql главнее тела),
 *    multipart, разбор не удался;
 *  - GET/HEAD с параметром `query` на пути GraphQL: документ не разобрался,
 *    повтор параметра или `mutation`/`subscription` — обрыв; вне пути
 *    GraphQL — только разобранная мутация (часть серверов принимает
 *    мутации и по GET; HEAD Express обрабатывает GET-обработчиком);
 *  - GET/HEAD «выхода» (любой вид, кроме кода и оформления: картинка
 *    `/logout` тоже) — обрыв: выход по cookie заказчика гасит ЕГО живую
 *    сессию;
 *  - GET/HEAD активных видов (fetch, XHR, beacon, EventSource, документ
 *    фрейма или перехода, начатого страницей) с разрушительным словом или
 *    платёжным путём в адресе — обрыв (тот же словарь, что у ссылок
 *    обхода: GET «/orders/5/delete» — тоже действие; camelCase делится:
 *    `deleteOrder`, `logoutAll`). Переходы самого
 *    воркера (`JobBrowser.goto`) уже проверены стоп-листом ссылок — им
 *    проверка адреса не нужна (стартовый адрес задаёт владелец).
 * Модуль чистый — решение по описанию запроса; исполняет его `JobBrowser`.
 */
import { paymentPath } from '../shared/action-words';
import { DESTRUCTIVE, LOGOUT, splitCamel } from './click-guard';

export type WriteRefusal = 'method' | 'graphql' | 'logout' | 'danger';

export const WRITE_REFUSALS: readonly WriteRefusal[] = [
  'method',
  'graphql',
  'logout',
  'danger',
];

export interface GuardedRequest {
  method: string;
  url: string;
  /** `Request.resourceType()` Playwright. */
  resourceType: string;
  /** Переход главного фрейма, начатый самим воркером (`JobBrowser.goto`). */
  ownNavigation: boolean;
  contentType: string | null;
  /** Тело (лениво: читается только у POST-кандидата в GraphQL). */
  body: () => string | null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Виды, которыми скрипт страницы «действует» адресом. */
const ACTIVE_TYPES = new Set([
  'fetch',
  'xhr',
  'ping',
  'eventsource',
  'document',
]);
/**
 * Код и оформление (`/js/logout-button.js`, шрифт) — не «выход»: их адрес
 * не исполняет действия на сервере, а обрыв сломал бы страницу.
 */
const STATIC_TYPES = new Set([
  'script',
  'stylesheet',
  'font',
  'manifest',
  'texttrack',
]);
/** Потолок тела GraphQL, которое вообще разбираем. */
export const GRAPHQL_BODY_MAX = 128 * 1024;
const GRAPHQL_BATCH_MAX = 20;
const OPERATION_WORDS = new Set([
  'query',
  'mutation',
  'subscription',
  'fragment',
]);
/** Параметры операции в адресе POST — сервер может предпочесть их телу. */
const GRAPHQL_URL_PARAMS = [
  'query',
  'operationName',
  'operationname',
  'extensions',
  'variables',
  'documentId',
  'documentid',
  'queryId',
  'doc_id',
  'id',
];
const GRAPHQL_BODY_KEYS = new Set([
  'query',
  'variables',
  'operationName',
  'extensions',
]);

export function writeRefusal(r: GuardedRequest): WriteRefusal | null {
  const method = r.method.toUpperCase();
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return 'method';
  }
  if (!SAFE_METHODS.has(method)) {
    if (method !== 'POST') return 'method';
    if (!graphqlPostIsRead(u, r.contentType, r.body)) {
      return graphqlPath(u) ? 'graphql' : 'method';
    }
  } else if ((method === 'GET' || method === 'HEAD') && graphqlGetIsWrite(u)) {
    return 'graphql';
  }
  if (r.ownNavigation) return null;
  const pathQuery = splitCamel(decodeSafe(`${u.pathname}${u.search}`));
  if (!STATIC_TYPES.has(r.resourceType) && LOGOUT.test(pathQuery))
    return 'logout';
  if (
    ACTIVE_TYPES.has(r.resourceType) &&
    (DESTRUCTIVE.test(pathQuery) || paymentPath(decodeSafe(u.pathname)))
  ) {
    return 'danger';
  }
  return null;
}

/**
 * Путь — конечная точка GraphQL: сегмент `graphql`/`gql` (с расширением —
 * `graphql.json`), сегмент, содержащий `graphql`, или последний сегмент
 * `query` (gqlgen). Подстрока `gql` в слове (`/api/sgqlx`) — нет.
 */
export function graphqlPath(u: URL): boolean {
  const p = decodeSafe(u.pathname).toLowerCase();
  if (/(^|\/)(graphql|gql)([/.]|$)/.test(p)) return true;
  const segs = p.split('/').filter(Boolean);
  if (segs.some((x) => x.includes('graphql'))) return true;
  return segs[segs.length - 1] === 'query';
}

/** POST — доказанное чтение GraphQL (иначе — false: не доказано). */
export function graphqlPostIsRead(
  u: URL,
  contentType: string | null,
  body: () => string | null,
): boolean {
  if (!graphqlPath(u)) return false;
  // Параметры операции в адресе (express-graphql: адрес главнее тела).
  if (GRAPHQL_URL_PARAMS.some((k) => u.searchParams.has(k))) return false;
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim();
  let raw: string | null;
  try {
    raw = body();
  } catch {
    return false;
  }
  if (!raw || raw.length > GRAPHQL_BODY_MAX) return false;
  if (ct === 'application/graphql') return graphqlDocIsRead(raw);
  if (!/^application\/([a-z0-9.+-]*\+)?json$/.test(ct)) return false;
  // Повтор ключа: `JSON.parse` берёт последний, иные парсеры — первый.
  if (jsonHasDuplicateKeys(raw) !== false) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  if (!ops.length || ops.length > GRAPHQL_BATCH_MAX) return false;
  return ops.every((op) => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return false;
    const o = op as Record<string, unknown>;
    if (Object.keys(o).some((k) => !GRAPHQL_BODY_KEYS.has(k))) return false;
    // Persisted query (APQ, с текстом или без): сервер может исполнить
    // хранимую по хешу операцию, а не присланный текст.
    const ext = o.extensions;
    if (ext !== undefined && ext !== null) {
      if (typeof ext !== 'object' || Array.isArray(ext)) return false;
      if ('persistedQuery' in (ext as Record<string, unknown>)) return false;
    }
    // «Только хеш» persisted query — текста нет, чтение не доказать.
    return typeof o.query === 'string' && graphqlDocIsRead(o.query);
  });
}

/**
 * GET/HEAD `?query=` — запись. На пути GraphQL — при любом сомнении:
 * повтор параметра, документ не разобрался, `mutation`/`subscription`.
 * Вне пути GraphQL (`?query=` — обычный поиск) — только разобранная
 * мутация или подписка.
 */
export function graphqlGetIsWrite(u: URL): boolean {
  const qs = u.searchParams.getAll('query');
  if (!qs.length) return false;
  const onPath = graphqlPath(u);
  if (onPath && qs.length > 1) return true;
  for (const q of qs) {
    const kinds = graphqlDefinitions(q);
    if (kinds === null) {
      if (onPath) return true;
      continue;
    }
    if (kinds.some((k) => k === 'mutation' || k === 'subscription'))
      return true;
  }
  return false;
}

/**
 * Повтор ключа в каком-либо объекте JSON (ключи сравниваются ПОСЛЕ
 * раскодирования `\uXXXX`). `null` — не JSON (разбор не удался).
 */
export function jsonHasDuplicateKeys(raw: string): boolean | null {
  const stack: Array<Set<string> | null> = [];
  let i = 0;
  const n = raw.length;
  // Ожидается ли ключ (после `{` или `,` в объекте).
  let wantKey = false;
  while (i < n) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) return null;
        const d = raw[j];
        if (d === '"') break;
        if (d === '\\') {
          const e = raw[j + 1];
          if (e === 'u') {
            const hex = raw.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
            out += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          if (e === undefined) return null;
          out += e;
          j += 2;
          continue;
        }
        out += d;
        j++;
      }
      const top = stack[stack.length - 1];
      if (wantKey && top) {
        if (top.has(out)) return true;
        top.add(out);
        wantKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') {
      stack.push(new Set());
      wantKey = true;
    } else if (c === '[') {
      stack.push(null);
      wantKey = false;
    } else if (c === '}' || c === ']') {
      if (!stack.length) return null;
      stack.pop();
      wantKey = false;
    } else if (c === ',') {
      wantKey = stack[stack.length - 1] instanceof Set;
    }
    i++;
  }
  return stack.length ? null : false;
}

/** Документ — только `query`/краткая форма (и фрагменты). */
export function graphqlDocIsRead(doc: string): boolean {
  const kinds = graphqlDefinitions(doc);
  if (!kinds || !kinds.length) return false;
  if (!kinds.every((k) => k === 'query' || k === 'anon' || k === 'fragment'))
    return false;
  return kinds.some((k) => k === 'query' || k === 'anon');
}

/**
 * Виды определений верхнего уровня документа GraphQL: `query`,
 * `mutation`, `subscription`, `fragment`, `anon` (краткая форма `{…}`) или
 * иное слово (SDL и прочее — не исполняемое). Строки, блочные строки и
 * комментарии пропускаются; скобки `{}`, `()`, `[]` — по стеку. Ошибка
 * разбора (незакрытая строка или скобка, чужой символ, определение без
 * набора полей) — `null`.
 */
export function graphqlDefinitions(doc: string): string[] | null {
  const kinds: string[] = [];
  const stack: string[] = [];
  const PAIR: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  let inDef = false;
  let i = 0;
  const n = doc.length;
  while (i < n) {
    const c = doc[i];
    if (c === '#') {
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
      continue;
    }
    if (c === '"') {
      if (doc.startsWith('"""', i)) {
        let j = i + 3;
        for (;;) {
          const end = doc.indexOf('"""', j);
          if (end < 0) return null;
          if (doc[end - 1] === '\\') {
            j = end + 3;
            continue;
          }
          i = end + 3;
          break;
        }
        continue;
      }
      i++;
      while (i < n && doc[i] !== '"') {
        if (doc[i] === '\n' || doc[i] === '\r') return null;
        if (doc[i] === '\\') i++;
        i++;
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (/[\s,﻿]/.test(c)) {
      i++;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      if (!stack.length && !inDef) {
        // Определение без ключевого слова — только краткая форма запроса.
        if (c !== '{') return null;
        kinds.push('anon');
        inDef = true;
      }
      stack.push(c);
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      if (stack.pop() !== PAIR[c]) return null;
      if (!stack.length && c === '}') inDef = false;
      i++;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[_0-9A-Za-z]/.test(doc[j])) j++;
      const word = doc.slice(i, j);
      if (!stack.length && !inDef) {
        kinds.push(word);
        inDef = true;
      } else if (!stack.length && OPERATION_WORDS.has(word)) {
        // Ключевое слово операции внутри заголовка определения (`query
        // mutation {…}`, `query Q mutation M {…}`) — не доказать: null.
        return null;
      }
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(doc[j])) j++;
      i = j;
      continue;
    }
    if (doc.startsWith('...', i)) {
      i += 3;
      continue;
    }
    if ('!$&:=@|'.includes(c)) {
      i++;
      continue;
    }
    return null;
  }
  if (stack.length || inDef) return null;
  return kinds;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
