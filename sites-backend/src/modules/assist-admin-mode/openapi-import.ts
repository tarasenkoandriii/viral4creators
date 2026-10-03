/**
 * Импорт OpenAPI 3.x и автоклассификация операций (ТЗ §3.8 п.3, §5.2).
 *
 * Классы:
 *  - `read`   — GET/HEAD; описание не говорит о побочном эффекте;
 *  - `write`  — POST/PUT/PATCH, а также GET/HEAD, чьё описание прямо говорит
 *               «создаёт/изменяет/отправляет…» (GET, который что-то меняет, —
 *               забота владельца, но если спецификация сама это пишет — не read);
 *  - `danger` — DELETE; изменяющий метод со стоп-словом в имени/описании
 *               (delete, refund, cancel, charge, payout, mass, «удалить»,
 *               «повернення» … — тот же подход, что `dangerKindsFor`,
 *               shared/danger-words.ts) или массовая операция (массив id в
 *               параметрах/теле).
 *
 * Стоп-слова к GET/HEAD не применяются: «GET /refunds» — список возвратов,
 * а не возврат; иначе чтение возвратов стало бы недоступно навсегда (класс
 * не опускается). Но GET/HEAD с глаголом-действием первым словом
 * operationId или целым последним сегментом пути (`deleteUser`,
 * `GET /orders/{id}/cancel`) — `write`/`danger` (аудит Э7). Автоклассификация — подсказка: владелец может ПОДНЯТЬ
 * класс (`read` → `write`), но не опустить (`canSetKind`).
 *
 * Принимается только JSON (YAML — конвертируйте; парсер YAML не тащим ради
 * одного экрана), ссылки `$ref` — только локальные `#/components/parameters/*`
 * и `#/components/schemas/*` (чужой URL в `$ref` — не наша сеть).
 *
 * Чистый модуль: ни базы, ни сети, ни Nest.
 */
import { createHash } from 'crypto';
import { dangerKindsFor } from '../../shared/danger-words';

export type OperationKind = 'read' | 'write' | 'danger';
export const OPERATION_KINDS: readonly OperationKind[] = [
  'read',
  'write',
  'danger',
];
const RANK: Record<OperationKind, number> = { read: 0, write: 1, danger: 2 };

/** Ранг класса: read 0 < write 1 < danger 2. */
export function kindRank(k: OperationKind): number {
  return RANK[k];
}

/** Поднять можно, опустить ниже автоклассификации — нет (§5.2). */
export function canSetKind(auto: OperationKind, next: OperationKind): boolean {
  return RANK[next] >= RANK[auto];
}

export const OPENAPI_MAX_BYTES = 2 * 1024 * 1024;
export const OPENAPI_MAX_OPERATIONS = 300;
const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;

export type OpenApiImportCode =
  | 'too_large'
  | 'not_json'
  | 'not_openapi3'
  | 'no_server'
  | 'bad_server'
  | 'no_operations'
  | 'too_many_operations'
  | 'bad_compensation'
  | 'bad_preview';

export class OpenApiImportError extends Error {
  constructor(
    readonly code: OpenApiImportCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiImportError';
  }
}

export type ScalarType = 'string' | 'integer' | 'number' | 'boolean';
export type ParamType = ScalarType | 'array';

/**
 * Параметр операции — то, что модель может подставить: path/query (Э7) и
 * поля JSON-тела верхнего уровня (Э8, write/danger). Массив — только из
 * скаляров (`items`), до `maxItems` (≤ 100) — массовая операция.
 */
export interface OperationParam {
  name: string;
  in: 'path' | 'query' | 'body';
  required: boolean;
  type: ParamType;
  items?: ScalarType;
  maxItems?: number;
  enum?: Array<string | number>;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
}

/**
 * Откуда брать значение параметра компенсации/предпросмотра (ТЗ §5-бис.15
 * п.14): `$.request.<параметр>[.путь]` — из исходного запроса,
 * `$.preview.<путь>` — из снимка «было» (`x-assist-preview`).
 */
export type ValueRef = string;
export const VALUE_REF_RE =
  /^\$\.(request|preview)\.[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}|\[\d{1,3}\]){0,8}$/;

/** `x-assist-compensation` / `x-assist-preview` (по operationId). */
export interface LinkedOperation {
  operationId: string;
  params: Record<string, ValueRef>;
}

/** Массивов в параметре — не больше (массовая операция = одна карточка). */
export const PARAM_MAX_ITEMS = 100;

export interface ImportedOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  autoKind: OperationKind;
  kindReason: string;
  params: OperationParam[];
  /** Обязательный параметр в заголовке/cookie — модель его не подставит. */
  unsupported: boolean;
  /** Э8: `x-assist-idempotent: true`. */
  idempotent: boolean;
  /** Э8: `x-assist-compensation` (проверено `checkLinks`). */
  compensation: LinkedOperation | null;
  /** Э8: `x-assist-preview` — read-операция «было». */
  preview: LinkedOperation | null;
  /** Э8: числовой параметр суммы изменяющей операции (денежный потолок). */
  autoAmountParam: string | null;
}

export interface ImportedSpec {
  title: string | null;
  version: string;
  baseUrl: string;
  specHash: string;
  operations: ImportedOperation[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const clip = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.trim()
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, n)
    : null;

function resolveRef(spec: Obj, v: unknown): unknown {
  if (!isObj(v) || typeof v.$ref !== 'string') return v;
  const m =
    /^#\/components\/(parameters|schemas)\/([A-Za-z0-9_.-]{1,100})$/.exec(
      v.$ref,
    );
  if (!m) return null;
  const comps = isObj(spec.components) ? spec.components : {};
  const group = isObj(comps[m[1]]) ? (comps[m[1]] as Obj) : {};
  return group[m[2]] ?? null;
}

/** `{var}` сервера — подставляются значения по умолчанию. */
function serverUrl(server: unknown, specUrl: string | null): string {
  if (!isObj(server) || typeof server.url !== 'string') {
    throw new OpenApiImportError(
      'no_server',
      'В спецификации нет servers[0].url',
    );
  }
  let raw = server.url.trim();
  const vars = isObj(server.variables) ? server.variables : {};
  raw = raw.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const v = vars[name];
    return isObj(v) && typeof v.default === 'string' ? v.default : `{${name}}`;
  });
  if (/[{}]/.test(raw)) {
    throw new OpenApiImportError(
      'bad_server',
      'servers[0].url содержит переменную без значения по умолчанию',
    );
  }
  let u: URL;
  try {
    u = specUrl ? new URL(raw, specUrl) : new URL(raw);
  } catch {
    throw new OpenApiImportError(
      'bad_server',
      'servers[0].url не абсолютный адрес — укажите базовый URL API',
    );
  }
  return normalizeBaseUrl(u.href);
}

/**
 * Базовый URL API: только https, порт 443, без логина/пароля, запроса и
 * фрагмента; путь без завершающего «/». Бросает OpenApiImportError.
 */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OpenApiImportError('bad_server', 'Базовый URL API — не адрес');
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) {
    throw new OpenApiImportError(
      'bad_server',
      'Базовый URL API — только https:// без порта и без логина',
    );
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function paramOf(spec: Obj, raw: unknown): OperationParam | 'header' | null {
  const p = resolveRef(spec, raw);
  if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string') {
    return null;
  }
  if (p.in === 'header' || p.in === 'cookie') {
    return p.required === true ? 'header' : null;
  }
  if (p.in !== 'path' && p.in !== 'query') return null;
  if (!/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(p.name)) return null;
  const schema = resolveRef(spec, p.schema);
  const s = isObj(schema) ? schema : {};
  const out = scalarOrArray(spec, s, {
    name: p.name,
    in: p.in,
    required: p.in === 'path' ? true : p.required === true,
  });
  if (!out) return p.required === true || p.in === 'path' ? 'header' : null;
  const d = clip(p.description, 200);
  if (d) out.description = d;
  return out;
}

/** Схема скаляра или массива скаляров → параметр; иначе null. */
function scalarOrArray(
  spec: Obj,
  s: Obj,
  base: Pick<OperationParam, 'name' | 'in' | 'required'>,
): OperationParam | null {
  const t = s.type;
  if (t === 'object') return null;
  if (t === 'array') {
    if (base.in === 'path') return null;
    const it = resolveRef(spec, s.items);
    const itObj = isObj(it) ? it : {};
    const itT = itObj.type;
    if (itT === 'object' || itT === 'array') return null;
    const items: ScalarType =
      itT === 'integer' || itT === 'number' || itT === 'boolean'
        ? itT
        : 'string';
    const maxItems =
      typeof s.maxItems === 'number' && s.maxItems > 0
        ? Math.min(s.maxItems, PARAM_MAX_ITEMS)
        : PARAM_MAX_ITEMS;
    const out: OperationParam = { ...base, type: 'array', items, maxItems };
    if (Array.isArray(itObj.enum)) {
      const e = itObj.enum
        .filter((x) => typeof x === 'string' || typeof x === 'number')
        .slice(0, 50) as Array<string | number>;
      if (e.length) out.enum = e;
    }
    return out;
  }
  const type: ScalarType =
    t === 'integer' || t === 'number' || t === 'boolean' ? t : 'string';
  const out: OperationParam = { ...base, type };
  if (Array.isArray(s.enum)) {
    const e = s.enum
      .filter((x) => typeof x === 'string' || typeof x === 'number')
      .slice(0, 50) as Array<string | number>;
    if (e.length) out.enum = e;
  }
  if (typeof s.maxLength === 'number') out.maxLength = s.maxLength;
  if (typeof s.minimum === 'number') out.minimum = s.minimum;
  if (typeof s.maximum === 'number') out.maximum = s.maximum;
  return out;
}

/**
 * Поля JSON-тела верхнего уровня (Э8): скаляры и массивы скаляров. Вложенный
 * объект или тело не JSON: обязательное — операция `unsupported` (модель его
 * не соберёт), необязательное — пропускается.
 */
function bodyParams(
  spec: Obj,
  op: Obj,
): { params: OperationParam[]; unsupported: boolean } {
  const body = resolveRef(spec, op.requestBody);
  if (!isObj(body)) return { params: [], unsupported: false };
  const required = body.required === true;
  const content = isObj(body.content) ? body.content : {};
  const media = content['application/json'];
  if (!isObj(media)) return { params: [], unsupported: required };
  const schema = resolveRef(spec, media.schema);
  if (!isObj(schema) || schema.type !== 'object' || !isObj(schema.properties)) {
    return { params: [], unsupported: required };
  }
  const req = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === 'string')
      : [],
  );
  const params: OperationParam[] = [];
  let unsupported = false;
  for (const [name, raw] of Object.entries(schema.properties).slice(0, 60)) {
    const ps = resolveRef(spec, raw);
    const isReq = req.has(name);
    if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(name) || !isObj(ps)) {
      if (isReq) unsupported = true;
      continue;
    }
    if (ps.readOnly === true) continue;
    const p = scalarOrArray(spec, ps, { name, in: 'body', required: isReq });
    if (!p) {
      if (isReq) unsupported = true;
      continue;
    }
    const d = clip(ps.description, 200);
    if (d) p.description = d;
    params.push(p);
  }
  return { params, unsupported };
}

const AMOUNT_NAME =
  /amount|^(sum|total|price)$|[_-](sum|total|price)$|^(sum|total|price)[_-]/i;

/** Числовой параметр суммы изменяющей операции — денежный потолок (Э8). */
export function detectAmountParam(
  kind: OperationKind,
  params: readonly OperationParam[],
): string | null {
  if (kind === 'read') return null;
  const p = params.find(
    (x) =>
      (x.type === 'number' || x.type === 'integer') &&
      x.in !== 'path' &&
      AMOUNT_NAME.test(x.name),
  );
  return p?.name ?? null;
}

function linkOf(raw: unknown): LinkedOperation | null | 'bad' {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw) || typeof raw.operationId !== 'string') return 'bad';
  const params: Record<string, ValueRef> = {};
  const rp = raw.params === undefined ? {} : raw.params;
  if (!isObj(rp)) return 'bad';
  for (const [k, v] of Object.entries(rp)) {
    if (typeof v !== 'string' || !VALUE_REF_RE.test(v)) return 'bad';
    params[k] = v;
  }
  return { operationId: raw.operationId.slice(0, 100), params };
}

/**
 * Проверка связей операций (ТЗ §5-бис.15 п.14; приёмка Э8 п.6). Компенсация:
 * исходная — изменяющая; целевая есть, класса не ниже исходной; каждый её
 * параметр — известный, обязательные — все отображены; `$.request.<имя>` —
 * параметр исходной; `$.preview.*` — только при объявленном предпросмотре.
 * Предпросмотр: целевая — `read`, обязательные отображены из `$.request.*`.
 * Возвращает текст первой проблемы или null.
 */
export function checkLinks(
  op: Pick<ImportedOperation, 'operationId' | 'params'> & {
    kind: OperationKind;
    preview: LinkedOperation | null;
    compensation: LinkedOperation | null;
  },
  byId: (
    operationId: string,
  ) => { kind: OperationKind; params: OperationParam[] } | null,
): { field: 'compensation' | 'preview'; problem: string } | null {
  const own = new Set(op.params.map((p) => p.name));
  const refsOk = (
    link: LinkedOperation,
    target: { params: OperationParam[] },
    allowPreview: boolean,
  ): string | null => {
    const names = new Set(target.params.map((p) => p.name));
    for (const [k, v] of Object.entries(link.params)) {
      if (!names.has(k)) return `параметра ${k} нет у ${link.operationId}`;
      const m = /^\$\.(request|preview)\.([A-Za-z0-9_-]+)/.exec(v);
      if (!m) return `${k}: неверная ссылка`;
      if (m[1] === 'request' && !own.has(m[2])) {
        return `${k}: у ${op.operationId} нет параметра ${m[2]}`;
      }
      if (m[1] === 'preview' && !allowPreview) {
        return `${k}: $.preview без x-assist-preview`;
      }
    }
    for (const p of target.params) {
      if (p.required && !(p.name in link.params)) {
        return `обязательный параметр ${p.name} операции ${link.operationId} не отображён`;
      }
    }
    return null;
  };
  if (op.preview) {
    const t = byId(op.preview.operationId);
    if (op.kind === 'read') {
      return {
        field: 'preview',
        problem: 'предпросмотр — только у изменяющей операции',
      };
    }
    if (!t) {
      return {
        field: 'preview',
        problem: `операции ${op.preview.operationId} нет`,
      };
    }
    if (t.kind !== 'read') {
      return {
        field: 'preview',
        problem: `${op.preview.operationId} — не чтение`,
      };
    }
    const bad = refsOk(op.preview, t, false);
    if (bad) return { field: 'preview', problem: bad };
  }
  if (op.compensation) {
    const t = byId(op.compensation.operationId);
    if (op.kind === 'read') {
      return {
        field: 'compensation',
        problem: 'компенсация — только у изменяющей операции',
      };
    }
    if (!t) {
      return {
        field: 'compensation',
        problem: `компенсирующей операции ${op.compensation.operationId} нет`,
      };
    }
    if (
      op.compensation.operationId === op.operationId &&
      op.kind === 'danger'
    ) {
      // Сама себя «отменяет» только запись (вернуть прежнее значение поля).
      return {
        field: 'compensation',
        problem: 'danger не компенсируется сам собой',
      };
    }
    if (RANK[t.kind] < RANK[op.kind]) {
      return {
        field: 'compensation',
        problem: `компенсация ${op.compensation.operationId} (${t.kind}) ниже классом, чем ${op.kind}`,
      };
    }
    const bad = refsOk(op.compensation, t, !!op.preview);
    if (bad) return { field: 'compensation', problem: bad };
  }
  return null;
}

/** Похоже ли, что параметр/тело — массив идентификаторов (массовая операция). */
function hasIdArray(spec: Obj, op: Obj, params: unknown[]): boolean {
  for (const raw of params) {
    const p = resolveRef(spec, raw);
    if (!isObj(p)) continue;
    const s = resolveRef(spec, p.schema);
    if (isObj(s) && s.type === 'array' && /ids?$/i.test(String(p.name))) {
      return true;
    }
  }
  const body = resolveRef(spec, op.requestBody);
  const content = isObj(body) && isObj(body.content) ? body.content : {};
  for (const media of Object.values(content)) {
    if (!isObj(media)) continue;
    const s = resolveRef(spec, media.schema);
    if (!isObj(s)) continue;
    if (s.type === 'array') return true;
    const props = isObj(s.properties) ? s.properties : {};
    for (const [name, ps] of Object.entries(props)) {
      const r = resolveRef(spec, ps);
      if (isObj(r) && r.type === 'array' && /ids?$/i.test(name)) return true;
    }
  }
  return false;
}

/** Стоп-слова §5.2 сверх общего словаря обучалки (`danger-words.ts`). */
const DANGER_EXTRA =
  /(?<!\p{L})(refund|cancel|charge|payout|mass|bulk|purge|wipe|void|terminate|ban|block|повернен|возврат|отмен|скасув|списа|выплат|виплат|масов|массов|заблок)/iu;
/** Описание GET прямо говорит о побочном эффекте. */
const SIDE_EFFECT =
  /(?<!\p{L})(creates?|updates?|deletes?|modif(?:y|ies)|sends?|triggers?|создаё?т|изменяет|удаляет|отправляет|створює|змінює|видаляє|надсилає)(?!\p{L})/iu;

/**
 * Глагол-действие в начале operationId или целиком в последнем сегменте пути
 * GET/HEAD (`GET /users/{id}/delete`, `deleteUser`, `setWebhook`): такой GET
 * меняет данные, хоть метод и «читающий» (аудит Э7). Существительные
 * (`/refunds`, `getCancelled…`) не задеваются: проверяется первое слово
 * operationId и последний сегмент пути целиком.
 */
const GET_MUTATING_VERBS = new Set([
  'create',
  'add',
  'insert',
  'update',
  'edit',
  'modify',
  'set',
  'patch',
  'put',
  'post',
  'send',
  'trigger',
  'execute',
  'approve',
  'reject',
  'confirm',
  'publish',
  'unpublish',
  'activate',
  'deactivate',
  'enable',
  'disable',
  'reset',
  'archive',
  'restore',
  'assign',
  'unassign',
  'mark',
  'move',
  'merge',
  'close',
  'reopen',
  'subscribe',
  'unsubscribe',
  'revoke',
  'logout',
  'unblock',
]);
const GET_DESTRUCTIVE_VERBS = new Set([
  'delete',
  'remove',
  'destroy',
  'drop',
  'cancel',
  'refund',
  'charge',
  'pay',
  'payout',
  'purge',
  'wipe',
  'void',
  'terminate',
  'ban',
  'block',
]);

function getVerb(operationId: string, path: string): string | null {
  const first = words(operationId).trim().split(/\s+/)[0]?.toLowerCase();
  const last = path
    .split('/')
    .filter((x) => x && !x.startsWith('{'))
    .pop()
    ?.toLowerCase();
  for (const w of [first, last]) {
    if (w && (GET_MUTATING_VERBS.has(w) || GET_DESTRUCTIVE_VERBS.has(w))) {
      return w;
    }
  }
  return null;
}

/** `deleteOrder`, `order_cancel` → «delete Order», «order cancel». */
function words(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_./-]+/g, ' ');
}

export function classifyOperation(p: {
  method: string;
  operationId: string;
  path: string;
  summary: string | null;
  description: string | null;
  massIds: boolean;
}): { kind: OperationKind; reason: string } {
  const m = p.method.toUpperCase();
  const text = words(
    [p.operationId, p.summary ?? '', p.description ?? '', p.path].join(' '),
  );
  if (m === 'DELETE') return { kind: 'danger', reason: 'метод DELETE' };
  if (m === 'GET' || m === 'HEAD') {
    const verb = getVerb(p.operationId, p.path);
    if (verb && GET_DESTRUCTIVE_VERBS.has(verb)) {
      return { kind: 'danger', reason: `${m} с действием «${verb}»` };
    }
    if (verb) {
      return { kind: 'write', reason: `${m} с действием «${verb}»` };
    }
    if (SIDE_EFFECT.test(`${p.summary ?? ''} ${p.description ?? ''}`)) {
      return { kind: 'write', reason: 'описание говорит о побочном эффекте' };
    }
    return { kind: 'read', reason: `метод ${m}` };
  }
  if (p.massIds) {
    return { kind: 'danger', reason: 'массовая операция (массив id)' };
  }
  const kinds = dangerKindsFor(text);
  if (kinds.length || DANGER_EXTRA.test(text)) {
    return {
      kind: 'danger',
      reason: `стоп-слово в имени/описании${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    };
  }
  return { kind: 'write', reason: `метод ${m}` };
}

function operationIdOf(raw: unknown, method: string, path: string): string {
  if (typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(raw)) {
    return raw;
  }
  const slug = path
    .replace(/\{([^}]+)\}/g, 'by_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
  return `${method}_${slug || 'root'}`;
}

/**
 * Разобрать текст спецификации. `specUrl` — откуда скачана (для
 * относительного `servers[0].url`); `baseUrlOverride` — базовый URL, который
 * указал владелец (тогда `servers` не обязателен).
 */
export function parseOpenApi(
  text: string,
  opts: { specUrl?: string | null; baseUrlOverride?: string | null } = {},
): ImportedSpec {
  if (Buffer.byteLength(text, 'utf8') > OPENAPI_MAX_BYTES) {
    throw new OpenApiImportError('too_large', 'Спецификация больше 2 МБ');
  }
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new OpenApiImportError(
      'not_json',
      'Нужен OpenAPI в JSON (YAML — конвертируйте в JSON)',
    );
  }
  if (
    !isObj(spec) ||
    typeof spec.openapi !== 'string' ||
    !/^3\.\d+(\.\d+)?$/.test(spec.openapi)
  ) {
    throw new OpenApiImportError(
      'not_openapi3',
      'Это не OpenAPI 3.x (Swagger 2 — конвертируйте в OpenAPI 3)',
    );
  }
  const baseUrl = opts.baseUrlOverride
    ? normalizeBaseUrl(opts.baseUrlOverride)
    : serverUrl(
        Array.isArray(spec.servers) ? spec.servers[0] : null,
        opts.specUrl ?? null,
      );
  const info = isObj(spec.info) ? spec.info : {};
  const paths = isObj(spec.paths) ? spec.paths : {};
  const ops: ImportedOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item) || !path.startsWith('/') || path.length > 300) continue;
    const common = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      if (ops.length >= OPENAPI_MAX_OPERATIONS) {
        throw new OpenApiImportError(
          'too_many_operations',
          `Больше ${OPENAPI_MAX_OPERATIONS} операций — разделите спецификацию`,
        );
      }
      let operationId = operationIdOf(op.operationId, method, path);
      for (let i = 2; seen.has(operationId); i++) {
        operationId = `${operationIdOf(op.operationId, method, path)}_${i}`;
      }
      seen.add(operationId);
      const rawParams = [
        ...common,
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const byKey = new Map<string, OperationParam>();
      let unsupported = false;
      for (const raw of rawParams) {
        const p = paramOf(spec, raw);
        if (p === 'header') unsupported = true;
        else if (p) byKey.set(`${p.in}:${p.name}`, p);
      }
      if (method !== 'get' && method !== 'head') {
        const b = bodyParams(spec, op);
        if (b.unsupported) unsupported = true;
        for (const p of b.params) {
          // Одно имя в теле и в пути/запросе — аргумент модели неоднозначен.
          if ([...byKey.values()].some((x) => x.name === p.name)) {
            if (p.required) unsupported = true;
            continue;
          }
          byKey.set(`body:${p.name}`, p);
        }
      }
      const comp = linkOf(op['x-assist-compensation']);
      const prev = linkOf(op['x-assist-preview']);
      if (comp === 'bad') {
        throw new OpenApiImportError(
          'bad_compensation',
          `${operationId}: x-assist-compensation — { operationId, params: { имя: "$.request.…" | "$.preview.…" } }`,
        );
      }
      if (prev === 'bad') {
        throw new OpenApiImportError(
          'bad_preview',
          `${operationId}: x-assist-preview — { operationId, params: { имя: "$.request.…" } }`,
        );
      }
      const summary = clip(op.summary, 300);
      const description = clip(op.description, 1000);
      const cls = classifyOperation({
        method,
        operationId,
        path,
        summary,
        description,
        massIds: hasIdArray(spec, op, rawParams),
      });
      const params = [...byKey.values()];
      ops.push({
        operationId,
        method: method.toUpperCase(),
        path,
        summary: summary ?? clip(description, 300),
        autoKind: cls.kind,
        kindReason: cls.reason,
        params,
        unsupported,
        idempotent: op['x-assist-idempotent'] === true,
        compensation: comp,
        preview: prev,
        autoAmountParam: detectAmountParam(cls.kind, params),
      });
    }
  }
  if (ops.length === 0) {
    throw new OpenApiImportError(
      'no_operations',
      'В спецификации нет операций',
    );
  }
  // Связи операций — после разбора всех (ссылка может идти вперёд).
  const index = new Map(ops.map((o) => [o.operationId, o]));
  for (const o of ops) {
    const bad = checkLinks({ ...o, kind: o.autoKind }, (id) => {
      const t = index.get(id);
      return t ? { kind: t.autoKind, params: t.params } : null;
    });
    if (bad) {
      throw new OpenApiImportError(
        bad.field === 'compensation' ? 'bad_compensation' : 'bad_preview',
        `${o.operationId}: x-assist-${bad.field} — ${bad.problem}`,
      );
    }
  }
  return {
    title: clip(info.title, 200),
    version: spec.openapi,
    baseUrl,
    specHash: createHash('sha256').update(text).digest('hex'),
    operations: ops,
  };
}
