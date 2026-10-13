/**
 * AI Publisher — представления заявок для кабинета и выгрузки (P-D,
 * проектный документ §6.5, §11.1, §11.3). Ни одно представление не несёт
 * контакта, имени, текста задачи и шифротекстов: их видно только через
 * `POST …/contact` и `POST …/notes` (с аудитом, Р-PUB-Z2-25).
 *
 * CSV (§11.1, аудит P3-27): значения, начинающиеся с `=`, `+`, `-`, `@`,
 * табуляции или CR, экранируются префиксом `'` (защита от формул).
 */
import type {
  LeadAttributionView,
  LeadCardView,
  LeadDecisionView,
  LeadListItem,
  ProspectLinkView,
} from '../contracts/leads-api';
import type { ContactMethod, LeadStatus } from '../contracts/states';

/** Строка `pub_leads` (поля, нужные представлениям). */
export interface LeadRow {
  id: string;
  publicRef: string;
  status: string;
  receivedAt: Date;
  contactMethod: string;
  budgetRange: string | null;
  selfReportedChannel: string | null;
  testFlag: boolean;
  testReason: string | null;
  suspectedSpam: boolean;
  responsibleMemberId: string | null;
  responsibleDisplayName: string | null;
  prospectId: string | null;
  duplicateOfLeadId: string | null;
  campaignId: string | null;
  contentId: string | null;
  placementId: string | null;
  contactDueAt: Date | null;
  reviewDueAt: Date;
  closedAt: Date | null;
  erasedAt: Date | null;
  enrichedAt: Date | null;
  revision: number;
  consentState: string;
  sessionRef: string | null;
  contentSlugRaw: string | null;
  placementCodeRaw: string | null;
  attribution: unknown;
  retentionBasis: string | null;
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

export function isOverdue(
  r: Pick<LeadRow, 'status' | 'contactDueAt' | 'erasedAt'>,
  now: Date,
): boolean {
  return (
    r.status === 'new' &&
    r.erasedAt === null &&
    r.contactDueAt !== null &&
    r.contactDueAt.getTime() < now.getTime()
  );
}

export function leadListItem(
  r: LeadRow,
  prospectCode: string | null,
  now: Date,
): LeadListItem {
  return {
    id: r.id,
    publicRef: r.publicRef,
    status: r.status as LeadStatus,
    receivedAt: r.receivedAt.toISOString(),
    contactMethod: r.contactMethod as ContactMethod,
    budgetRange: r.budgetRange,
    selfReportedChannel: r.selfReportedChannel,
    testFlag: r.testFlag,
    testReason: r.testReason,
    suspectedSpam: r.suspectedSpam,
    responsibleMemberId: r.responsibleMemberId,
    responsibleDisplayName: r.responsibleDisplayName,
    prospectId: r.prospectId,
    prospectCode,
    duplicateOfLeadId: r.duplicateOfLeadId,
    campaignId: r.campaignId,
    contentId: r.contentId,
    placementId: r.placementId,
    contactDueAt: iso(r.contactDueAt),
    overdue: isOverdue(r, now),
    reviewDueAt: r.reviewDueAt.toISOString(),
    closedAt: iso(r.closedAt),
    erased: r.erasedAt !== null,
    enriched: r.enrichedAt !== null,
    revision: r.revision,
  };
}

export interface CardExtras {
  prospectCode: string | null;
  decisions: LeadDecisionView[];
  prospectLinks: ProspectLinkView[];
  possibleDuplicates: string[];
  outbox: LeadCardView['outbox'];
  notifications: LeadCardView['notifications'];
}

export function leadCardView(
  r: LeadRow,
  x: CardExtras,
  now: Date,
): LeadCardView {
  return {
    ...leadListItem(r, x.prospectCode, now),
    consentState: r.consentState,
    sessionRef: r.sessionRef,
    contentSlugRaw: r.contentSlugRaw,
    placementCodeRaw: r.placementCodeRaw,
    attribution: (r.attribution as LeadAttributionView | null) ?? null,
    enrichedAt: iso(r.enrichedAt),
    retentionBasis: r.retentionBasis,
    erasedAt: iso(r.erasedAt),
    decisions: x.decisions,
    prospectLinks: x.prospectLinks,
    possibleDuplicates: x.possibleDuplicates,
    outbox: x.outbox,
    notifications: x.notifications,
  };
}

/** Колонки CSV очереди (без контактов, заметок и текста задачи). */
export const LEAD_CSV_COLUMNS: ReadonlyArray<keyof LeadListItem> = [
  'publicRef',
  'status',
  'receivedAt',
  'contactMethod',
  'budgetRange',
  'selfReportedChannel',
  'testFlag',
  'testReason',
  'suspectedSpam',
  'responsibleDisplayName',
  'prospectCode',
  'duplicateOfLeadId',
  'contentId',
  'placementId',
  'campaignId',
  'contactDueAt',
  'overdue',
  'reviewDueAt',
  'closedAt',
  'erased',
  'enriched',
  'id',
];

/** Ячейка CSV: кавычки, экранирование формул (аудит P3-27). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(
  rows: readonly T[],
  columns: ReadonlyArray<keyof T>,
): string {
  const head = columns.map((c) => csvCell(String(c))).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}
