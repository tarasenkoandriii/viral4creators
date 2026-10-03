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
  | 'too_many_operations';

export class OpenApiImportError extends Error {
  constructor(
    readonly code: OpenApiImportCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiImportError';
  }
}

export type ParamType = 'string' | 'integer' | 'number' | 'boolean';

/** Параметр операции — то, что модель может подставить (path/query). */
export interface OperationParam {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  type: ParamType;
  enum?: Array<string | number>;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
}

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
  const t = s.type;
  const type: ParamType =
    t === 'integer' || t === 'number' || t === 'boolean' ? t : 'string';
  const out: OperationParam = {
    name: p.name,
    in: p.in,
    required: p.in === 'path' ? true : p.required === true,
    type,
  };
  if (Array.isArray(s.enum)) {
    const e = s.enum
      .filter((x) => typeof x === 'string' || typeof x === 'number')
      .slice(0, 50) as Array<string | number>;
    if (e.length) out.enum = e;
  }
  if (typeof s.maxLength === 'number') out.maxLength = s.maxLength;
  if (typeof s.minimum === 'number') out.minimum = s.minimum;
  if (typeof s.maximum === 'number') out.maximum = s.maximum;
  const d = clip(p.description, 200);
  if (d) out.description = d;
  return out;
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
      ops.push({
        operationId,
        method: method.toUpperCase(),
        path,
        summary: summary ?? clip(description, 300),
        autoKind: cls.kind,
        kindReason: cls.reason,
        params: [...byKey.values()],
        unsupported,
      });
    }
  }
  if (ops.length === 0) {
    throw new OpenApiImportError(
      'no_operations',
      'В спецификации нет операций',
    );
  }
  return {
    title: clip(info.title, 200),
    version: spec.openapi,
    baseUrl,
    specHash: createHash('sha256').update(text).digest('hex'),
    operations: ops,
  };
}
