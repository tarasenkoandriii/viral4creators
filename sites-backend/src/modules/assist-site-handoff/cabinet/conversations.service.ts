/**
 * Диалоги «Сайта» в кабинете — H (ТЗ §3.7, §5-тер.6 «Диалоги», §5-тер.13
 * «кто что видит»). SitesDb.forAccount; чужой сайт — 404.
 * Оператор (`assist: operator`) — только диалоги с передачей (своей или
 * ждущей); trace (№34) — только manager/owner. Курсор — (lastMessageAt, id).
 * Ответ/взять/закрыть — через HandoffOperatorActions (одна логика с ботом).
 *
 * Уточнения H: умолчание `view` — `handoff` для оператора и `all` для
 * manager/owner; «ждущая» для оператора — `waiting` или `missed` (её можно
 * взять, §3.7 п.5), «своя» — назначенная ему в любом состоянии.
 */
import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import type {
  AnswerTrace,
  SiteAction,
  SiteAnswerSource,
} from '../../assist-site-chat/chat-types';
import type { AccountMembership } from '../../site-core/account/roles';
import type {
  ConversationListItem,
  ConversationListQuery,
  ConversationListView,
  ConversationMessageView,
  ConversationView,
  HandoffSettingsView,
  HandoffState,
  OperatorView,
} from '../api-types';
import {
  effectiveHandoffConfig,
  isWithinHours,
  parseHandoffConfig,
} from '../public/handoff-config';
import {
  HANDOFF_ROW_SELECT,
  handoffError,
  isAssistManager,
  toHandoffView,
} from '../system/handoff-common';
import { HandoffDispatcher } from '../system/handoff-dispatcher.service';

export const CONVERSATIONS_PAGE_MAX = 100;
export const CONVERSATIONS_PAGE_DEFAULT = 30;
const PREVIEW_CHARS = 120;
const ROLES = ['visitor', 'assistant', 'operator', 'system'] as const;

const notFound = () =>
  handoffError('NOT_FOUND', 'Диалог не найден', HttpStatus.NOT_FOUND);

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(c: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    const at = new Date(iso);
    if (!id || Number.isNaN(at.getTime()) || id.length > 64) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** Разбор query-строки ленты (маршрут). Ошибка — 400. */
export function parseListQuery(
  raw: Record<string, unknown>,
  m: AccountMembership,
): ConversationListQuery {
  const bad = (what: string) =>
    handoffError(
      'BAD_REQUEST',
      `Неверный параметр: ${what}`,
      HttpStatus.BAD_REQUEST,
    );
  const str = (k: string): string | null => {
    const v = raw[k];
    if (v === undefined || v === '') return null;
    if (typeof v !== 'string') throw bad(k);
    return v;
  };
  const view = str('view') ?? (isAssistManager(m) ? 'all' : 'handoff');
  if (!['handoff', 'mine', 'all'].includes(view)) throw bad('view');
  const date = (k: string) => {
    const v = str(k);
    if (v === null) return null;
    if (Number.isNaN(new Date(v).getTime())) throw bad(k);
    return v;
  };
  const flagged = str('flagged');
  if (flagged !== null && flagged !== 'true' && flagged !== 'false') {
    throw bad('flagged');
  }
  const limitRaw = str('limit');
  const limit =
    limitRaw === null ? CONVERSATIONS_PAGE_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATIONS_PAGE_MAX) {
    throw bad('limit');
  }
  const cursor = str('cursor');
  if (cursor !== null && !decodeCursor(cursor)) throw bad('cursor');
  const outcome = str('outcome');
  if (outcome !== null && !/^[a-z_]{1,32}$/.test(outcome)) throw bad('outcome');
  const lang = str('lang');
  if (lang !== null && !/^[a-z]{2}$/.test(lang)) throw bad('lang');
  return {
    view: view as ConversationListQuery['view'],
    cursor,
    from: date('from'),
    to: date('to'),
    outcome,
    flagged: flagged === null ? null : flagged === 'true',
    lang,
    limit,
  };
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

@Injectable()
export class ConversationsService {
  constructor(private readonly sitesDb: SitesDb) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  private async requireSite(m: AccountMembership, siteId: string) {
    const s = await this.db(m).site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!s) {
      throw handoffError('NOT_FOUND', 'Сайт не найден', HttpStatus.NOT_FOUND);
    }
  }

  /** Фильтр «оператор видит только диалоги с передачей (ждущей или своей)». */
  private operatorScope(
    m: AccountMembership,
  ): Prisma.AssistSiteConversationWhereInput {
    return {
      handoffs: {
        some: {
          OR: [
            { state: { in: ['waiting', 'missed'] } },
            { assignedMemberId: m.memberId },
          ],
        },
      },
    };
  }

  async list(
    m: AccountMembership,
    siteId: string,
    q: ConversationListQuery,
  ): Promise<ConversationListView> {
    await this.requireSite(m, siteId);
    const manager = isAssistManager(m);
    if (q.view === 'all' && !manager) {
      throw handoffError(
        'FORBIDDEN',
        'Оператору доступны только диалоги с передачей',
        HttpStatus.FORBIDDEN,
      );
    }
    const and: Prisma.AssistSiteConversationWhereInput[] = [{ siteId }];
    if (!manager) and.push(this.operatorScope(m));
    if (q.view === 'handoff') {
      and.push({
        handoffs: { some: { state: { in: ['waiting', 'active', 'missed'] } } },
      });
    } else if (q.view === 'mine') {
      and.push({ handoffs: { some: { assignedMemberId: m.memberId } } });
    }
    if (q.from) and.push({ lastMessageAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ lastMessageAt: { lte: new Date(q.to) } });
    if (q.outcome) and.push({ outcome: q.outcome });
    if (q.flagged !== null) and.push({ flagged: q.flagged });
    if (q.lang) and.push({ locale: { startsWith: q.lang } });
    const c = q.cursor ? decodeCursor(q.cursor) : null;
    if (c) {
      and.push({
        OR: [
          { lastMessageAt: { lt: c.at } },
          { lastMessageAt: c.at, id: { lt: c.id } },
        ],
      });
    }
    const rows = await this.db(m).assistSiteConversation.findMany({
      where: { AND: and },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: {
        id: true,
        createdAt: true,
        lastMessageAt: true,
        pageUrl: true,
        locale: true,
        outcome: true,
        flagged: true,
        openedBy: true,
        _count: { select: { messages: true, leads: true } },
        handoffs: {
          orderBy: { requestedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            state: true,
            requestedAt: true,
            assignedMemberId: true,
          },
        },
        messages: {
          where: { role: 'visitor' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { text: true },
        },
      },
    });
    const page = rows.slice(0, q.limit);
    const items: ConversationListItem[] = page.map((r) => {
      const h = r.handoffs[0];
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        lastMessageAt: r.lastMessageAt.toISOString(),
        pageUrl: r.pageUrl,
        locale: r.locale,
        outcome: r.outcome,
        flagged: r.flagged,
        openedBy: r.openedBy,
        preview: (r.messages[0]?.text ?? '').slice(0, PREVIEW_CHARS),
        messages: r._count.messages,
        handoff: h
          ? {
              id: h.id,
              state: h.state as HandoffState,
              requestedAt: h.requestedAt.toISOString(),
              assignedToMe: h.assignedMemberId === m.memberId,
            }
          : null,
        hasLead: r._count.leads > 0,
      };
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor(last.lastMessageAt, last.id)
          : null,
    };
  }

  async get(
    m: AccountMembership,
    siteId: string,
    conversationId: string,
  ): Promise<ConversationView> {
    await this.requireSite(m, siteId);
    const manager = isAssistManager(m);
    const conv = await this.db(m).assistSiteConversation.findFirst({
      where: {
        AND: [
          { id: conversationId, siteId },
          ...(manager ? [] : [this.operatorScope(m)]),
        ],
      },
      select: {
        id: true,
        createdAt: true,
        lastMessageAt: true,
        pageUrl: true,
        locale: true,
        outcome: true,
        openedBy: true,
      },
    });
    // Оператору чужой (не его и не ждущий) диалог — «не найден», без подсказки.
    if (!conv) throw notFound();
    const [messages, handoff, lead] = await Promise.all([
      this.db(m).assistSiteMessage.findMany({
        where: { conversationId: conv.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
        select: {
          id: true,
          role: true,
          text: true,
          lang: true,
          translation: true,
          sources: true,
          actions: true,
          rating: true,
          flags: true,
          trace: true,
          authorMemberId: true,
          createdAt: true,
        },
      }),
      this.db(m).assistSiteHandoff.findFirst({
        where: { conversationId: conv.id },
        orderBy: { requestedAt: 'desc' },
        select: HANDOFF_ROW_SELECT,
      }),
      this.db(m).assistSiteLead.findFirst({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, fieldNames: true, createdAt: true },
      }),
    ]);
    const views: ConversationMessageView[] = messages.map((x) => {
      const tr = x.translation as { lang?: unknown; text?: unknown } | null;
      return {
        id: x.id,
        role: (ROLES as readonly string[]).includes(x.role)
          ? (x.role as ConversationMessageView['role'])
          : 'system',
        text: x.text,
        lang: x.lang,
        translation:
          tr && typeof tr.lang === 'string' && typeof tr.text === 'string'
            ? { lang: tr.lang, text: tr.text }
            : null,
        sources: arr<SiteAnswerSource>(x.sources),
        actions: arr<SiteAction>(x.actions),
        rating: x.rating === 1 || x.rating === -1 ? x.rating : null,
        flags: x.flags,
        // №34: «почему так ответил» — только manager/owner.
        trace: manager && x.trace ? (x.trace as unknown as AnswerTrace) : null,
        authorIsMe: !!x.authorMemberId && x.authorMemberId === m.memberId,
        createdAt: x.createdAt.toISOString(),
      };
    });
    return {
      id: conv.id,
      createdAt: conv.createdAt.toISOString(),
      lastMessageAt: conv.lastMessageAt.toISOString(),
      pageUrl: conv.pageUrl,
      locale: conv.locale,
      outcome: conv.outcome,
      openedBy: conv.openedBy,
      messages: views,
      handoff: handoff ? toHandoffView(handoff, m) : null,
      lead: lead
        ? {
            id: lead.id,
            fieldNames: lead.fieldNames,
            createdAt: lead.createdAt.toISOString(),
          }
        : null,
    };
  }

  /** Последняя передача диалога (для маршрутов take/reply/close/draft по :cid). */
  async handoffIdFor(
    m: AccountMembership,
    siteId: string,
    conversationId: string,
  ): Promise<string> {
    await this.requireSite(m, siteId);
    const h = await this.db(m).assistSiteHandoff.findFirst({
      where: { siteId, conversationId },
      orderBy: { requestedAt: 'desc' },
      select: { id: true },
    });
    if (!h) {
      throw handoffError(
        'HANDOFF_NOT_FOUND',
        'В этом диалоге нет передачи человеку',
        HttpStatus.NOT_FOUND,
      );
    }
    return h.id;
  }
}

@Injectable()
export class HandoffSettingsService {
  /** Часы — параметром (рабочее время в тестах). */
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
    @Optional() private readonly dispatcher?: HandoffDispatcher,
  ) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  async get(
    m: AccountMembership,
    siteId: string,
  ): Promise<HandoffSettingsView> {
    const row = await this.db(m).assistSite.findFirst({
      where: { siteId },
      select: { handoffConfig: true, handoffEtaMinutes: true, timezone: true },
    });
    if (!row) {
      throw handoffError('NOT_FOUND', 'Сайт не найден', HttpStatus.NOT_FOUND);
    }
    const config = effectiveHandoffConfig(row.handoffConfig);
    const operators = await this.operators(m);
    const hasRecipients = operators.some(
      (o) =>
        o.botStarted &&
        !o.botBlocked &&
        (o.role === 'owner' || o.assist !== 'none'),
    );
    const unavailableReason = !config.enabled
      ? 'disabled'
      : !isWithinHours(config, row.timezone, this.now())
        ? 'off_hours'
        : !hasRecipients
          ? 'no_operators'
          : null;
    return {
      config,
      etaMinutes: row.handoffEtaMinutes,
      availableNow: unavailableReason === null,
      unavailableReason,
      operators,
    };
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    config: unknown,
  ): Promise<HandoffSettingsView> {
    const parsed = parseHandoffConfig(config);
    if (!parsed.ok) {
      throw handoffErrorWithDetails(parsed.errors);
    }
    const u = await this.db(m).assistSite.updateMany({
      where: { siteId },
      data: {
        handoffConfig: parsed.config as unknown as Prisma.InputJsonValue,
      },
    });
    if (u.count !== 1) {
      throw handoffError('NOT_FOUND', 'Сайт не найден', HttpStatus.NOT_FOUND);
    }
    this.dispatcher?.forgetRecipients(m.accountId);
    return this.get(m, siteId);
  }

  async operators(m: AccountMembership): Promise<OperatorView[]> {
    const members = await this.db(m).siteAccountMember.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, telegramId: true, role: true, productRoles: true },
    });
    const users = await this.prisma.assistBotUser.findMany({
      where: { telegramId: { in: members.map((x) => x.telegramId) } },
      select: { telegramId: true, startedAt: true, blockedAt: true },
    });
    const byId = new Map(users.map((u) => [u.telegramId.toString(), u]));
    return members.map((x) => {
      const role =
        x.role === 'owner' || x.role === 'manager' || x.role === 'operator'
          ? x.role
          : 'operator';
      const pr = (x.productRoles ?? {}) as Record<string, unknown>;
      const assist =
        role === 'owner'
          ? 'manager'
          : pr.assist === 'manager' || pr.assist === 'operator'
            ? pr.assist
            : 'none';
      const u = byId.get(x.telegramId.toString());
      return {
        memberId: x.id,
        telegramId: x.telegramId.toString(),
        role,
        assist,
        botStarted: !!u?.startedAt,
        botBlocked: !!u?.blockedAt,
        isMe: x.id === m.memberId,
      };
    });
  }
}

function handoffErrorWithDetails(
  errors: Array<{ path: string; code: string }>,
) {
  const e = handoffError(
    'HANDOFF_CONFIG_INVALID',
    'Настройки передачи заполнены неверно',
    HttpStatus.BAD_REQUEST,
  );
  // `errors` фильтр конверта отдаёт в details (PASSTHROUGH_KEYS).
  (e.getResponse() as Record<string, unknown>).errors = errors;
  return e;
}
