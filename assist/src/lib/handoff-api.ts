/**
 * Клиент ленты диалогов и передачи человеку (Э3, REST агента H, контракт
 * §6 «Кабинет»). Разбор строгий, как у `widget-api.ts`: бэкенд пишут
 * параллельно, и неожиданное значение не должно стать кнопкой «Взять» у
 * чужой передачи, ссылкой `javascript:` или HTML.
 *
 * Правила: перечни — из списка, иначе самое осторожное значение (состояние
 * передачи неизвестно → `closed`: кнопок действий нет); флаги прав —
 * строго `true`; ссылки источников — только https; `trace` — как пришёл
 * (сервер отдаёт его только manager/owner), иначе null.
 */

import { ApiError, type ApiClient } from '../kit';
import {
  ANSWER_PATHS,
  CONVERSATION_VIEWS,
  ESCALATION_KINDS,
  HANDOFF_LIMITS,
  HANDOFF_REASONS,
  HANDOFF_STATES,
  MESSAGE_ROLES,
  OPERATOR_LANGS,
  WEEKDAYS,
  type AnswerTrace,
  type ConversationListItem,
  type ConversationListQuery,
  type ConversationListView,
  type ConversationMessageView,
  type ConversationView,
  type EscalationKind,
  type HandoffConfig,
  type HandoffDraft,
  type HandoffSettingsView,
  type HandoffSummary,
  type HandoffView,
  type OperatorReplyRequest,
  type OperatorReplyResult,
  type OperatorView,
  type SiteAction,
  type SiteAnswerSource,
  type TakeResult,
} from './handoff-types';
import {
  ID,
  arr,
  count,
  obj,
  oneOf,
  safeHttpsUrl,
  str,
  strs,
  text,
} from './widget-api';

/** Число (в т.ч. дробное/отрицательное) или null. */
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Дата ISO — только строка, которую понимает Date. */
export const iso = (v: unknown): string | null =>
  typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null;

export function parseSources(v: unknown): SiteAnswerSource[] {
  return arr(v).map((x) => {
    const o = obj(x);
    return {
      n: count(o.n),
      url: safeHttpsUrl(o.url),
      title: str(o.title),
    };
  });
}

function parseAction(v: unknown): SiteAction | null {
  const o = obj(v);
  const label = text(o.label);
  if (o.kind === 'link') {
    const url = safeHttpsUrl(o.url);
    return url ? { kind: 'link', label, url } : null;
  }
  if (o.kind === 'lead' || o.kind === 'handoff') return { kind: o.kind, label };
  return null;
}

export function parseTrace(v: unknown): AnswerTrace | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return {
    knowledgeVersion: count(o.knowledgeVersion),
    configVersion: count(o.configVersion),
    path: oneOf(ANSWER_PATHS, o.path, 'model'),
    chunkIds: strs(o.chunkIds),
    faqId: str(o.faqId),
    rule: str(o.rule),
    cache: o.cache === true,
    translated: o.translated === true,
  };
}

function parseSummary(v: unknown): HandoffSummary | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return {
    text: text(o.text),
    lang: text(o.lang),
    source: o.source === 'model' ? 'model' : 'fallback',
  };
}

export function parseDraft(v: unknown): HandoffDraft | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return {
    text: text(o.text),
    lang: text(o.lang),
    sources: parseSources(o.sources),
  };
}

export function parseHandoff(v: unknown): HandoffView {
  const o = obj(v);
  const idn = obj(o.identity);
  return {
    id: text(o.id),
    // Неизвестное состояние — «закрыта»: кнопок действий нет.
    state: oneOf(HANDOFF_STATES, o.state, 'closed'),
    reason: oneOf(HANDOFF_REASONS, o.reason, 'visitor'),
    escalation: (ESCALATION_KINDS as readonly unknown[]).includes(o.escalation)
      ? (o.escalation as EscalationKind)
      : null,
    requestedAt: text(o.requestedAt),
    takenAt: iso(o.takenAt),
    timeoutAt: text(o.timeoutAt),
    closedAt: iso(o.closedAt),
    assignedMemberId: str(o.assignedMemberId),
    assignedToMe: o.assignedToMe === true,
    visitorLang: str(o.visitorLang),
    operatorLang: str(o.operatorLang),
    summary: parseSummary(o.summary),
    draft: parseDraft(o.draft),
    identity: {
      present: idn.present === true,
      verified: typeof idn.verified === 'boolean' ? idn.verified : null,
    },
  };
}

function parseMessage(v: unknown): ConversationMessageView {
  const o = obj(v);
  const tr = obj(o.translation);
  return {
    id: text(o.id),
    role: oneOf(MESSAGE_ROLES, o.role, 'system'),
    text: text(o.text),
    lang: str(o.lang),
    translation:
      typeof tr.text === 'string' && tr.text
        ? { lang: text(tr.lang), text: tr.text }
        : null,
    sources: parseSources(o.sources),
    actions: arr(o.actions)
      .map(parseAction)
      .filter((x): x is SiteAction => !!x),
    rating: o.rating === 1 || o.rating === -1 ? o.rating : null,
    flags: strs(o.flags),
    trace: parseTrace(o.trace),
    authorIsMe: o.authorIsMe === true,
    createdAt: text(o.createdAt),
  };
}

function parseListItem(v: unknown): ConversationListItem | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  const h = o.handoff && typeof o.handoff === 'object' ? obj(o.handoff) : null;
  return {
    id: o.id,
    createdAt: text(o.createdAt),
    lastMessageAt: text(o.lastMessageAt),
    pageUrl: safeHttpsUrl(o.pageUrl),
    locale: str(o.locale),
    outcome: str(o.outcome),
    flagged: o.flagged === true,
    openedBy: str(o.openedBy),
    preview: text(o.preview),
    messages: count(o.messages),
    handoff: h
      ? {
          id: text(h.id),
          state: oneOf(HANDOFF_STATES, h.state, 'closed'),
          requestedAt: text(h.requestedAt),
          assignedToMe: h.assignedToMe === true,
        }
      : null,
    hasLead: o.hasLead === true,
  };
}

export function parseConversationList(v: unknown): ConversationListView {
  const o = obj(v);
  return {
    items: arr(o.items)
      .map(parseListItem)
      .filter((x): x is ConversationListItem => !!x),
    nextCursor: str(o.nextCursor),
  };
}

export function parseConversation(v: unknown): ConversationView {
  const o = obj(v);
  const lead = o.lead && typeof o.lead === 'object' ? obj(o.lead) : null;
  return {
    id: text(o.id),
    createdAt: text(o.createdAt),
    lastMessageAt: text(o.lastMessageAt),
    pageUrl: safeHttpsUrl(o.pageUrl),
    locale: str(o.locale),
    outcome: str(o.outcome),
    openedBy: str(o.openedBy),
    messages: arr(o.messages).map(parseMessage),
    handoff:
      o.handoff && typeof o.handoff === 'object'
        ? parseHandoff(o.handoff)
        : null,
    lead: lead
      ? {
          id: text(lead.id),
          fieldNames: strs(lead.fieldNames),
          createdAt: text(lead.createdAt),
        }
      : null,
  };
}

export function parseTake(v: unknown): TakeResult {
  const o = obj(v);
  return {
    // Неясный ответ — «уже взяли»: не показываем «вы взяли» по ошибке.
    result: oneOf(
      ['taken', 'already_taken', 'not_waiting'] as const,
      o.result,
      'already_taken'
    ),
    handoff: parseHandoff(o.handoff),
  };
}

export function parseReply(v: unknown): OperatorReplyResult {
  const o = obj(v);
  return {
    messageId: text(o.messageId),
    sentText: text(o.sentText),
    translated: o.translated === true,
  };
}

const clampInt = (
  v: unknown,
  lim: { min: number; max: number; default: number }
): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lim.min && v <= lim.max
    ? v
    : lim.default;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseHandoffConfig(v: unknown): HandoffConfig {
  const o = obj(v);
  const hoursRaw = obj(o.hours);
  const hours: HandoffConfig['hours'] = {};
  for (const d of WEEKDAYS) {
    if (!Array.isArray(hoursRaw[d])) continue;
    hours[d] = arr(hoursRaw[d])
      .map((x) => obj(x))
      .filter(
        (x) =>
          typeof x.from === 'string' &&
          typeof x.to === 'string' &&
          HHMM.test(x.from) &&
          HHMM.test(x.to)
      )
      .map((x) => ({ from: x.from as string, to: x.to as string }))
      .slice(0, HANDOFF_LIMITS.intervalsPerDay);
  }
  const eta = obj(o.etaText);
  const etaText: HandoffConfig['etaText'] = {};
  for (const l of OPERATOR_LANGS) {
    if (typeof eta[l] === 'string' && eta[l]) etaText[l] = eta[l] as string;
  }
  const esc = obj(o.escalation);
  const escalation = Object.fromEntries(
    ESCALATION_KINDS.map((k) => [k, esc[k] === true])
  ) as Record<EscalationKind, boolean>;
  return {
    schema: 1,
    enabled: o.enabled === true,
    hours,
    waitMinutes: clampInt(o.waitMinutes, HANDOFF_LIMITS.waitMinutes),
    remindAfterMinutes: clampInt(
      o.remindAfterMinutes,
      HANDOFF_LIMITS.remindAfterMinutes
    ),
    maxReminders: clampInt(o.maxReminders, HANDOFF_LIMITS.maxReminders),
    idleCloseHours: clampInt(o.idleCloseHours, HANDOFF_LIMITS.idleCloseHours),
    etaText,
    templates: arr(o.templates)
      .map((x) => obj(x))
      .filter((x) => typeof x.id === 'string' && typeof x.text === 'string')
      .map((x) => ({
        id: x.id as string,
        title: text(x.title),
        text: x.text as string,
      }))
      .slice(0, HANDOFF_LIMITS.templates),
    operatorLang: oneOf(OPERATOR_LANGS, o.operatorLang, 'uk'),
    translate: o.translate === true,
    draft: o.draft === true,
    escalation,
  };
}

export function parseOperator(v: unknown): OperatorView | null {
  const o = obj(v);
  if (typeof o.memberId !== 'string' || !ID.test(o.memberId)) return null;
  return {
    memberId: o.memberId,
    telegramId: /^\d{1,20}$/.test(text(o.telegramId)) ? text(o.telegramId) : '',
    role: oneOf(['owner', 'manager', 'operator'] as const, o.role, 'operator'),
    assist: oneOf(['manager', 'operator', 'none'] as const, o.assist, 'none'),
    botStarted: o.botStarted === true,
    botBlocked: o.botBlocked === true,
    isMe: o.isMe === true,
  };
}

export function parseOperators(v: unknown): OperatorView[] {
  return arr(v)
    .map(parseOperator)
    .filter((x): x is OperatorView => !!x);
}

export function parseHandoffSettings(v: unknown): HandoffSettingsView {
  const o = obj(v);
  const eta = num(o.etaMinutes);
  return {
    config: parseHandoffConfig(o.config),
    etaMinutes: eta !== null && eta >= 0 ? eta : null,
    availableNow: o.availableNow === true,
    unavailableReason: (
      ['disabled', 'off_hours', 'no_operators'] as readonly unknown[]
    ).includes(o.unavailableReason)
      ? (o.unavailableReason as HandoffSettingsView['unavailableReason'])
      : null,
    operators: parseOperators(o.operators),
  };
}

/** Строка запроса ленты: только заданные фильтры, значения — экранированы. */
export function conversationQuery(q: Partial<ConversationListQuery>): string {
  const p = new URLSearchParams();
  p.set('view', oneOf(CONVERSATION_VIEWS, q.view, 'handoff'));
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.outcome) p.set('outcome', q.outcome);
  if (typeof q.flagged === 'boolean') p.set('flagged', String(q.flagged));
  if (q.lang) p.set('lang', q.lang);
  if (q.limit) p.set('limit', String(Math.max(1, Math.min(100, q.limit))));
  return p.toString();
}

export interface HandoffApi {
  list(
    siteId: string,
    q: Partial<ConversationListQuery>
  ): Promise<ConversationListView>;
  get(siteId: string, cid: string): Promise<ConversationView>;
  take(siteId: string, cid: string): Promise<TakeResult>;
  reply(
    siteId: string,
    cid: string,
    body: OperatorReplyRequest
  ): Promise<OperatorReplyResult>;
  draft(siteId: string, cid: string): Promise<HandoffDraft | null>;
  close(siteId: string, cid: string): Promise<{ ok: boolean }>;
  settings(siteId: string): Promise<HandoffSettingsView>;
  saveSettings(
    siteId: string,
    config: HandoffConfig
  ): Promise<HandoffSettingsView>;
  operators(): Promise<OperatorView[]>;
}

/**
 * Запрос без полезного ответа (DELETE): пустой `data` — тоже успех
 * (конверт кита бросает `empty_response`, если сервер ответил 204/без data).
 */
export async function requestVoid(
  client: ApiClient,
  method: string,
  path: string
): Promise<void> {
  try {
    await client.request(method, path);
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.code === 'empty_response' &&
      e.status < 300
    ) {
      return;
    }
    throw e;
  }
}

export function seg(id: string): string {
  if (!ID.test(id)) throw new ApiError('bad_request', 'bad id', 400);
  return id;
}

export function createHandoffApi(client: ApiClient): HandoffApi {
  const conv = (s: string, c?: string) =>
    `/assist/sites/${seg(s)}/conversations${c ? `/${seg(c)}` : ''}`;
  return {
    list: async (s, q) =>
      parseConversationList(
        await client.request('GET', `${conv(s)}?${conversationQuery(q)}`)
      ),
    get: async (s, c) =>
      parseConversation(await client.request('GET', conv(s, c))),
    take: async (s, c) =>
      parseTake(await client.request('POST', `${conv(s, c)}/take`)),
    reply: async (s, c, body) =>
      parseReply(await client.request('POST', `${conv(s, c)}/reply`, body)),
    draft: async (s, c) =>
      parseDraft(await client.request('POST', `${conv(s, c)}/draft`)),
    close: async (s, c) => {
      const o = obj(await client.request('POST', `${conv(s, c)}/close`));
      return { ok: o.ok === true };
    },
    settings: async (s) =>
      parseHandoffSettings(
        await client.request('GET', `/assist/sites/${seg(s)}/handoff-settings`)
      ),
    saveSettings: async (s, config) =>
      parseHandoffSettings(
        await client.request(
          'PATCH',
          `/assist/sites/${seg(s)}/handoff-settings`,
          { config }
        )
      ),
    operators: async () =>
      parseOperators(await client.request('GET', '/assist/account/operators')),
  };
}
