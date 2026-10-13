/**
 * AI Publisher — разбор контрактов бэкенда (`contracts/*-api.ts`) текстом
 * для тестов assist: маршруты (метод, путь, тип тела) и ключи `*Body`
 * (обязательные/необязательные), включая `extends`, пересечения `A & B &
 * {…}`, `Partial<…>`, `Omit<…, 'k'>`. Не тест (не `*.test.ts`) — общий
 * помощник `publisher-ops-api.test.ts` и `publisher-bodies.test.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BACK = '../../sites-backend/src/modules/publisher/contracts/';
export const contractSrc = (f: string) =>
  readFileSync(new URL(`${BACK}${f}`, import.meta.url), 'utf8');

export const CONTRACT_FILES = [
  'common.ts',
  'core-api.ts',
  'content-api.ts',
  'ai-api.ts',
  'distribution-api.ts',
  'leads-api.ts',
  'reports-api.ts',
  'reddit-api.ts',
] as const;

/** Все контракты одной строкой (имена типов уникальны в пределах пакета). */
export const ALL = CONTRACT_FILES.map(contractSrc)
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

export type KeySet = Map<string, boolean>; // ключ → обязателен

function braceEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced');
}

/** Ключи литерала `{ … }` (первый уровень). */
function literalKeys(raw: string): KeySet {
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out: KeySet = new Map();
  let depth = 0;
  let line = '';
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;
    if (ch === '\n' || ch === ';' || (ch === ',' && depth === 0)) {
      line = '';
      continue;
    }
    line += ch;
    if (depth === 0) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)(\?)?:$/.exec(line);
      if (m) out.set(m[1], !m[2]);
    }
  }
  return out;
}

/** Разбить выражение типа по `&` верхнего уровня. */
function splitAmp(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if ('{(<['.includes(ch)) depth++;
    else if ('})>]'.includes(ch)) depth--;
    if (ch === '&' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Ключи типа по имени или выражению (рекурсивно). */
export function bodyKeys(expr: string, src = ALL): KeySet {
  const e = expr.trim();
  if (e === 'void' || e === 'never') return new Map();
  const amp = splitAmp(e);
  if (amp.length > 1) {
    const out: KeySet = new Map();
    for (const p of amp) for (const [k, r] of bodyKeys(p, src)) out.set(k, r);
    return out;
  }
  if (e.startsWith('{')) return literalKeys(e.slice(1, braceEnd(e, 0)));
  let m = /^Partial<([\s\S]*)>$/.exec(e);
  if (m) {
    const inner = bodyKeys(m[1], src);
    return new Map([...inner.keys()].map((k) => [k, false]));
  }
  m = /^Omit<([\s\S]*?),\s*([^>]*)>$/.exec(e);
  if (m) {
    const inner = bodyKeys(m[1], src);
    for (const k of [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]))
      inner.delete(k);
    return inner;
  }
  const name = /^[A-Za-z_]\w*$/.exec(e)?.[0];
  assert.ok(name, `тип не разобран: ${e}`);
  const iface = new RegExp(
    `export interface ${name}(?:<[^>]*>)?(?:\\s+extends\\s+([\\w<>, ]+))?\\s*\\{`
  ).exec(src);
  if (iface) {
    const open = iface.index + iface[0].length - 1;
    const own = literalKeys(src.slice(open + 1, braceEnd(src, open)));
    const out: KeySet = new Map();
    for (const p of (iface[1] ?? '').split(',').map((x) => x.trim()))
      if (p) for (const [k, r] of bodyKeys(p, src)) out.set(k, r);
    for (const [k, r] of own) out.set(k, r);
    return out;
  }
  const head = new RegExp(`export type ${name}\\s*=`).exec(src);
  if (!head) throw new Error(`нет типа ${name}`);
  let depth = 0;
  let aliasExpr = '';
  for (let i = head.index + head[0].length; i < src.length; i++) {
    const ch = src[i];
    if ('{(<['.includes(ch)) depth++;
    else if ('})>]'.includes(ch)) depth--;
    if (ch === ';' && depth === 0) break;
    aliasExpr += ch;
  }
  return bodyKeys(aliasExpr, src);
}

export interface RouteDef {
  name: string;
  method: string;
  path: string;
  re: RegExp;
  body: string;
}

/** Маршруты `*_ROUTES` файла: имя, метод, путь, тип тела. */
export function routesOf(file: string): RouteDef[] {
  const out: RouteDef[] = [];
  // Префикс файла (`const P = '/publisher/products/:pid/reddit'` у P-R);
  // у файлов без своего — путь продукта.
  const prefix =
    (/const [PC] = '([^']+)'/.exec(file) ?? [])[1] ??
    '/publisher/products/:pid';
  const re = /(\w+):\s*route<\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file))) {
    // Тип тела — первый аргумент дженерика до запятой верхнего уровня.
    let i = m.index + m[0].length;
    let depth = 0;
    let body = '';
    for (; i < file.length; i++) {
      const ch = file[i];
      if ('{(<['.includes(ch)) depth++;
      else if ('})>]'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) break;
      body += ch;
    }
    const rest = file.slice(i, i + 600);
    const mm = /method: '(\w+)',\s*path: [`']([^`']+)[`']/.exec(rest);
    if (!mm) continue;
    const path = mm[2].replace(/\$\{[PC]\}/, prefix);
    out.push({
      name: m[1],
      method: mm[1],
      path,
      re: new RegExp(`^${path.replace(/:\w+/g, '[^/]+')}$`),
      body: body.trim(),
    });
  }
  return out;
}

/**
 * Сверка тела запроса с `*Body`: лишних ключей нет, обязательные есть
 * (`opKey` кладёт `PublisherHttp`, в теле клиента его нет). Пустой ответ —
 * всё в порядке; иначе — список расхождений.
 */
export function bodyIssues(
  body: Record<string, unknown>,
  keys: KeySet
): string[] {
  const issues: string[] = [];
  for (const k of Object.keys(body)) {
    if (!keys.has(k)) issues.push(`лишний ключ ${k}`);
  }
  for (const [k, req] of keys) {
    if (req && k !== 'opKey' && !(k in body)) issues.push(`нет ключа ${k}`);
  }
  return issues;
}
