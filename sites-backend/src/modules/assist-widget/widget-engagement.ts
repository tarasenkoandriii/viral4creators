/**
 * Строгий разбор публичных тел Э3 виджета — W (ТЗ §4.16, §5-тер.1,
 * §5-тер.14, §3-бис.2 `identify`). Чистые функции (без Nest и базы): их
 * зовут контроллеры `widget-public` и `widget-engagement` и спеки.
 *
 * Правило: всё, что пришло со СТРАНИЦЫ заказчика или из iframe, — данные
 * посетителя. Белый список полей: неизвестное поле — отказ (400), а не
 * «тихо отбросить» — иначе загрузчик с ошибкой версии копил бы мусор в
 * счётчиках. Исключение — `identity` (`V4CAssist('identify')`): её режем
 * до формы `WidgetIdentity` (поле за полем), это подсказка страницы.
 */
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import {
  SERVER_EVENT_KINDS,
  WIDGET_EVENT_KINDS,
  type WidgetEventKind,
} from '../assist-analytics/public/event-counts.service';
import type { ElementDescriptor } from '../assist-analytics/goal-types';
import type { WidgetIdentity } from '../assist-site-chat/chat-types';
import type { WidgetEventBatch, WidgetGoalPickRequest } from './api-types';

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Только перечисленные ключи (неизвестный — false). */
function onlyKeys(o: Obj, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** Ключ триггера/сценария — как ENGAGEMENT_KEY (T, engagement-config.ts). */
export const ENGAGEMENT_KEY_RE = /^[a-z0-9_-]{1,32}$/;
/** Ключ цели — как GOAL_KEY (A, goal-types.ts). */
export const GOAL_KEY_RE = /^[a-z0-9_-]{1,40}$/;
/** orderId — как ORDER_ID (A): e-mail/телефон в нём не пройдут (§5-тер.16 п.1). */
export const ORDER_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** docId загрузчика — случайный id документа (дедуп «раз на документ»). */
export const DOC_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PK_RE = /^[A-Za-z0-9_]{8,80}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_PATH = 512;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;

/** Строка-данные: без управляющих символов, обрезка пробелов, ≤ max, иначе null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL, ' ').trim();
  if (!t || t.length > max) return null;
  return t;
}

/** Путь страницы: `/…`, без query и якоря, ≤ 512 (§6.6 — query бывает с e-mail). */
export function cleanPath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > MAX_PATH) {
    return null;
  }
  return /[?#\s]/.test(v) || HAS_CONTROL.test(v) ? null : v;
}

/**
 * Тело маршрута страницы: JSON-объект или text/plain-строка от
 * `navigator.sendBeacon` (app.setup.ts разбирает её строкой ≤ 4 КБ). Размер
 * — ≤ eventBodyMaxBytes по любому из признаков (заголовок и сериализация).
 */
export function pageBody(
  body: unknown,
  contentLength: string | undefined,
): Obj | null {
  const max = ANALYTICS_DEFAULTS.eventBodyMaxBytes;
  const declared = contentLength !== undefined ? Number(contentLength) : 0;
  if (Number.isFinite(declared) && declared > max) return null;
  let parsed: unknown = body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > max) return null;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  } else if (isObj(body)) {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > max) return null;
  }
  return isObj(parsed) ? parsed : null;
}

/**
 * Пакет счётчиков `POST /widget/v1/event` (§4.16): `{ pk, events: [{ kind,
 * key }] }`, 1…eventsPerBatch событий, вид — из белого списка A, ключ —
 * формат ENGAGEMENT_KEY или null. Любое отклонение — null (400 EVENT_INVALID).
 */
export function parseEventBatch(raw: unknown): WidgetEventBatch | null {
  if (!isObj(raw) || !onlyKeys(raw, ['pk', 'events'])) return null;
  if (typeof raw.pk !== 'string' || !PK_RE.test(raw.pk)) return null;
  const list = raw.events;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > ANALYTICS_DEFAULTS.eventsPerBatch
  ) {
    return null;
  }
  const events: WidgetEventBatch['events'] = [];
  for (const e of list) {
    if (!isObj(e) || !onlyKeys(e, ['kind', 'key'])) return null;
    if (
      !(WIDGET_EVENT_KINDS as readonly unknown[]).includes(e.kind) ||
      (SERVER_EVENT_KINDS as readonly unknown[]).includes(e.kind)
    ) {
      return null;
    }
    const key = e.key === undefined ? null : e.key;
    if (
      key !== null &&
      (typeof key !== 'string' || !ENGAGEMENT_KEY_RE.test(key))
    ) {
      return null;
    }
    events.push({ kind: e.kind as WidgetEventKind, key });
  }
  return { pk: raw.pk, events };
}

/** Ключи вовлечения ОПУБЛИКОВАННОГО вида (включённые триггеры и сценарии). */
export interface EngagementKeys {
  triggers: Set<string>;
  scenarios: Set<string>;
}

/**
 * Ключи из опубликованной конфигурации вида — оборонительно, без строгого
 * разбора T (его проверил разбор при публикации): нужен только ответ «есть
 * ли такой включённый ключ» — для `openedBy`, счётчиков и сценария передачи.
 */
export function engagementKeys(
  published: Record<string, unknown> | null,
): EngagementKeys {
  const out: EngagementKeys = { triggers: new Set(), scenarios: new Set() };
  const e = published?.engagement;
  if (!isObj(e)) return out;
  const take = (list: unknown, into: Set<string>) => {
    if (!Array.isArray(list)) return;
    for (const x of list.slice(0, 50)) {
      if (
        isObj(x) &&
        x.enabled === true &&
        typeof x.key === 'string' &&
        ENGAGEMENT_KEY_RE.test(x.key)
      ) {
        into.add(x.key);
      }
    }
  };
  take(e.triggers, out.triggers);
  take(e.scenarios, out.scenarios);
  return out;
}

/**
 * Счётчики, которые стоит писать: ключ вида proactive_* — включённый
 * триггер, scenario_* — включённый сценарий, у прочих видов ключа нет.
 * Чужой ключ (вид мог смениться за 5 мин кэша конфига) — отбрасываем, а не
 * 400: иначе строки счётчиков можно было бы плодить выдуманными ключами.
 */
export function countableEvents(
  events: WidgetEventBatch['events'],
  keys: EngagementKeys,
): WidgetEventBatch['events'] {
  return events.filter((e) => {
    if (e.kind.startsWith('proactive_')) {
      return e.key !== null && keys.triggers.has(e.key);
    }
    if (e.kind.startsWith('scenario_')) {
      return e.key !== null && keys.scenarios.has(e.key);
    }
    return e.key === null;
  });
}

/**
 * `openedBy` нового диалога (§5-тер.12 п.10): `user` | `proactive:<ключ>` |
 * `scenario:<ключ>`; ключ — из опубликованной конфигурации вовлечения.
 * Неверное — null (вопрос посетителя из-за подписи не отвергаем).
 */
export function cleanOpenedBy(
  raw: unknown,
  keys: () => EngagementKeys,
): string | null {
  if (raw === 'user') return 'user';
  if (typeof raw !== 'string') return null;
  const m = /^(proactive|scenario):([a-z0-9_-]{1,32})$/.exec(raw);
  if (!m) return null;
  const k = keys();
  const ok =
    m[1] === 'proactive' ? k.triggers.has(m[2]) : k.scenarios.has(m[2]);
  return ok ? raw : null;
}

/** Нужен ли опубликованный вид для проверки openedBy (иначе — не читаем базу). */
export function openedByNeedsKeys(raw: unknown): boolean {
  return typeof raw === 'string' && /^(proactive|scenario):/.test(raw);
}

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const EXTERNAL_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const USER_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * `identity` от страницы (`V4CAssist('identify')`, К-3) — режем до формы
 * `WidgetIdentity`: каждое поле — по своему правилу, неверное — null;
 * неизвестные ключи — мимо. Пусто — null (на сервер ничего не идёт).
 */
export function cleanIdentity(raw: unknown): WidgetIdentity | null {
  if (!isObj(raw)) return null;
  const name = cleanText(raw.name, 100);
  const emailRaw = cleanText(raw.email, 254);
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
  const externalId =
    typeof raw.externalId === 'string' && EXTERNAL_ID_RE.test(raw.externalId)
      ? raw.externalId
      : null;
  const userHash =
    typeof raw.userHash === 'string' && USER_HASH_RE.test(raw.userHash)
      ? raw.userHash
      : null;
  if (!name && !email && !externalId) return null;
  // userHash без externalId сверять не с чем.
  return { name, email, externalId, userHash: externalId ? userHash : null };
}

/** Разобранная цель (без pk) и признак «orderId не того формата» (422). */
export type GoalParse =
  | {
      ok: true;
      pk: string | null;
      goalKey: string;
      detector: 'url' | 'click' | 'form_submit' | 'js';
      docId: string;
      path: string | null;
      orderId: string | null;
      value: number | null;
      currency: string | null;
      conversationId: string | null;
      lastAssistClickAt: string | null;
      /** Э3-бис: ключ визита посетителя с согласием (связанный режим). */
      visit: string | null;
      assist: {
        proactive: string | null;
        scenario: string | null;
        link: boolean;
      } | null;
    }
  | { ok: false; code: 'BAD_REQUEST' | 'GOAL_ORDER_ID_INVALID' };

const GOAL_FIELDS = [
  'pk',
  'goalKey',
  'detector',
  'docId',
  'path',
  'orderId',
  'value',
  'currency',
  'conversationId',
  'lastAssistClickAt',
  'assist',
  // Э3-бис: ключ визита — только с согласием посетителя (чанк ana.js).
  'visit',
] as const;
const IFRAME_ONLY = ['conversationId', 'lastAssistClickAt', 'assist'] as const;

/**
 * `POST /widget/v1/goal` (§5-тер.1). `fromIframe` — запрос с visitor-token:
 * только он может нести диалог, клик по действию помощника и `assist`;
 * у загрузчика (страница, pk) эти поля — 400 (страница не назначает себе
 * атрибуцию `direct`).
 */
export function parseGoalRequest(raw: unknown, fromIframe: boolean): GoalParse {
  const bad = { ok: false, code: 'BAD_REQUEST' } as const;
  if (!isObj(raw) || !onlyKeys(raw, GOAL_FIELDS)) return bad;
  if (
    !fromIframe &&
    IFRAME_ONLY.some((k) => raw[k] !== undefined && raw[k] !== null)
  ) {
    return bad;
  }
  let pk: string | null = null;
  if (raw.pk !== undefined && raw.pk !== null) {
    if (typeof raw.pk !== 'string' || !PK_RE.test(raw.pk)) return bad;
    pk = raw.pk;
  }
  if (!fromIframe && !pk) return bad;
  if (typeof raw.goalKey !== 'string' || !GOAL_KEY_RE.test(raw.goalKey))
    return bad;
  const detector = raw.detector;
  if (
    detector !== 'url' &&
    detector !== 'click' &&
    detector !== 'form_submit' &&
    detector !== 'js'
  ) {
    return bad;
  }
  if (typeof raw.docId !== 'string' || !DOC_ID_RE.test(raw.docId)) return bad;
  let path: string | null = null;
  if (raw.path !== undefined && raw.path !== null) {
    path = cleanPath(raw.path);
    if (!path) return bad;
  }
  let orderId: string | null = null;
  if (raw.orderId !== undefined && raw.orderId !== null) {
    if (typeof raw.orderId !== 'string') return bad;
    if (!ORDER_ID_RE.test(raw.orderId)) {
      return { ok: false, code: 'GOAL_ORDER_ID_INVALID' };
    }
    orderId = raw.orderId;
  }
  let value: number | null = null;
  if (raw.value !== undefined && raw.value !== null) {
    if (
      typeof raw.value !== 'number' ||
      !Number.isFinite(raw.value) ||
      raw.value < 0 ||
      raw.value > 1e9
    ) {
      return bad;
    }
    value = Math.round(raw.value * 100) / 100;
  }
  let currency: string | null = null;
  if (raw.currency !== undefined && raw.currency !== null) {
    if (typeof raw.currency !== 'string' || !CURRENCY_RE.test(raw.currency))
      return bad;
    currency = raw.currency;
  }
  let conversationId: string | null = null;
  if (raw.conversationId !== undefined && raw.conversationId !== null) {
    if (
      typeof raw.conversationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(raw.conversationId)
    ) {
      return bad;
    }
    conversationId = raw.conversationId;
  }
  let lastAssistClickAt: string | null = null;
  if (raw.lastAssistClickAt !== undefined && raw.lastAssistClickAt !== null) {
    if (
      typeof raw.lastAssistClickAt !== 'string' ||
      raw.lastAssistClickAt.length > 40 ||
      Number.isNaN(Date.parse(raw.lastAssistClickAt))
    ) {
      return bad;
    }
    lastAssistClickAt = raw.lastAssistClickAt;
  }
  let visit: string | null = null;
  if (raw.visit !== undefined && raw.visit !== null) {
    if (
      typeof raw.visit !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(raw.visit)
    )
      return bad;
    visit = raw.visit;
  }
  let assist: Extract<GoalParse, { ok: true }>['assist'] = null;
  if (raw.assist !== undefined && raw.assist !== null) {
    const a = raw.assist;
    if (!isObj(a) || !onlyKeys(a, ['proactive', 'scenario', 'link']))
      return bad;
    const key = (v: unknown): string | null | false =>
      v === undefined || v === null
        ? null
        : typeof v === 'string' && ENGAGEMENT_KEY_RE.test(v)
          ? v
          : false;
    const proactive = key(a.proactive);
    const scenario = key(a.scenario);
    if (proactive === false || scenario === false) return bad;
    if (a.link !== undefined && typeof a.link !== 'boolean') return bad;
    assist = { proactive, scenario, link: a.link === true };
  }
  return {
    ok: true,
    pk,
    goalKey: raw.goalKey,
    detector,
    docId: raw.docId,
    path,
    orderId,
    value,
    currency,
    conversationId,
    lastAssistClickAt,
    visit,
    assist,
  };
}

/**
 * Время последнего клика по действию помощника: не из будущего (допуск
 * 1 мин на часы) и не старше суток — иначе null (атрибуцию решает A).
 */
export function clickTime(iso: string | null, now: Date): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  if (t > now.getTime() + 60_000 || t < now.getTime() - 24 * 3600_000) {
    return null;
  }
  return new Date(t);
}

/** Теги полей ввода: их выбрать целью нельзя (§5-тер.8: значения полей не собираются). */
export const INPUT_TAGS = ['input', 'textarea', 'select', 'option'] as const;

const DESCRIPTOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Дескриптор элемента из режима выбора цели — строго (A: goal-types.ts). */
export function parseDescriptor(raw: unknown): ElementDescriptor | null {
  if (
    !isObj(raw) ||
    !onlyKeys(raw, ['assistGoal', 'assistId', 'role', 'text', 'tag'])
  ) {
    return null;
  }
  const id = (v: unknown): string | null | false =>
    v === undefined || v === null
      ? null
      : typeof v === 'string' && DESCRIPTOR_ID_RE.test(v)
        ? v
        : false;
  const assistGoal = id(raw.assistGoal);
  const assistId = id(raw.assistId);
  if (assistGoal === false || assistId === false) return null;
  let role: string | null = null;
  if (raw.role !== undefined && raw.role !== null) {
    if (typeof raw.role !== 'string' || !/^[a-z]{1,20}$/.test(raw.role))
      return null;
    role = raw.role;
  }
  let tag: string | null = null;
  if (raw.tag !== undefined && raw.tag !== null) {
    if (typeof raw.tag !== 'string' || !/^[a-z][a-z0-9-]{0,20}$/.test(raw.tag))
      return null;
    tag = raw.tag;
  }
  if (tag && (INPUT_TAGS as readonly string[]).includes(tag)) return null;
  if (role === 'textbox' || role === 'combobox' || role === 'searchbox')
    return null;
  let text: string | null = null;
  if (raw.text !== undefined && raw.text !== null) {
    text = cleanText(raw.text, 80);
    if (!text) return null;
  }
  if (!assistGoal && !assistId && !text) return null;
  return { assistGoal, assistId, role, text, tag };
}

/** `POST /widget/v1/goal-picker/pick` — строго. */
export function parsePick(raw: unknown): WidgetGoalPickRequest | null {
  if (
    !isObj(raw) ||
    !onlyKeys(raw, ['pickerSession', 'kind', 'descriptor', 'path', 'label'])
  ) {
    return null;
  }
  if (
    typeof raw.pickerSession !== 'string' ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(raw.pickerSession)
  ) {
    return null;
  }
  if (raw.kind !== 'click' && raw.kind !== 'form_submit') return null;
  const descriptor = parseDescriptor(raw.descriptor);
  const path = cleanPath(raw.path);
  const label = cleanText(raw.label, 80);
  if (!descriptor || !path || !label) return null;
  return {
    pickerSession: raw.pickerSession,
    kind: raw.kind,
    descriptor,
    path,
    label,
  };
}
