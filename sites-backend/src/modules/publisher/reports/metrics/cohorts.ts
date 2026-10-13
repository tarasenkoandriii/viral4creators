/**
 * AI Publisher — когорты и окна отчётов (P-E, проектный документ §9.3; ТЗ
 * §14–15; AT-CORE-07, AT-CORE-19). Чистые функции: без Nest, базы и env;
 * время — только `core/kyiv-time.ts` (Europe/Kyiv, вехи от t0, окна от
 * сессии, полуоткрытые интервалы).
 *
 * Определения ТЗ §15, которые здесь закреплены:
 *  - основная когорта — измеряемые НЕтестовые сессии в [t0, t42): сессия
 *    ровно в t42 — уже следующий период, t42 − 1 мс — внутри;
 *  - окно обращения — 30 календарных дней Kyiv от САМОЙ сессии, граница
 *    включается (`leadWindowEnd`);
 *  - квалификация — по решению, действовавшему на `snapshotAt`
 *    (`statusAt`); ещё не обработанные обращения — отдельный `pending`;
 *  - идентификация (prospect) — по строке связи, действовавшей на
 *    `snapshotAt` (`prospectAt`): пересчёт с прежней идентификацией
 *    воспроизводим;
 *  - один квалифицированный prospect — одна связанная сессия (первая
 *    квалифицированная заявка) и одна единица в знаменателе;
 *  - поздняя публикация — отдельная когорта с явным концом и закрытием
 *    через 30 дней после конца.
 */
import type { Computable } from '../../contracts/common';
import type { ChannelGroup, LeadStatus } from '../../contracts/states';
import {
  addKyivCalendarDays,
  inHalfOpen,
  kyivDateOf,
  kyivDayStart,
  leadWindowEnd,
} from '../../core/kyiv-time';

// ── Входы ────────────────────────────────────────────────────────────────

export interface SessionIn {
  sessionRef: string;
  startedAt: Date;
  testFlag: boolean;
  placementId: string | null;
  channelGroup: ChannelGroup | null;
}

export interface LeadIn {
  id: string;
  receivedAt: Date;
  testFlag: boolean;
  sessionRef: string | null;
  campaignId: string | null;
  /** Размещение из обогащения (`pub_leads.placementId`). */
  placementId: string | null;
}

export interface DecisionIn {
  id: string;
  leadId: string;
  toStatus: LeadStatus;
  decidedAt: Date;
}

export interface ProspectLinkIn {
  leadId: string;
  prospectId: string;
  validFrom: Date;
}

export interface ProspectIn {
  id: string;
  isExternal: boolean;
  isTeamOrPartner: boolean;
}

/** Суточный агрегат веб-аналитики по дате Kyiv (`pub_metric_imports`). */
export interface KyivDayAggregate {
  /** `YYYY-MM-DD` по Kyiv. */
  date: string;
  sessions: number | null;
  /** Источник сам пометил сутки неполными. */
  partial?: boolean;
}

/** Статусы «квалифицирован» на момент снимка (включая дальнейшие шаги продажи). */
export const QUALIFIED_STATUSES: readonly LeadStatus[] = [
  'qualified',
  'proposal_sent',
  'won',
  'lost',
];
/** Предложение отправлено (ТЗ §16 «предложения разным prospect_id»). */
export const PROPOSAL_STATUSES: readonly LeadStatus[] = [
  'proposal_sent',
  'won',
  'lost',
];
/** Ещё не обработано: в снимке — `pending`, без присвоения квалификации. */
export const PENDING_STATUSES: readonly LeadStatus[] = ['new', 'contacted'];

// ── Когорта сессий ───────────────────────────────────────────────────────

/** Нетестовые сессии в [t0, t42). */
export function cohortSessions<
  S extends Pick<SessionIn, 'startedAt' | 'testFlag'>,
>(sessions: readonly S[], t0: Date, t42: Date): S[] {
  return sessions.filter(
    (s) => !s.testFlag && inHalfOpen(s.startedAt, t0, t42),
  );
}

/**
 * Режим без `session_ref` (`analytics_storage='none'`, §9.3): сессии — из
 * суточных агрегатов Kyiv импорта веб-аналитики. Берутся даты от даты t0
 * до даты (t42 − 1 мс) включительно; первые и последние сутки, которые
 * интервал покрывает не целиком, — `partialDays` (не дробятся, помечаются).
 * Нет суток в импорте или `sessions: null` — сумма неизвестна (`null`),
 * а не ноль; такие даты — `missingDays`.
 */
export function cohortSessionsFromAggregates(
  days: readonly KyivDayAggregate[],
  t0: Date,
  t42: Date,
): { sessions: number | null; partialDays: string[]; missingDays: string[] } {
  const byDate = new Map<string, KyivDayAggregate>();
  // Повторный импорт тех же суток — действует последний (агрегаты не складываются).
  for (const d of days) byDate.set(d.date, d);
  const first = kyivDateOf(t0);
  const last = kyivDateOf(new Date(t42.getTime() - 1));
  const partialDays: string[] = [];
  const missingDays: string[] = [];
  let sum = 0;
  let known = true;
  for (
    let day = kyivDayStart(first);
    kyivDateOf(day) <= last;
    day = addKyivCalendarDays(day, 1)
  ) {
    const date = kyivDateOf(day);
    const next = addKyivCalendarDays(day, 1);
    const whole =
      day.getTime() >= t0.getTime() && next.getTime() <= t42.getTime();
    const agg = byDate.get(date);
    if (!whole || agg?.partial) partialDays.push(date);
    if (!agg || agg.sessions === null) {
      missingDays.push(date);
      known = false;
      continue;
    }
    sum += agg.sessions;
  }
  return { sessions: known ? sum : null, partialDays, missingDays };
}

// ── Окна обращения ───────────────────────────────────────────────────────

/** startedAt ≤ receivedAt ≤ leadWindowEnd(startedAt) — граница включена. */
export function leadInSessionWindow(
  lead: { receivedAt: Date },
  session: { startedAt: Date },
): boolean {
  return (
    session.startedAt.getTime() <= lead.receivedAt.getTime() &&
    lead.receivedAt.getTime() <= leadWindowEnd(session.startedAt).getTime()
  );
}

/**
 * Статус заявки на `snapshotAt`: последнее решение с `decidedAt ≤ snapshotAt`
 * (при равном времени — позднее в списке); решений нет — `new`.
 */
export function statusAt(
  decisions: readonly DecisionIn[],
  leadId: string,
  snapshotAt: Date,
): LeadStatus {
  let best: DecisionIn | null = null;
  for (const d of decisions) {
    if (d.leadId !== leadId) continue;
    if (d.decidedAt.getTime() > snapshotAt.getTime()) continue;
    if (!best || d.decidedAt.getTime() >= best.decidedAt.getTime()) best = d;
  }
  return best ? best.toStatus : 'new';
}

/** Проспект заявки на момент `at` (строка связи с `validFrom ≤ at`). */
export function prospectAt(
  links: readonly ProspectLinkIn[],
  leadId: string,
  at: Date,
): string | null {
  let best: ProspectLinkIn | null = null;
  for (const l of links) {
    if (l.leadId !== leadId) continue;
    if (l.validFrom.getTime() > at.getTime()) continue;
    if (!best || l.validFrom.getTime() >= best.validFrom.getTime()) best = l;
  }
  return best ? best.prospectId : null;
}

/** Внешний независимый проспект (не команда/партнёр, AT-CORE-06/07). */
export function isExternalProspect(p: ProspectIn | undefined): boolean {
  return !!p && p.isExternal && !p.isTeamOrPartner;
}

/**
 * Уникальные квалифицированные проспекты на `at`: нетестовые заявки,
 * статус на `at` ∈ квалифицирован и далее, проспект на `at` внешний.
 * `f.leadIds` — ограничить множеством заявок (когорта/период),
 * `f.linkedOnly` — только технически связанные (по `linkedLeadIds`).
 * Две задачи одного проспекта — одна единица (AT-CORE-07).
 */
export function uniqueQualifiedProspects(
  leads: readonly LeadIn[],
  decisions: readonly DecisionIn[],
  links: readonly ProspectLinkIn[],
  prospects: readonly ProspectIn[],
  at: Date,
  f: {
    campaignId?: string;
    externalOnly: true;
    leadIds?: ReadonlySet<string>;
    statuses?: readonly LeadStatus[];
  },
): Set<string> {
  const byId = new Map(prospects.map((p) => [p.id, p]));
  const statuses = f.statuses ?? QUALIFIED_STATUSES;
  const out = new Set<string>();
  for (const l of leads) {
    if (l.testFlag) continue;
    if (l.receivedAt.getTime() > at.getTime()) continue;
    if (f.leadIds && !f.leadIds.has(l.id)) continue;
    if (f.campaignId && l.campaignId !== f.campaignId) continue;
    if (!statuses.includes(statusAt(decisions, l.id, at))) continue;
    const pid = prospectAt(links, l.id, at);
    if (!pid) continue;
    if (f.externalOnly && !isExternalProspect(byId.get(pid))) continue;
    out.add(pid);
  }
  return out;
}

/**
 * Основная техническая связь проспекта (§9.3): ПЕРВАЯ квалифицированная
 * заявка проспекта (по `receivedAt`, затем id) → её сессия. Одна на
 * проспект — несколько сессий его не удваивают. null — у первой
 * квалифицированной заявки нет сессии (связь неизвестна).
 */
export function primarySessionOfProspect<
  S extends Pick<SessionIn, 'sessionRef'>,
>(
  prospectLeads: readonly Pick<LeadIn, 'id' | 'receivedAt' | 'sessionRef'>[],
  sessions: readonly S[],
): S | null {
  const first = [...prospectLeads].sort(
    (a, b) =>
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      a.id.localeCompare(b.id),
  )[0];
  if (!first?.sessionRef) return null;
  return sessions.find((s) => s.sessionRef === first.sessionRef) ?? null;
}

/** Покрытие технической связью: все / связанные / неизвестные. */
export function coverage(
  qualified: ReadonlySet<string>,
  linked: ReadonlySet<string>,
): {
  total: number;
  linked: number;
  unknown: number;
  ratio: Computable<number>;
} {
  const linkedIn = [...linked].filter((p) => qualified.has(p)).length;
  const total = qualified.size;
  return {
    total,
    linked: linkedIn,
    unknown: total - linkedIn,
    ratio:
      total === 0
        ? {
            kind: 'not_computable',
            reason: 'zero_denominator',
            inputs: { linked: linkedIn, total },
          }
        : { kind: 'value', value: linkedIn / total },
  };
}

// ── Поздняя когорта и окна размещений ────────────────────────────────────

/**
 * Поздняя публикация (после D42, ТЗ §15): отдельная когорта
 * [publishedAt, explicitEnd) — конец задаётся явно; закрытие — через 30
 * календарных дней Kyiv после конца. Прежний результат не меняется.
 */
export function lateCohort(
  placement: { publishedAt: Date },
  explicitEnd: Date,
): { start: Date; end: Date; closeAt: Date } {
  if (explicitEnd.getTime() <= placement.publishedAt.getTime()) {
    throw new RangeError(
      'lateCohort: конец когорты должен быть после публикации',
    );
  }
  return {
    start: placement.publishedAt,
    end: explicitEnd,
    closeAt: addKyivCalendarDays(explicitEnd, 30),
  };
}

/**
 * Состояние 30-дневного окна размещения на снимке (§9.3 «окно последней
 * сессии»): открыто, пока `snapshotAt ≤ (последняя НЕтестовая сессия
 * размещения до снимка, не раньше публикации) + 30 дней Kyiv` (обращение
 * ровно на границе ещё учитывается), затем закрыто. Без сессий — от
 * публикации. Диагностические снимки +7/+14 окна не закрывают.
 */
export function placementWindowState(
  placement: { publishedAt: Date | null },
  snapshotAt: Date,
  lastSessionAt: Date | null = null,
): 'not_published' | 'open' | 'closed' {
  if (!placement.publishedAt) return 'not_published';
  if (placement.publishedAt.getTime() > snapshotAt.getTime()) {
    return 'not_published';
  }
  const base =
    lastSessionAt &&
    lastSessionAt.getTime() > placement.publishedAt.getTime() &&
    lastSessionAt.getTime() <= snapshotAt.getTime()
      ? lastSessionAt
      : placement.publishedAt;
  return snapshotAt.getTime() <= leadWindowEnd(base).getTime()
    ? 'open'
    : 'closed';
}

/**
 * Момент закрытия окон обращения когорты [start, end): конец + 30
 * календарных дней Kyiv; для основной когорты — не раньше t72 (аудит P-E
 * S3-4: ночной t0 перед весенним переходом сдвигает t42 вперёд, и «t42 + 30
 * дней» может оказаться позже t72 — одно правило и для снимка, и для
 * заключения эксперимента).
 */
export function cohortCloseAt(cohortEnd: Date, t72: Date | null = null): Date {
  const byWindow = addKyivCalendarDays(cohortEnd, 30);
  return t72 && t72.getTime() > byWindow.getTime() ? t72 : byWindow;
}

/** Окно обращений когорты закрыто: snapshotAt ≥ `cohortCloseAt`. */
export function cohortWindowClosed(
  cohortEnd: Date,
  snapshotAt: Date,
  t72: Date | null = null,
): boolean {
  return snapshotAt.getTime() >= cohortCloseAt(cohortEnd, t72).getTime();
}

export interface PaymentEventIn {
  id: string;
  leadId: string | null;
  prospectId: string;
  /** Момент, когда оплата стала подтверждённой (или возвращённой). */
  at: Date;
}

/**
 * Решения и оплаты ПОСЛЕ снимка по заявкам/проспектам его когорты
 * (`report-staleness`, аудит P2-16): поздняя квалификация или оплата
 * создаёт снимок-наследник; исходный снимок не меняется.
 */
export function lateDecisionsAfter(
  snapshot: {
    snapshotAt: Date;
    leadIds: readonly string[];
    prospectIds?: readonly string[];
  },
  decisions: readonly DecisionIn[],
  payments: readonly PaymentEventIn[],
): Array<{
  id: string;
  leadId: string | null;
  kind: 'decision' | 'payment';
  at: Date;
}> {
  const leads = new Set(snapshot.leadIds);
  const prospects = new Set(snapshot.prospectIds ?? []);
  const t = snapshot.snapshotAt.getTime();
  const out: Array<{
    id: string;
    leadId: string | null;
    kind: 'decision' | 'payment';
    at: Date;
  }> = [];
  for (const d of decisions) {
    if (leads.has(d.leadId) && d.decidedAt.getTime() > t) {
      out.push({
        id: d.id,
        leadId: d.leadId,
        kind: 'decision',
        at: d.decidedAt,
      });
    }
  }
  for (const p of payments) {
    const ours =
      (p.leadId !== null && leads.has(p.leadId)) || prospects.has(p.prospectId);
    if (ours && p.at.getTime() > t) {
      out.push({ id: p.id, leadId: p.leadId, kind: 'payment', at: p.at });
    }
  }
  return out.sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
  );
}
