// Вкладка «Reddit» (пакет P-R-ADM, 14.10.2026): данные — в sites-backend
// (`pub_reddit_*`, `pub_contents` платформенного продукта Publisher),
// Админка ходит туда через backend (`/admin/reddit/*` 1:1 к внутреннему
// `/internal/admin/reddit/*`, контракт — admin-reddit-internal-contract.md).
// Режим тот же, что в кабинете: только MANUAL_COPY, к Reddit никто не ходит.
//
// Логика кабинета НЕ переписывается: декодеры ответов, тела форм («только
// изменённые поля»), CAS-перебазирование, предпросмотр markdown, тексты
// причин — из копий assist (`./reddit-shared/**`, scripts/sync-admin-reddit-
// shared.mjs). Здесь — только то, чего у кабинета нет: адаптер
// `PublisherHttp` → маршруты Админки, разбор статуса/импорта/параметров и
// отказы, специфичные для актора Админки.

import { ApiRequestError, apiGet, apiGetFile, apiPatch, apiPost } from './admin-api';
import { ApiError } from './reddit-shared/kit/envelope';
import { pubRu } from './reddit-shared/i18n/publisher-ru';
import { pubContentRu } from './reddit-shared/i18n/publisher-content-ru';
import { pubRedditRu } from './reddit-shared/i18n/publisher-reddit-ru';
import { CSV_MAX_PARTS, newOpKey, type PublisherHttp, type Query } from './reddit-shared/lib/publisher/common-pure';
import { createRedditApi } from './reddit-shared/lib/publisher/reddit-api';
import { createRedditStudioApi } from './reddit-shared/lib/publisher/reddit-studio-api';
import { createContentApi } from './reddit-shared/lib/publisher/content-api';
import { createCalendarApi } from './reddit-shared/lib/publisher/calendar-api';
import { createAiApi } from './reddit-shared/lib/publisher/ai-api';
import {
  decodeParameter,
  decodeProposal,
  type ParameterProposalView,
  type ParameterView,
} from './reddit-shared/lib/publisher/core-api';
import { arr, bool, int, listPage, obj, str, strOrNull, type ListPage } from './reddit-shared/lib/publisher/decode';
import { BCP47_RE, isUncertainOutcome, type RedditErrorView } from './reddit-shared/lib/publisher/reddit-view';
import { describeStudioError } from './reddit-shared/lib/publisher/reddit-studio-view';
import type { DependentStage } from './reddit-shared/lib/publisher/states';

/** Словари кабинета (Админка — только `ru`). */
export const T = pubRu;
export const R = pubRedditRu;
export const C = pubContentRu;

// ── Адаптер PublisherHttp → /admin/reddit/{rx,cx}/* ────────────────────────

/**
 * Продукт подставляет сервер (платформенный, Р-RD-ADM-1); клиентам кабинета
 * нужен id для пути — условный, он отрезается адаптером и наружу не уходит.
 */
export const PID = 'platform';
const PREFIX = `products/${PID}/`;
const S = '[A-Za-z0-9_.:-]{1,128}';
const re = (body: string) => new RegExp(`^${body.replace(/S/g, S)}$`);

/** Раздел Reddit: суффиксы `REDDIT_ROUTES` (контракт §3, все 40; restore — Р-RD-AUD-1). */
const RX_ALLOW = [
  re('projects(/S(/(archive|restore))?)?'),
  re('communities(/S(/rules(/S/source)?)?)?'),
  re('rules/S/review'),
  re('opportunities(/S(/(excerpts|score|qualify|skip|archive))?)?'),
  re('keywords(/S)?'),
  re('briefs(/S(/(ready|archive|generate|contents))?)?'),
  re('contents/S(/(check|copy|report-publication))?'),
  re('publications'),
];

/**
 * Маршруты кабинета для Админки (контракт §4, v1.2 — 24 маршрута): контент
 * студии, отзыв согласования, источники контента (список, ручной), отзыв
 * доказательств Reddit, оффер и факты бренда платформенного продукта,
 * снятие отметки о публикации, опрос вызова `pub.reddit.draft`.
 */
const CX_ALLOW = [
  re('contents/S/versions(/S(/(submit|diff/S))?)?'),
  re('contents/S/transition'),
  re('versions/S/(qa-checks|approve)'),
  re('approvals/S/revoke'),
  re('sources'),
  re('sources/S/revoke'),
  re('offers(/S/activate)?'),
  re('brand-facts(/S/(activate|resolve|retire))?'),
  re('publications/S/transition'),
  re('ai/calls/S'),
];

/** Путь клиента кабинета (`products/<pid>/…`) → маршрут Админки или null. */
export function adminPathOf(pubPath: string): string | null {
  if (!pubPath.startsWith(PREFIX)) return null;
  const rest = pubPath.slice(PREFIX.length);
  if (rest.startsWith('reddit/')) {
    const r = rest.slice('reddit/'.length);
    return RX_ALLOW.some((x) => x.test(r)) ? `/admin/reddit/rx/${r}` : null;
  }
  return CX_ALLOW.some((x) => x.test(rest)) ? `/admin/reddit/cx/${rest}` : null;
}

export type Method = 'GET' | 'POST' | 'PATCH';
/** Сетевой слой (в тестах — подмена): путь от `/api`, query, тело. */
export type Transport = (
  method: Method,
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: Record<string, unknown>,
) => Promise<unknown>;

/** Ошибка admin-api / сети → `ApiError` кабинета (коды и `details` целы). */
export function toPubError(e: unknown): unknown {
  if (e instanceof ApiError) return e;
  if (e instanceof ApiRequestError) {
    return new ApiError(e.code ?? `http_${e.httpStatus}`, e.message, e.httpStatus, undefined, e.details);
  }
  // fetch без ответа (сеть, CORS) — TypeError.
  if (e instanceof TypeError) return new ApiError('network', 'Network error', 0);
  return e;
}

/** Query кабинета → query admin-api: пустое не уходит. */
export function queryOf(q?: Query): Record<string, string | number | undefined> | undefined {
  if (!q) return undefined;
  const out: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'number' ? v : String(v);
  }
  return out;
}

export const defaultTransport: Transport = async (method, path, query, body) => {
  try {
    if (method === 'GET') return await apiGet<unknown>(path, query);
    if (method === 'PATCH') return await apiPatch<unknown>(path, body ?? {});
    return await apiPost<unknown>(path, body ?? {});
  } catch (e) {
    throw toPubError(e);
  }
};

function notAllowed(path: string): never {
  // Адаптер не проксирует произвольный путь: только allowlist контракта.
  throw new ApiError('PUB_NOT_FOUND', `route not allowed: ${path}`, 404);
}

/**
 * `PublisherHttp` кабинета поверх маршрутов Админки: мутации — с `opKey` в
 * теле (тот же на повтор после сети, правила кабинета), CSV/раскрытие ПД —
 * не поддерживаются (их в контракте Админки нет).
 */
export function createAdminPublisherHttp(transport: Transport = defaultTransport): PublisherHttp {
  const unsupported = (what: string) => () => Promise.reject(new ApiError('PUB_NOT_FOUND', `${what} not supported`, 404));
  return {
    get: async <T>(path: string, query?: Query) => {
      const p = adminPathOf(path);
      if (!p) notAllowed(path);
      return (await transport('GET', p, queryOf(query))) as T;
    },
    send: async <T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: Record<string, unknown> = {}, opKey?: string) => {
      const p = adminPathOf(path);
      if (!p || method === 'PUT') notAllowed(path);
      return (await transport(method, p, undefined, { ...body, opKey: opKey ?? newOpKey() })) as T;
    },
    reveal: unsupported('reveal'),
    csv: unsupported('csv'),
    markdown: unsupported('markdown'),
  };
}

/** Клиенты кабинета для платформенного продукта. */
export function createRedditClients(transport: Transport = defaultTransport) {
  const http = createAdminPublisherHttp(transport);
  return {
    reddit: createRedditApi(http, PID),
    studio: createRedditStudioApi(http, PID),
    content: createContentApi(http, PID),
    calendar: createCalendarApi(http, PID),
    ai: createAiApi(http, http, PID),
    admin: createAdminRedditApi(transport),
  };
}
export type RedditClients = ReturnType<typeof createRedditClients>;

// ── Статус, настройка, параметры гейта, импорт (контракт §1, §2, §5, §6) ──

export interface GateMissingLite {
  kind: string;
  key: string;
  detail: string;
}
export interface GateLite {
  open: boolean;
  missing: GateMissingLite[];
}
export type AiGateReason = 'flag_off' | 'generator_disabled' | 'gate_closed';
export type AiMonthReason = 'ai_params_missing' | 'spend_gate_closed' | 'month_not_open' | 'cap_exhausted';
/** v1.4: гейт `ai_use` и генератор `pub.reddit.draft`. */
export interface AiGateLite extends GateLite {
  generatorEnabled: boolean;
  reason: AiGateReason | null;
}
/** v1.4: месяц AI (Kyiv) и почему он не готов. */
export interface AiMonthLite {
  month: string;
  open: boolean;
  reason: AiMonthReason | null;
  missing: GateMissingLite[];
}
export interface AdminRedditStatus {
  enabled: boolean;
  aiEnabled: boolean;
  platformSiteId: string | null;
  product: { id: string; siteId: string; kind: string; mode: string; status: string } | null;
  gate: GateLite | null;
  /** v1.4; null — нет продукта, раздел выключен или сервер старше v1.4. */
  aiGate: AiGateLite | null;
  aiMonth: AiMonthLite | null;
}

function decodeGateLite(v: unknown, where: string): GateLite {
  const o = obj(v, where);
  return {
    open: bool(o.open, `${where}.open`),
    missing: arr(
      o.missing,
      (x) => {
        const m = obj(x, `${where}.missing`);
        return {
          kind: str(m.kind, 'missing.kind'),
          key: str(m.key, 'missing.key'),
          detail: typeof m.detail === 'string' ? m.detail : '',
        };
      },
      `${where}.missing`,
    ),
  };
}

const AI_GATE_REASONS: readonly AiGateReason[] = ['flag_off', 'generator_disabled', 'gate_closed'];
const AI_MONTH_REASONS: readonly AiMonthReason[] = ['ai_params_missing', 'spend_gate_closed', 'month_not_open', 'cap_exhausted'];
const reasonOf = <T extends string>(v: unknown, list: readonly T[], where: string): T | null =>
  v === null || v === undefined ? null : (list as readonly unknown[]).includes(v) ? (v as T) : bad(where);
function bad(where: string): never {
  throw new ApiError('PUB_RESPONSE_INVALID', where, 502);
}

function decodeAiGate(v: unknown): AiGateLite | null {
  if (v === null || v === undefined) return null;
  const g = decodeGateLite(v, 'status.aiGate');
  const o = obj(v, 'status.aiGate');
  return { ...g, generatorEnabled: bool(o.generatorEnabled, 'aiGate.generatorEnabled'), reason: reasonOf(o.reason, AI_GATE_REASONS, 'aiGate.reason') };
}

function decodeAiMonth(v: unknown): AiMonthLite | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, 'status.aiMonth');
  return {
    month: str(o.month, 'aiMonth.month'),
    open: bool(o.open, 'aiMonth.open'),
    reason: reasonOf(o.reason, AI_MONTH_REASONS, 'aiMonth.reason'),
    missing: o.missing === undefined ? [] : decodeGateLite({ open: false, missing: o.missing }, 'aiMonth').missing,
  };
}

export function decodeStatus(v: unknown): AdminRedditStatus & { created?: boolean } {
  const o = obj(v, 'status');
  const p = o.product === null || o.product === undefined ? null : obj(o.product, 'status.product');
  return {
    enabled: bool(o.enabled, 'status.enabled'),
    aiEnabled: bool(o.aiEnabled, 'status.aiEnabled'),
    platformSiteId: strOrNull(o.platformSiteId ?? null, 'status.platformSiteId'),
    product: p
      ? {
          id: str(p.id, 'product.id'),
          siteId: str(p.siteId, 'product.siteId'),
          kind: str(p.kind, 'product.kind'),
          mode: str(p.mode, 'product.mode'),
          status: str(p.status, 'product.status'),
        }
      : null,
    gate: o.gate === null || o.gate === undefined ? null : decodeGateLite(o.gate, 'status.gate'),
    aiGate: decodeAiGate(o.aiGate),
    aiMonth: decodeAiMonth(o.aiMonth),
    ...(typeof o.created === 'boolean' ? { created: o.created } : {}),
  };
}

export type SectionState = 'disabled' | 'no_site' | 'no_product' | 'ready';

/** Что показать вместо раздела (контракт §1, «Экран»). */
export function sectionState(s: AdminRedditStatus): SectionState {
  if (!s.enabled) return 'disabled';
  if (!s.platformSiteId) return 'no_site';
  if (!s.product) return 'no_product';
  return 'ready';
}

/** Строка «Продукт Publisher»: при выключенном флаге сервер продукт не показывает. */
export function productLine(s: AdminRedditStatus): string {
  if (!s.enabled) return 'скрыт — раздел выключен (PUBLISHER_REDDIT_ENABLED)';
  if (!s.product) return 'не заведён';
  return `${s.product.id} · ${s.product.kind} · режим ${s.product.mode} · ${s.product.status}`;
}

export const SECTION_TEXT: Record<SectionState, string> = {
  disabled:
    'Раздел выключен: переменная PUBLISHER_REDDIT_ENABLED на assist-api (sites-backend). Включите её и перезапустите сервис — данные не теряются.',
  no_site: 'Не задан ASSIST_INTERNAL_SITE_IDS на sites-backend: неизвестен платформенный сайт для продукта Reddit.',
  no_product: 'Платформенный продукт Publisher ещё не заведён. Кнопка ниже создаст его (закрытый режим, параметры-допущения).',
  ready: 'Раздел включён, продукт заведён.',
};

// ── AI: гейт, месяц, параметры (v1.4, аудит S2-1) ─────────────────────────

const labelIn = (map: Record<string, string>, k: string) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k);

/** Недостающий пункт гейта словами (как в кабинете). */
export function gateMissingText(m: GateMissingLite): string {
  const key = m.kind === 'parameter' ? labelIn(T.params.keys, m.key) : m.key;
  // Статус параметра (`assumption` и т.п.) — словами из словаря параметров.
  const detail = !m.detail
    ? ''
    : Object.prototype.hasOwnProperty.call(T.gates.details, m.detail)
      ? labelIn(T.gates.details, m.detail)
      : labelIn(T.params.statuses, m.detail);
  return `${labelIn(T.gates.missingKinds, m.kind)}: ${key}${detail ? ` — ${detail}` : ''}`;
}

export interface AiReadiness {
  /** Генерация из Админки возможна сейчас. */
  ready: boolean;
  tone: 'success' | 'warning' | 'neutral';
  lines: string[];
}

/**
 * Готовность генерации словами: сначала флаг и генератор (честно «до
 * eval»), затем гейт `ai_use`, затем месяц AI; «месяц не открыт» ≠
 * «потолок исчерпан». Без полей v1.4 — только флаг.
 */
export function aiReadiness(s: Pick<AdminRedditStatus, 'aiEnabled' | 'aiGate' | 'aiMonth'>): AiReadiness {
  const lines: string[] = [];
  if (!s.aiEnabled || s.aiGate?.reason === 'flag_off') {
    return { ready: false, tone: 'neutral', lines: ['Генерация выключена: переменная PUBLISHER_REDDIT_AI_ENABLED на assist-api. Тексты пишутся вручную («Написать самому»).'] };
  }
  if (!s.aiGate || !s.aiMonth) return { ready: true, tone: 'neutral', lines: ['Состояние гейта AI и месяца сервер не сообщил (до v1.4).'] };
  if (!s.aiGate.generatorEnabled || s.aiGate.reason === 'generator_disabled') {
    return {
      ready: false,
      tone: 'neutral',
      lines: [`${R.briefs.ai.generator_disabled} Генератор pub.reddit.draft включается после оценки качества (eval 2.3) — до этого только ручной путь.`],
    };
  }
  let ready = true;
  if (!s.aiGate.open) {
    ready = false;
    lines.push(`Гейт «${T.gates.names.ai_use}» закрыт: утвердите параметры в блоке «AI и бюджет» ниже.`);
    lines.push(...s.aiGate.missing.map(gateMissingText));
  }
  const m = s.aiMonth;
  switch (m.reason) {
    case 'ai_params_missing':
      ready = false;
      lines.push(`Месяц AI ${m.month} не открыт: не утверждены параметры AI.`);
      break;
    case 'spend_gate_closed':
      ready = false;
      lines.push(`Месяц AI ${m.month} не открыт: закрыт гейт «${T.gates.names.spend}» — утвердите бюджет «только AI» (подсказка в карточке параметра).`);
      break;
    case 'month_not_open':
      ready = false;
      lines.push(`Месяц AI ${m.month} ещё не открыт: параметры утверждены, его откроет ближайший проход задания открытия месяца. Потрачено ничего не было.`);
      break;
    case 'cap_exhausted':
      ready = false;
      lines.push(`Потолок AI месяца ${m.month} исчерпан: генерация снова станет доступна в следующем месяце или после увеличения «${T.params.keys.ai_budget_usd_month}».`);
      break;
    default:
      lines.push(`Месяц AI ${m.month} открыт.`);
  }
  if (m.reason && m.reason !== 'month_not_open' && m.reason !== 'cap_exhausted') lines.push(...m.missing.map(gateMissingText));
  return { ready, tone: ready ? 'success' : 'warning', lines };
}

/** Ключи блока «AI и бюджет» в порядке утверждения (контракт §5 v1.4). */
export const AI_PARAM_KEYS = ['ai_budget_usd_month', 'ai_fx_rate', 'ai_unpriced_allowed', 'budget_total', 'budget_split', 'per_purchase_max'] as const;

export interface BudgetHint {
  mode: string;
  currency: string;
  months: number;
  aiMonthMinor: number | null;
  values: Record<string, unknown> | null;
}

export interface ParamHints {
  offerActiveVersion: { offerVersionId: string; version: number } | null;
  accountOwnerMemberId: string | null;
  /** v1.4: бюджет «только AI» для `budget_total`/`budget_split`/`per_purchase_max`. */
  budget: BudgetHint | null;
}
export interface AdminParams {
  items: ParameterView[];
  keys: string[];
  gate: GateLite;
  /** v1.1: подсказки значений `offer_active_version` и `responsibles`. */
  hints: ParamHints;
}

function decodeHints(v: unknown): ParamHints {
  if (v === null || v === undefined) return { offerActiveVersion: null, accountOwnerMemberId: null, budget: null };
  const o = obj(v, 'params.hints');
  const b = o.budget === null || o.budget === undefined ? null : obj(o.budget, 'hints.budget');
  const ov = o.offerActiveVersion === null || o.offerActiveVersion === undefined ? null : obj(o.offerActiveVersion, 'hints.offer');
  return {
    offerActiveVersion: ov ? { offerVersionId: str(ov.offerVersionId, 'hints.offerVersionId'), version: int(ov.version, 'hints.version') } : null,
    accountOwnerMemberId: strOrNull(o.accountOwnerMemberId ?? null, 'hints.accountOwnerMemberId'),
    budget: b
      ? {
          mode: str(b.mode, 'budget.mode'),
          currency: str(b.currency, 'budget.currency'),
          months: int(b.months, 'budget.months'),
          aiMonthMinor: b.aiMonthMinor === null || b.aiMonthMinor === undefined ? null : int(b.aiMonthMinor, 'budget.aiMonthMinor'),
          values: b.values === null || b.values === undefined ? null : obj(b.values, 'budget.values'),
        }
      : null,
  };
}

export function decodeParams(v: unknown): AdminParams {
  const o = obj(v, 'params');
  return {
    items: arr(o.items, decodeParameter, 'params.items'),
    keys: arr(o.keys, (x) => str(x, 'params.keys'), 'params.keys'),
    gate: decodeGateLite(o.gate, 'params.gate'),
    hints: decodeHints(o.hints),
  };
}

/**
 * Значение для «утвердить» из подсказок сервера (контракт §5):
 * `offer_active_version` — активный оффер; `responsibles` — владелец
 * кабинета во всех ролях (кроме «после T72»); прочие ключи — null.
 */
export function hintValue(key: string, h: ParamHints): unknown | null {
  if (key === 'offer_active_version') return h.offerActiveVersion ? { ...h.offerActiveVersion } : null;
  if (key === 'budget_total' || key === 'budget_split' || key === 'per_purchase_max') {
    const v = h.budget?.values?.[key];
    return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v));
  }
  if (key === 'responsibles') {
    return h.accountOwnerMemberId
      ? { formOwnerMemberId: h.accountOwnerMemberId, salesMemberIds: [h.accountOwnerMemberId], afterT72MemberId: null }
      : null;
  }
  return null;
}

export const IMPORT_KINDS = ['project', 'community', 'rules', 'keyword', 'opportunity'] as const;
export const IMPORT_OUTCOMES = ['created', 'exists', 'would_create', 'rejected', 'not_attempted'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];

/** Предупреждение импорта (записано не дословно — research-import.ts `ImportWarning`). */
export interface ImportWarningView {
  kind: string;
  ref: string;
  code: string;
  field?: string;
  detail?: string;
}

export interface ImportReport {
  apply: boolean;
  productId: string;
  /** false — часть строк не выполнялась (`not_attempted`), причина — `stoppedBy` (Р-RD-AUD-4). */
  complete: boolean;
  stoppedBy?: 'deadline' | 'project_rejected' | string;
  items: Array<{ kind: string; ref: string; outcome: string; id?: string; code?: string; detail?: string }>;
  /** `firstHandSource:false` — снимок без первоисточника, подтвердить нельзя (Р-RD-AUD-3). */
  blocks: Array<{ subreddit: string; now: string[]; afterReview: string[]; firstHandSource: boolean }>;
  warnings: ImportWarningView[];
  summary: Record<string, Partial<Record<string, number>>>;
}

const strs = (v: unknown, w: string) => arr(v, (x) => str(x, w), w);

export function decodeImportReport(v: unknown): ImportReport {
  const o = obj(v, 'importReport');
  const sum = obj(o.summary, 'importReport.summary');
  const summary: ImportReport['summary'] = {};
  for (const [k, x] of Object.entries(sum)) {
    const row = obj(x, `summary.${k}`);
    summary[k] = {};
    for (const [oc, n] of Object.entries(row)) summary[k][oc] = int(n, `summary.${k}.${oc}`);
  }
  return {
    apply: bool(o.apply, 'importReport.apply'),
    productId: str(o.productId, 'importReport.productId'),
    // Старый сервер полей не присылал — отчёт считается полным, без предупреждений.
    complete: o.complete === undefined ? true : bool(o.complete, 'importReport.complete'),
    ...(typeof o.stoppedBy === 'string' ? { stoppedBy: o.stoppedBy } : {}),
    warnings:
      o.warnings === undefined
        ? []
        : arr(
            o.warnings,
            (x) => {
              const w = obj(x, 'importReport.warning');
              return {
                kind: str(w.kind, 'warning.kind'),
                ref: str(w.ref, 'warning.ref'),
                code: str(w.code, 'warning.code'),
                ...(typeof w.field === 'string' ? { field: w.field } : {}),
                ...(typeof w.detail === 'string' ? { detail: w.detail } : {}),
              };
            },
            'importReport.warnings',
          ),
    items: arr(
      o.items,
      (x) => {
        const it = obj(x, 'importReport.item');
        return {
          kind: str(it.kind, 'item.kind'),
          ref: str(it.ref, 'item.ref'),
          outcome: str(it.outcome, 'item.outcome'),
          ...(typeof it.id === 'string' ? { id: it.id } : {}),
          ...(typeof it.code === 'string' ? { code: it.code } : {}),
          ...(typeof it.detail === 'string' ? { detail: it.detail } : {}),
        };
      },
      'importReport.items',
    ),
    blocks: arr(
      o.blocks,
      (x) => {
        const b = obj(x, 'importReport.block');
        return {
          subreddit: str(b.subreddit, 'block.subreddit'),
          now: strs(b.now, 'block.now'),
          afterReview: strs(b.afterReview, 'block.afterReview'),
          firstHandSource: b.firstHandSource === undefined ? true : bool(b.firstHandSource, 'block.firstHandSource'),
        };
      },
      'importReport.blocks',
    ),
    summary,
  };
}

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  project: 'Проект',
  community: 'Сообщества',
  rules: 'Снимки правил',
  keyword: 'Запросы',
  opportunity: 'Возможности',
};
export const IMPORT_OUTCOME_LABELS: Record<ImportOutcome, string> = {
  created: 'создано',
  exists: 'уже есть',
  would_create: 'будет создано',
  rejected: 'отклонено',
  not_attempted: 'не выполнялось',
};

/** Коды строк отчёта (research-import.ts) — словами. */
export const IMPORT_CODE_LABELS: Record<string, string> = {
  kept_current: 'оставлен текущий снимок (новый из CSV не создан)',
  topics_merged: 'сегмент добавлен в темы',
  topics_pending: 'сегмент будет добавлен в темы',
  topics_not_merged: 'сегмент не добавлен в темы',
  other_actor: 'уже выполнено другим оператором',
  other_project: 'сообщество в другом проекте',
  community_missing: 'сообщества нет ни в CSV, ни в разделе',
  deadline: 'не хватило времени запроса — повторите',
  project_rejected: 'проект не создан',
};

/** Вид предупреждения импорта: виды строк и `file` (весь файл CSV). */
export const IMPORT_WARNING_KIND_LABELS: Record<ImportKind | 'file', string> = {
  ...IMPORT_KIND_LABELS,
  file: 'Файл',
};

const pick = (map: Record<string, string>, k: string, fallback: string) =>
  Object.prototype.hasOwnProperty.call(map, k) ? map[k] : fallback;

/**
 * `detail` строки `kept_current` (research-import.ts: `<reviewState>` и
 * `; differs: promotion A, csv B; links C, csv D`) — по-русски. Неизвестное
 * не выводится сырым английским: «значение не распознано».
 */
export function keptCurrentText(detail: string | undefined): string {
  if (!detail) return '';
  const [state, ...rest] = detail.split('; ');
  const out = [`текущий снимок: ${pick(R.rules.states, state, 'проверка не распознана')}`];
  rest.forEach((raw, i) => {
    const part = i === 0 ? raw.replace(/^differs:\s*/, '') : raw;
    const m = /^(promotion|links) (\S+), csv (\S+)$/.exec(part);
    if (!m) {
      out.push('есть расхождение с CSV');
      return;
    }
    const [field, dict] =
      m[1] === 'promotion' ? [R.rules.fields.promotionPolicy, R.rules.promotion] : [R.rules.fields.linksPolicy, R.rules.links];
    const v = (k: string) => pick(dict, k, 'значение не распознано');
    out.push(`${field}: в снимке «${v(m[2])}», в CSV «${v(m[3])}»`);
  });
  return out.join('; ');
}

/**
 * Гейт и подсказка о первоисточнике в отчёте — про снимок из CSV; у
 * сообществ, где оставлен текущий снимок (`kept_current`), такого снимка
 * нет — блок не показывается.
 */
export function importBlocksShown(r: Pick<ImportReport, 'blocks' | 'items'>): ImportReport['blocks'] {
  const kept = new Set(r.items.filter((x) => x.kind === 'rules' && x.code === 'kept_current').map((x) => x.ref));
  return r.blocks.filter((b) => !kept.has(`r/${b.subreddit}`));
}

/** Предупреждения импорта — словами. */
export const IMPORT_WARNING_LABELS: Record<string, string> = {
  sanitized: 'убрано похожее на контакт',
  clipped: 'обрезано до лимита',
  dropped_conditions: 'отброшены условия правил',
  enum_default: 'значение вне списка заменено',
  flair_unparsed: 'флейр не распознан (оставлен «неизвестно»)',
  dropped_columns: 'колонки CSV не переносятся',
  merged: 'дубль сообщества: правила взяты из первой строки',
};

/**
 * Итог применения (аудит ui-2, Р-RD-AUD-4): проект не создан или импорт не
 * завершён — предупреждение, а не «Импорт применён».
 */
export function importApplyNotice(r: ImportReport): { tone: 'success' | 'warning'; text: string } {
  const projectRejected = r.items.some((x) => x.kind === 'project' && x.outcome === 'rejected');
  if (projectRejected || r.stoppedBy === 'project_rejected')
    return {
      tone: 'warning',
      text: 'Проект не создан — импорт не применён, ничего не записано. Проверьте название (до 120 символов) и рынок (до 64), затем постройте план заново.',
    };
  if (!r.complete)
    return {
      tone: 'warning',
      text:
        r.stoppedBy === 'deadline'
          ? 'Импорт применён частично: не хватило времени запроса, часть строк не выполнялась («не выполнялось»). Нажмите «Применить» ещё раз — созданное станет «уже есть», остаток допишется.'
          : 'Импорт применён частично: часть строк не выполнялась. Повторите применение.',
    };
  return { tone: 'success', text: 'Импорт применён. Повтор безопасен: существующее останется «уже есть».' };
}

/** Строки сводки отчёта: вид × исход, только ненулевые, в порядке контракта. */
export function importSummaryRows(r: ImportReport): Array<{ kind: string; label: string; cells: Array<[string, number]> }> {
  const kinds = [...IMPORT_KINDS, ...Object.keys(r.summary).filter((k) => !(IMPORT_KINDS as readonly string[]).includes(k))];
  return kinds
    .filter((k) => r.summary[k])
    .map((k) => {
      const row = r.summary[k] ?? {};
      const outs = [...IMPORT_OUTCOMES, ...Object.keys(row).filter((x) => !(IMPORT_OUTCOMES as readonly string[]).includes(x))];
      return {
        kind: k,
        label: (IMPORT_KIND_LABELS as Record<string, string>)[k] ?? k,
        cells: outs.filter((x) => (row[x] ?? 0) > 0).map((x) => [(IMPORT_OUTCOME_LABELS as Record<string, string>)[x] ?? x, row[x] ?? 0] as [string, number]),
      };
    })
    .filter((x) => x.cells.length > 0);
}

export interface ImportForm {
  communitiesCsv: string;
  opportunitiesCsv: string;
  keywordsCsv: string;
  projectTitle: string;
  locale: string;
  market: string;
  segment: string;
}
export const emptyImportForm = (): ImportForm => ({
  communitiesCsv: '',
  opportunitiesCsv: '',
  keywordsCsv: '',
  projectTitle: '',
  locale: 'en',
  market: '',
  segment: '',
});

/** Предел тела импорта (контракт §6): 1 МБ сериализованного JSON. */
export const IMPORT_MAX_BYTES = 1024 * 1024;

/**
 * Чтение одного CSV импорта в браузере (аудит ui-4, ui-5): файл больше
 * 1 МБ или не прочитанный — отказ (форма сбрасывает поле, а не держит
 * прошлый файл); байты — строго UTF-8 (`fatal`), иначе Windows-1251 из
 * Excel молча превратился бы в «�». BOM снимается.
 */
export type ImportFileRead = { ok: true; text: string; lines: number } | { ok: false; error: string };

const fileLabel = (name: string) => (name.length > 80 ? `${name.slice(0, 80)}…` : name);

export const IMPORT_FILE_TEXT = {
  tooLarge: (name: string) => `Файл «${fileLabel(name)}» больше 1 МБ — разделите исследование на части.`,
  encoding: (name: string) =>
    `Файл «${fileLabel(name)}» не в кодировке UTF-8 (так бывает, если Excel сохранил «CSV (разделители — запятые)» в Windows-1251). ` +
    'Сохраните его как «CSV UTF-8 (разделители — запятые)» и выберите снова.',
  unreadable: (name: string) => `Файл «${fileLabel(name)}» не прочитан — выберите его ещё раз.`,
};

/** Байты файла → текст UTF-8 или отказ словами. */
export function decodeImportFile(name: string, bytes: ArrayBuffer | Uint8Array): ImportFileRead {
  if (bytes.byteLength > IMPORT_MAX_BYTES) return { ok: false, error: IMPORT_FILE_TEXT.tooLarge(name) };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: IMPORT_FILE_TEXT.encoding(name) };
  }
  return { ok: true, text, lines: text.split(/\r?\n/).filter(Boolean).length };
}

/** Выбранный файл (`File`): размер — до чтения, затем `decodeImportFile`. */
export async function readImportFile(file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }): Promise<ImportFileRead> {
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, error: IMPORT_FILE_TEXT.tooLarge(file.name) };
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { ok: false, error: IMPORT_FILE_TEXT.unreadable(file.name) };
  }
  return decodeImportFile(file.name, bytes);
}

export type ImportIssue = 'communities' | 'title' | 'locale' | 'market' | 'segment' | 'size';
export const IMPORT_ISSUE_TEXT: Record<ImportIssue, string> = {
  communities: 'Нужен CSV сообществ (файл …-communities.csv).',
  title: 'Название проекта: 1–120 символов (как у проекта).',
  locale: 'Язык — код BCP-47 вида en или en-US.',
  market: 'Рынок: 1–64 символа (как у проекта).',
  segment: 'Метка сегмента: 1–40 знаков — латиница, цифры, «_» и «-» (как у сервера).',
  size: 'Три файла вместе больше 1 МБ — разделите исследование на части.',
};

const len = (s: string) => [...s].length;
/** Поля проекта в импорте — как у создания проекта (sites-backend projects.service). */
export const IMPORT_TITLE_MAX = 120;
export const IMPORT_MARKET_MAX = 64;
export const SEGMENT_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function importBody(f: ImportForm): { body: Record<string, string> | null; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  if (!f.communitiesCsv.trim()) issues.push('communities');
  const title = f.projectTitle.trim();
  // Аудит ui-2: границы — как у создания проекта (projectBody, сервер 120/64).
  if (!title || len(title) > IMPORT_TITLE_MAX) issues.push('title');
  const locale = f.locale.trim();
  if (!BCP47_RE.test(locale) || len(locale) > 16) issues.push('locale');
  const market = f.market.trim();
  if (!market || len(market) > IMPORT_MARKET_MAX) issues.push('market');
  const segment = f.segment.trim();
  // Контракт §6 и сервер: `^[A-Za-z0-9_-]{1,40}$` (пусто — по умолчанию 'admin').
  if (segment && !SEGMENT_RE.test(segment)) issues.push('segment');
  const body: Record<string, string> = {
    communitiesCsv: f.communitiesCsv,
    opportunitiesCsv: f.opportunitiesCsv,
    keywordsCsv: f.keywordsCsv,
    projectTitle: title,
    locale,
    market,
    ...(segment ? { segment } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > IMPORT_MAX_BYTES) issues.push('size');
  return { body: issues.length ? null : body, issues };
}

/** «Применить» — только тот же набор, что прошёл предпросмотр. */
export function importFingerprint(body: Record<string, string> | null): string {
  return body ? JSON.stringify(body) : '';
}

// ── Параметры гейта ───────────────────────────────────────────────────────

export function paramDraft(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}

export function parseParamValue(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export type DecideStatus = 'approved' | 'rejected' | 'revoked' | 'assumption';
export interface DecideForm {
  toStatus: DecideStatus;
  proposalId: string;
  basis: string;
  stages: DependentStage[];
}

/** Тело решения: основание ≥ 10 знаков (контракт §5), ревизия — CAS. */
export function decideBody(
  p: Pick<ParameterView, 'revision'>,
  f: DecideForm,
): {
  toStatus: DecideStatus;
  proposalId: string | null;
  basis: string;
  dependentStages: DependentStage[];
  expectedRevision: number;
} | null {
  const basis = f.basis.trim();
  if (len(basis) < 10 || len(basis) > 2000) return null;
  const pid = f.proposalId.trim();
  if (pid && !/^[A-Za-z0-9_-]{1,64}$/.test(pid)) return null;
  return {
    toStatus: f.toStatus,
    proposalId: pid || null,
    basis,
    dependentStages: [...f.stages],
    expectedRevision: p.revision,
  };
}

export function createAdminRedditApi(transport: Transport = defaultTransport) {
  const key = (k: string) => {
    if (!/^[a-z_]{1,64}$/.test(k)) throw new ApiError('PUB_NOT_FOUND', 'bad key', 404);
    return k;
  };
  return {
    status: async () => decodeStatus(await transport('GET', '/admin/reddit/status')),
    setup: async () => decodeStatus(await transport('POST', '/admin/reddit/setup', undefined, {})),
    params: async () => decodeParams(await transport('GET', '/admin/reddit/params')),
    proposals: async (k: string): Promise<ListPage<ParameterProposalView>> =>
      listPage(await transport('GET', `/admin/reddit/params/${key(k)}/proposals`, { status: 'open', limit: 20 }), decodeProposal),
    propose: async (k: string, value: unknown, opKey: string) => {
      const o = obj(await transport('POST', `/admin/reddit/params/${key(k)}/propose`, undefined, { opKey, value }), 'propose');
      return { proposalId: str(o.proposalId, 'proposalId'), parameter: decodeParameter(o.parameter) };
    },
    decide: async (k: string, body: NonNullable<ReturnType<typeof decideBody>>, opKey: string) => {
      const o = obj(await transport('POST', `/admin/reddit/params/${key(k)}/decide`, undefined, { opKey, ...body }), 'decide');
      return { version: int(o.version, 'decide.version'), parameter: decodeParameter(o.parameter) };
    },
    importPlan: async (body: Record<string, string>) =>
      decodeImportReport(await transport('POST', '/admin/reddit/import/plan', undefined, body)),
    importApply: async (body: Record<string, string>) =>
      decodeImportReport(await transport('POST', '/admin/reddit/import/apply', undefined, body)),
  };
}

// ── Выгрузки CSV (backend отдаёт файлом) ───────────────────────────────────

export const CSV_LISTS = {
  projects: 'rx/projects',
  communities: 'rx/communities',
  opportunities: 'rx/opportunities',
  keywords: 'rx/keywords',
  briefs: 'rx/briefs',
  publications: 'rx/publications',
  sources: 'cx/sources',
  'brand-facts': 'cx/brand-facts',
} as const;
export type CsvList = keyof typeof CSV_LISTS;

/** Имя файла из `Content-Disposition` (только безопасные символы) или своё. */
export function csvFilenameOf(disposition: string, list: CsvList): string {
  const m = /filename="?([A-Za-z0-9._-]{1,100}\.csv)"?/i.exec(disposition);
  return m ? m[1] : `reddit-${list}.csv`;
}

export type FileGet = typeof apiGetFile;

/** Часть выгрузки: `text/csv` — файл; конверт со строкой — тоже; иначе ошибка. */
function csvPart(res: Awaited<ReturnType<FileGet>>): string {
  if (res.status < 400 && /^text\/csv\b/i.test(res.contentType)) return res.text;
  let body: { success?: boolean; data?: unknown; error?: { code?: string; message?: string; details?: unknown } } | null = null;
  try {
    body = JSON.parse(res.text);
  } catch {
    body = null;
  }
  if (body?.success === true && typeof body.data === 'string') return body.data;
  const err = body?.error;
  const details = err?.details && typeof err.details === 'object' && !Array.isArray(err.details) ? (err.details as Record<string, unknown>) : undefined;
  throw new ApiError(typeof err?.code === 'string' ? err.code : `http_${res.status}`, err?.message ?? 'CSV expected', res.status >= 400 ? res.status : 502, undefined, details);
}

export interface CsvResult {
  filename: string;
  text: string;
  /** Частей склеено (курсор `X-Next-Before`, до 5000 строк на часть). */
  parts: number;
  /** Склейка остановлена на пределе `CSV_MAX_PARTS` — файл НЕ полный. */
  truncated: boolean;
}

/**
 * Выгрузка списка `?format=csv` с текущим фильтром — по образцу `csvAll`
 * кабинета: при `X-Next-Before` дочитываются следующие части
 * (`?before=<курсор>`), у них отрезается строка заголовка; на пределе
 * `CSV_MAX_PARTS` (20) файл помечается неполным (экран предупреждает).
 */
/**
 * Текст CSV для файла у оператора: с BOM (`U+FEFF`), иначе Excel открывает
 * UTF-8 как ANSI и кириллица — «кракозябры» (аудит ui-11; как
 * `downloadCsv` кабинета). Сервер BOM не ставит: `fetch().text()` снимает
 * его при декодировании, а точный текст ответа — контракт тестов.
 */
export function csvFileText(text: string): string {
  return text.startsWith('﻿') ? text : `﻿${text}`;
}

export async function fetchCsv(list: CsvList, query: Query = {}, get: FileGet = apiGetFile): Promise<CsvResult> {
  const path = `/admin/reddit/${CSV_LISTS[list]}`;
  const base = { ...queryOf(query), format: 'csv' };
  const call = async (before?: string) => {
    try {
      return await get(path, before ? { ...base, before } : base);
    } catch (e) {
      throw toPubError(e);
    }
  };
  const first = await call();
  let text = csvPart(first);
  let next = first.nextBefore ?? null;
  let parts = 1;
  while (next && parts < CSV_MAX_PARTS) {
    const res = await call(next);
    const body = csvPart(res).replace(/^[^\n]*\n?/, '');
    if (body) text = `${text.replace(/\n?$/, '\n')}${body}`;
    next = res.nextBefore ?? null;
    parts++;
  }
  return { filename: csvFilenameOf(first.disposition, list), text, parts, truncated: !!next };
}

// ── Ошибки словами (кабинет + отказы актора Админки) ───────────────────────

const ADMIN_ERRORS = {
  productNone: 'Платформенный продукт не заведён — откройте «Статус и настройка» и нажмите «Завести продукт».',
  adminScope: 'Это действие недоступно из Админки (только раздел Reddit и его материалы).',
  adminTransition: 'Из Админки доступны переходы «вернуть на доработку» и «снять с плана»; прочие — в кабинете.',
  siteNotConfigured: 'Не задан ASSIST_INTERNAL_SITE_IDS на sites-backend — продукт завести нельзя.',
  siteMissing: 'Платформенного сайта из ASSIST_INTERNAL_SITE_IDS нет в базе sites-backend.',
  actor: 'Backend не передал оператора (X-Admin-Actor) — войдите в Админку заново.',
  tooLarge: 'Тело больше 1 МБ — разделите импорт на части.',
  notFound: 'Не найдено: запись удалена, принадлежит другому продукту, раздел выключен или маршрут ещё не открыт для Админки.',
  upstreamTimeout: 'Бэкенд клиентских сайтов не ответил вовремя.',
  retrySafe: 'Результат неизвестен — повтор безопасен: повторите то же действие, сервер не выполнит его дважды (тот же ключ операции).',
};

/**
 * Ошибка → заголовок и строки: `describeStudioError` кабинета (причины P-R,
 * WARN, блокеры словами) и поверх — отказы, которые бывают только у Админки
 * (контракт §0 «Общие ошибки»).
 */
export function describeAdminRedditError(
  e: unknown,
  statusLabels: Record<string, string> = {},
  opts: { mutation?: boolean } = {},
): RedditErrorView {
  const v = adminErrorView(e, statusLabels);
  // Р-RD-AUD-7: только у действия (`useMutation` сохранил ключ операции) и
  // только при неизвестном исходе (сеть, 502/503/504 без прикладного кода,
  // `UPSTREAM_TIMEOUT`). У загрузчиков (GET) ключа нет — им хватает кнопки
  // «Повторить»; 503 «раздел не подключён» — исход известен, нужна настройка.
  const mutation = opts.mutation ?? isMutationError(e);
  const safe =
    mutation &&
    v.retryable &&
    isUncertainOutcome(e) &&
    !(e instanceof ApiError && e.code === 'SERVICE_UNAVAILABLE') &&
    !v.lines.includes(ADMIN_ERRORS.retrySafe);
  return safe ? { ...v, lines: [...v.lines, ADMIN_ERRORS.retrySafe] } : v;
}

/** Ошибки действий `useMutation` (ключ операции сохранён) — см. выше. */
const mutationErrors = new WeakSet<object>();
export function markMutationError(e: unknown): void {
  if (e !== null && typeof e === 'object') mutationErrors.add(e);
}
function isMutationError(e: unknown): boolean {
  return e !== null && typeof e === 'object' && mutationErrors.has(e);
}

function adminErrorView(e: unknown, statusLabels: Record<string, string>): RedditErrorView {
  const v = describeStudioError(e, T, R, statusLabels);
  if (!(e instanceof ApiError)) return v;
  const d = (e.details ?? {}) as Record<string, unknown>;
  const only = (title: string, lines: string[] = []): RedditErrorView => ({ ...v, title, lines, conflict: false });
  if (e.code === 'PUB_PRODUCT_NONE') return only(ADMIN_ERRORS.productNone);
  if (e.code === 'ADMIN_ACTOR_REQUIRED') return only(ADMIN_ERRORS.actor);
  if (e.code === 'PUB_PAYLOAD_TOO_LARGE' || e.status === 413) return only(ADMIN_ERRORS.tooLarge);
  if (d.reason === 'admin_scope') {
    return only(
      e.code === 'PUB_TRANSITION_INVALID' ? ADMIN_ERRORS.adminTransition : ADMIN_ERRORS.adminScope,
      typeof d.action === 'string' ? [`${T.common.id}: ${d.action}`] : [],
    );
  }
  if (e.code === 'PUB_CONFLICT' && d.reason === 'platform_site_not_configured') return only(ADMIN_ERRORS.siteNotConfigured);
  if (e.code === 'PUB_CONFLICT' && d.reason === 'platform_site_missing') return only(ADMIN_ERRORS.siteMissing);
  if (e.code === 'PUB_NOT_FOUND' && !v.lines.length) return { ...v, lines: [ADMIN_ERRORS.notFound] };
  if (e.code === 'UPSTREAM_TIMEOUT') return only(ADMIN_ERRORS.upstreamTimeout);
  // Ответ backend (503 «не подключено», 502 «вернул ошибку») — его текст точнее.
  if (!e.code.startsWith('PUB_') && e.code !== 'network' && e.message) return only(e.message);
  return v;
}

// ── Значения в панели конфликтов ──────────────────────────────────────────

/**
 * Значение поля для панели «на сервере / ваше» (аудит S3-R2-1): строки и
 * числа — как есть; объекты с `text` (тезисы брифа) — их текст; прочие
 * объекты — JSON; списки — через «; » (объекты) или «, » (строки).
 */
export function conflictValueText(x: unknown): string {
  const one = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'object') return String(v);
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    return JSON.stringify(v);
  };
  if (Array.isArray(x)) return x.map(one).join(x.some((v) => v && typeof v === 'object') ? '; ' : ', ');
  return one(x);
}

// ── Согласование Reddit-материала ─────────────────────────────────────────

/**
 * Id активного согласования для отзыва. Основной путь (контракт v1.3) —
 * `approval` вида материала: активное согласование утверждённой версии
 * сервера. Запасные пути (сервер старше v1.3 — поля нет): запомненный ответ
 * `approve` этой версии, затем `approvalId` отметки о публикации той же
 * версии; иначе null. `approval: null` от сервера — активного согласования
 * нет (отозвано/истекло): запасные пути тогда не используются.
 */
export function approvalIdOf(
  m: {
    approvedVersion: { id: string } | null;
    approval?: { id: string; versionId: string } | null;
    publications: Array<{ versionId: string; approvalId: string | null }>;
  },
  remembered: Readonly<Record<string, string>>,
): string | null {
  const v = m.approvedVersion?.id;
  if (!v) return null;
  if (m.approval !== undefined) {
    return m.approval && m.approval.versionId === v ? m.approval.id : null;
  }
  if (remembered[v]) return remembered[v];
  return m.publications.find((p) => p.versionId === v && p.approvalId)?.approvalId ?? null;
}

// ── Прочее ────────────────────────────────────────────────────────────────

/** Актор Админки — `admin:<userId>` (Р-RD-ADM-2): «это сделал я». */
export function isOwnActor(actor: string | null | undefined, userId: string | null | undefined): boolean {
  return !!actor && !!userId && (actor === `admin:${userId}` || actor === userId);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return R.common.none;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export const REDDIT_TABS = [
  { key: 'setup', label: 'Статус и настройка' },
  { key: 'import', label: 'Импорт' },
  { key: 'projects', label: R.tabs.projects },
  { key: 'communities', label: 'Сообщества и правила' },
  { key: 'opportunities', label: R.tabs.opportunities },
  { key: 'keywords', label: R.tabs.keywords },
  { key: 'briefs', label: R.tabs.briefs },
  { key: 'studio', label: 'Студия' },
  { key: 'publications', label: R.tabs.publications },
] as const;
export type RedditTabKey = (typeof REDDIT_TABS)[number]['key'];

export interface RedditRoute {
  tab: RedditTabKey;
  /** Выбранный проект (фильтр вкладок). */
  project: string;
  /** Карточка: сообщество / возможность / бриф / материал студии. */
  id: string;
  /** Брифы: создать бриф к этой возможности (переход из её карточки). */
  opp: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `?tab=&project=&id=` → маршрут вкладки; мусор отбрасывается. */
export function parseRedditRoute(search: string): RedditRoute {
  const q = new URLSearchParams(search);
  const tab = q.get('tab') ?? '';
  const ok = REDDIT_TABS.some((t) => t.key === tab);
  const pick = (k: string) => {
    const v = q.get(k) ?? '';
    return ID_RE.test(v) ? v : '';
  };
  return {
    tab: ok ? (tab as RedditTabKey) : 'setup',
    project: pick('project'),
    id: ok ? pick('id') : '',
    opp: ok && tab === 'briefs' ? pick('opp') : '',
  };
}

export function redditRouteSearch(r: RedditRoute): string {
  const q = new URLSearchParams();
  q.set('tab', r.tab);
  if (r.project) q.set('project', r.project);
  if (r.id) q.set('id', r.id);
  if (r.opp && r.tab === 'briefs') q.set('opp', r.opp);
  return `?${q.toString()}`;
}
