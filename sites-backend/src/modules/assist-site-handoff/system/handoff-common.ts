/**
 * Общее системной части передачи — H: формы ответа, ошибки кабинета,
 * получатели карточек, тексты бота. Основная роль (папка system/).
 * Тексты бота — по-русски (кабинет, как уведомления Э1–Э2); посетителю
 * отсюда не уходит ничего.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { SiteAnswerSource } from '../../assist-site-chat/chat-types';
import {
  parseAccountRole,
  parseProductRoles,
  type AccountRole,
  type ProductRoles,
} from '../../site-core/account/roles';
import {
  ESCALATION_KINDS,
  HANDOFF_REASONS,
  HANDOFF_STATES,
  type EscalationKind,
  type HandoffDraft,
  type HandoffErrorCode,
  type HandoffReason,
  type HandoffState,
  type HandoffSummary,
  type HandoffView,
} from '../api-types';

export function handoffError(
  code: HandoffErrorCode | 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST',
  message: string,
  status: number,
): HttpException {
  return new HttpException({ message, error: code, code }, status);
}

export const handoffNotFound = () =>
  handoffError(
    'HANDOFF_NOT_FOUND',
    'Передача не найдена',
    HttpStatus.NOT_FOUND,
  );

/** Кто вправе работать с передачами кабинета: владелец, assist manager|operator. */
export function canOperate(m: {
  role: AccountRole;
  productRoles: ProductRoles;
}): boolean {
  return (
    m.role === 'owner' ||
    m.productRoles.assist === 'manager' ||
    m.productRoles.assist === 'operator'
  );
}

/** Перехват чужой передачи и trace — владелец и assist: manager. */
export function isAssistManager(m: {
  role: AccountRole;
  productRoles: ProductRoles;
}): boolean {
  return m.role === 'owner' || m.productRoles.assist === 'manager';
}

export const HANDOFF_ROW_SELECT = {
  id: true,
  accountId: true,
  siteId: true,
  conversationId: true,
  state: true,
  reason: true,
  escalation: true,
  visitorLang: true,
  operatorLang: true,
  pageUrl: true,
  summary: true,
  draft: true,
  identityEnc: true,
  identityVerified: true,
  assignedMemberId: true,
  assignedTelegramId: true,
  requestedAt: true,
  deliveredAt: true,
  takenAt: true,
  firstReplyAt: true,
  lastOperatorAt: true,
  lastVisitorAt: true,
  remindedAt: true,
  reminders: true,
  timeoutAt: true,
  missedAt: true,
  closedAt: true,
  closedBy: true,
  cards: true,
  attempts: true,
} satisfies Prisma.AssistSiteHandoffSelect;

export type HandoffRow = Prisma.AssistSiteHandoffGetPayload<{
  select: typeof HANDOFF_ROW_SELECT;
}>;

function pick<T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T,
): T {
  return (list as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

export function parseSummary(v: unknown): HandoffSummary | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string') return null;
  return {
    text: o.text,
    lang: typeof o.lang === 'string' ? o.lang : 'ru',
    source: o.source === 'model' ? 'model' : 'fallback',
  };
}

export function parseDraft(v: unknown): HandoffDraft | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string' || !o.text) return null;
  const sources: SiteAnswerSource[] = Array.isArray(o.sources)
    ? (o.sources as unknown[])
        .filter(
          (s): s is Record<string, unknown> => !!s && typeof s === 'object',
        )
        .map((s) => ({
          n: typeof s.n === 'number' ? s.n : 0,
          url: typeof s.url === 'string' ? s.url : null,
          title: typeof s.title === 'string' ? s.title : null,
        }))
    : [];
  return {
    text: o.text,
    lang: typeof o.lang === 'string' ? o.lang : 'uk',
    sources,
  };
}

export interface CardRef {
  memberId: string;
  chatId: string;
  messageId: number;
}

export function parseCards(v: unknown): CardRef[] {
  if (!Array.isArray(v)) return [];
  const out: CardRef[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (
      typeof o.memberId === 'string' &&
      typeof o.chatId === 'string' &&
      /^-?\d+$/.test(o.chatId) &&
      typeof o.messageId === 'number'
    ) {
      out.push({
        memberId: o.memberId,
        chatId: o.chatId,
        messageId: o.messageId,
      });
    }
  }
  return out;
}

export function toHandoffView(
  h: HandoffRow,
  me: { memberId: string } | null,
): HandoffView {
  return {
    id: h.id,
    state: pick<HandoffState>(HANDOFF_STATES, h.state, 'closed'),
    reason: pick<HandoffReason>(HANDOFF_REASONS, h.reason, 'visitor'),
    escalation: (ESCALATION_KINDS as readonly unknown[]).includes(h.escalation)
      ? (h.escalation as EscalationKind)
      : null,
    requestedAt: h.requestedAt.toISOString(),
    takenAt: h.takenAt?.toISOString() ?? null,
    timeoutAt: h.timeoutAt.toISOString(),
    closedAt: h.closedAt?.toISOString() ?? null,
    assignedMemberId: h.assignedMemberId,
    assignedToMe: !!me && h.assignedMemberId === me.memberId,
    visitorLang: h.visitorLang,
    operatorLang: h.operatorLang,
    summary: parseSummary(h.summary),
    draft: parseDraft(h.draft),
    identity: {
      present: !!h.identityEnc,
      verified: h.identityEnc ? h.identityVerified : null,
    },
  };
}

export interface BotRecipient {
  memberId: string;
  telegramId: bigint;
  role: AccountRole;
  productRoles: ProductRoles;
}

/**
 * Участники кабинета, которым МОЖНО писать: право на передачи + нажали
 * Start у бота Помощника и не заблокировали его (О-9 Э2, §3.7).
 */
export async function botRecipients(
  prisma: PrismaService,
  accountId: string,
): Promise<BotRecipient[]> {
  const members = await prisma.siteAccountMember.findMany({
    where: { accountId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, telegramId: true, role: true, productRoles: true },
  });
  const eligible: BotRecipient[] = [];
  for (const m of members) {
    const role = parseAccountRole(m.role);
    if (!role) continue;
    const productRoles = parseProductRoles(m.productRoles);
    if (!canOperate({ role, productRoles })) continue;
    eligible.push({
      memberId: m.id,
      telegramId: m.telegramId,
      role,
      productRoles,
    });
  }
  if (!eligible.length) return [];
  const users = await prisma.assistBotUser.findMany({
    where: {
      telegramId: { in: eligible.map((m) => m.telegramId) },
      startedAt: { not: null },
      blockedAt: null,
    },
    select: { telegramId: true },
  });
  const ok = new Set(users.map((u) => u.telegramId.toString()));
  return eligible.filter((m) => ok.has(m.telegramId.toString()));
}

// ── Тексты бота (по-русски, ≤ 4096) ─────────────────────────────────────

const REASON_TEXT: Record<string, string> = {
  visitor: 'посетитель попросил человека',
  escalation: 'сработало правило',
  no_answer: 'помощник не нашёл ответа',
  scenario: 'сценарий виджета',
};
const ESCALATION_TEXT: Record<string, string> = {
  irritation: 'раздражение',
  complaint: 'жалоба',
  refund: 'возврат',
  wholesale: 'оптовый заказ',
  sensitive: 'чувствительная тема',
};

/** Карточка передачи: только маскированное, без имени посетителя (§3.7). */
export function cardText(p: {
  siteName: string;
  pageUrl: string | null;
  visitorLang: string | null;
  reason: string;
  escalation: string | null;
  identity: 'verified' | 'claimed' | null;
  summary: HandoffSummary | null;
  state: 'waiting' | 'taken_by_me' | 'taken_by_other' | 'closed' | 'missed';
}): string {
  const lines = [`🙋 Посетитель ждёт оператора — «${p.siteName}»`];
  if (p.pageUrl) lines.push(`Страница: ${p.pageUrl}`);
  if (p.visitorLang) lines.push(`Язык посетителя: ${p.visitorLang}`);
  const why = REASON_TEXT[p.reason] ?? p.reason;
  lines.push(
    `Причина: ${why}${p.escalation ? ` (${ESCALATION_TEXT[p.escalation] ?? p.escalation})` : ''}`,
  );
  if (p.identity) {
    lines.push(
      p.identity === 'verified'
        ? 'Покупатель сайта: проверен (подпись сайта)'
        : 'Покупатель сайта: заявлено (без проверки)',
    );
  }
  if (p.summary?.text) {
    lines.push(
      '',
      p.summary.source === 'model' ? 'Сводка:' : 'Сводка (без модели):',
      p.summary.text,
    );
  }
  lines.push('');
  const tail: Record<typeof p.state, string> = {
    waiting:
      'Нажмите «Взять» и ответьте реплаем на это сообщение — ответ уйдёт посетителю в виджет.',
    taken_by_me:
      'Диалог ваш. Ответьте реплаем на это сообщение — ответ уйдёт посетителю.',
    taken_by_other: 'Диалог взял другой оператор.',
    closed: 'Передача закрыта.',
    missed:
      'Никто не взял вовремя — посетителю предложена форма заявки. Можно ответить реплаем: посетитель увидит ответ, когда вернётся.',
  };
  lines.push(tail[p.state]);
  return lines.join('\n').slice(0, 4000);
}

/** Сообщение посетителя во время передачи (маскированное) + перевод. */
export function relayText(p: {
  text: string;
  translation: { lang: string; text: string } | null;
  untranslated: boolean;
}): string {
  const lines = ['💬 Посетитель:', p.text];
  if (p.translation) {
    lines.push('', `Перевод (${p.translation.lang}):`, p.translation.text);
  } else if (p.untranslated) {
    lines.push('', '(без перевода)');
  }
  lines.push('', 'Ответьте реплаем — ответ уйдёт посетителю.');
  return lines.join('\n').slice(0, 4000);
}
