/**
 * Суточная свёртка «Админки» (заход 10, №57; ТЗ §5-тер.13) — UTC-день × роль
 * сотрудника у заказчика (`*` — итог). Только агрегаты ПО РОЛЯМ: разреза
 * «по сотруднику» в свёртке нет (он — только на экране и только при
 * `statsPerEmployee`), рейтинга нет (В-42). Пересчёт идемпотентный
 * (upsert) — три последних дня и дни недавно размеченных диалогов, в кроне
 * assist-admin-embed-run; строки старше `ADMIN_DAILY_RETENTION_DAYS` —
 * уборкой раз в сутки.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { ADMIN_DAILY_USAGE_OPERATIONS } from '../assist-admin-mode/admin-budget';
import { minutesSaved, readTaskMinutes } from './admin-label-schema';
import { addDaysIso } from './admin-report-text';

export const ADMIN_DAILY_RETENTION_DAYS = 400;
export const ROLE_TOTAL = '*';
/** P3 (3): окно «недавно размеченных» (три прохода по 10 мин). */
export const ADMIN_ROLLUP_LABELED_LOOKBACK_MS = 30 * 60 * 1000;
const NO_ROLE = '—';

export interface DayRow {
  role: string;
  conversations: number;
  questions: number;
  refused: number;
  thumbsDown: number;
  labeled: number;
  answerYes: number;
  answerPartial: number;
  toolErrors: number;
  proposed: number;
  confirmed: number;
  actionsFailed: number;
  minutesSaved: number;
  taskTypes: Record<string, number>;
  costMicroUsd: number;
}

export interface DayInput {
  convs: Array<{ id: string; employeeRole: string | null }>;
  /** Роль диалога для сообщений/предложений, чей диалог начат раньше. */
  convRole: Map<string, string | null>;
  msgs: Array<{
    conversationId: string;
    role: string;
    answerPath: string | null;
    rating: number | null;
    costMicroUsd: number;
  }>;
  labels: Array<{
    employeeRole: string | null;
    taskType: string;
    answerFound: string;
    toolError: boolean;
    status: string;
  }>;
  proposals: Array<{
    conversationId: string;
    status: string;
    attempts: number;
  }>;
  minutes: unknown;
  usageCostMicroUsd: number;
}

function empty(role: string): DayRow {
  return {
    role,
    conversations: 0,
    questions: 0,
    refused: 0,
    thumbsDown: 0,
    labeled: 0,
    answerYes: 0,
    answerPartial: 0,
    toolErrors: 0,
    proposed: 0,
    confirmed: 0,
    actionsFailed: 0,
    minutesSaved: 0,
    taskTypes: {},
    costMicroUsd: 0,
  };
}

const EXECUTED = new Set(['executing', 'done', 'failed', 'unknown']);

/** Чистый расчёт дня (юнит-тест): строки → свёртка по ролям + итог `*`. */
export function rollupDay(d: DayInput): DayRow[] {
  const rows = new Map<string, DayRow>();
  const at = (role: string | null | undefined) => {
    const r = role ?? NO_ROLE;
    const row = rows.get(r) ?? empty(r);
    rows.set(r, row);
    return row;
  };
  const total = empty(ROLE_TOTAL);
  const both = (role: string | null | undefined, f: (r: DayRow) => void) => {
    f(at(role));
    f(total);
  };
  for (const c of d.convs) both(c.employeeRole, (r) => r.conversations++);
  for (const m of d.msgs) {
    const role = d.convRole.get(m.conversationId);
    both(role, (r) => {
      if (m.role === 'employee') r.questions++;
      if (m.role === 'assistant') {
        if (m.answerPath === 'refused') r.refused++;
        if (m.rating === -1) r.thumbsDown++;
        r.costMicroUsd += m.costMicroUsd;
      }
    });
  }
  const minutes = readTaskMinutes(d.minutes);
  for (const l of d.labels) {
    both(l.employeeRole, (r) => {
      r.labeled++;
      if (l.answerFound === 'yes') r.answerYes++;
      if (l.answerFound === 'partial') r.answerPartial++;
      if (l.toolError) r.toolErrors++;
      r.taskTypes[l.taskType] = (r.taskTypes[l.taskType] ?? 0) + 1;
      r.minutesSaved += minutesSaved([l], minutes);
    });
  }
  for (const p of d.proposals) {
    const role = d.convRole.get(p.conversationId);
    both(role, (r) => {
      r.proposed++;
      if (p.attempts > 0 || EXECUTED.has(p.status)) r.confirmed++;
      if (p.status === 'failed') r.actionsFailed++;
    });
  }
  total.costMicroUsd += Math.max(0, Math.round(d.usageCostMicroUsd));
  return [total, ...rows.values()];
}

@Injectable()
export class AdminRollup {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
  ) {}

  /** Сайты с активностью «Админки» с начала вчерашних суток. */
  async activeSites(
    since: Date,
    siteIds?: string[] | null,
  ): Promise<Array<{ accountId: string; siteId: string }>> {
    // P3 (4): сначала сайты, чья свёртка давнее всех (срок тика обрывает
    // хвост — пусть это будут свежие, а не одни и те же).
    return this.prisma.$queryRawUnsafe(
      `SELECT a."accountId", a."siteId" FROM (
         SELECT DISTINCT c."accountId", c."siteId"
           FROM "sites"."assist_admin_conversations" c
           JOIN "sites"."assist_admin_settings" s
             ON s."siteId" = c."siteId" AND s."accountId" = c."accountId"
          WHERE c."lastActivityAt" >= $1
            AND ($2::text[] IS NULL OR c."siteId" = ANY($2::text[]))) a
       LEFT JOIN LATERAL (
         SELECT max(d."updatedAt") AS at FROM "sites"."assist_admin_daily_stats" d
          WHERE d."siteId" = a."siteId" AND d."role" = '${ROLE_TOTAL}') r ON true
       ORDER BY r.at ASC NULLS FIRST
       LIMIT 500`,
      since,
      siteIds ?? null,
    );
  }

  /**
   * P3 (3): дни начала диалогов, размеченных с `since` (разметка приходит
   * через ≥ 8 ч и пишется в день начала диалога — он может быть старше трёх
   * последних дней).
   */
  async labeledDays(
    since: Date,
    siteIds?: string[] | null,
  ): Promise<Array<{ accountId: string; siteId: string; day: string }>> {
    return this.prisma.$queryRawUnsafe(
      `SELECT DISTINCT "accountId", "siteId", to_char("conversationAt", 'YYYY-MM-DD') AS day
         FROM "sites"."assist_admin_conversation_labels"
        WHERE "labeledAt" >= $1
          AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))
        LIMIT 2000`,
      since,
      siteIds ?? null,
    );
  }

  /** Пересчитать день сайта (UTC `YYYY-MM-DD`) — upsert, идемпотентно. */
  async day(accountId: string, siteId: string, day: string): Promise<number> {
    const db = this.sitesDb.forAccount(accountId);
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(`${addDaysIso(day, 1)}T00:00:00Z`);
    const range = { gte: start, lt: end };
    const [settings, convs, msgs, labels, proposals, usage] = await Promise.all(
      [
        db.assistAdminSettings.findFirst({
          where: { siteId },
          select: { analyticsTaskMinutes: true },
        }),
        db.assistAdminConversation.findMany({
          where: { siteId, createdAt: range },
          select: { id: true, employeeRole: true },
        }),
        db.assistAdminMessage.findMany({
          where: { siteId, createdAt: range },
          select: {
            conversationId: true,
            role: true,
            answerPath: true,
            rating: true,
            costMicroUsd: true,
          },
        }),
        db.assistAdminConversationLabel.findMany({
          where: { siteId, conversationAt: range },
          select: {
            employeeRole: true,
            taskType: true,
            answerFound: true,
            toolError: true,
            status: true,
          },
        }),
        db.assistAdminActionProposal.findMany({
          where: { siteId, createdAt: range },
          select: { conversationId: true, status: true, attempts: true },
        }),
        db.siteAiUsage.aggregate({
          where: {
            siteId,
            createdAt: range,
            operation: { in: [...ADMIN_DAILY_USAGE_OPERATIONS] },
          },
          _sum: { costMicroUsd: true },
        }),
      ],
    );
    if (!settings) return 0;
    const convRole = new Map<string, string | null>(
      convs.map((c) => [c.id, c.employeeRole]),
    );
    const missing = [
      ...new Set(
        [...msgs, ...proposals]
          .map((x) => x.conversationId)
          .filter((id): id is string => !!id && !convRole.has(id)),
      ),
    ];
    if (missing.length) {
      const older = await db.assistAdminConversation.findMany({
        where: { id: { in: missing } },
        select: { id: true, employeeRole: true },
      });
      for (const c of older) convRole.set(c.id, c.employeeRole);
    }
    const rows = rollupDay({
      convs,
      convRole,
      msgs,
      labels,
      proposals: proposals.map((p) => ({
        conversationId: p.conversationId ?? '',
        status: p.status,
        attempts: p.attempts,
      })),
      minutes: settings.analyticsTaskMinutes,
      usageCostMicroUsd: usage._sum.costMicroUsd ?? 0,
    });
    for (const r of rows) {
      const data = {
        conversations: r.conversations,
        questions: r.questions,
        refused: r.refused,
        thumbsDown: r.thumbsDown,
        labeled: r.labeled,
        answerYes: r.answerYes,
        answerPartial: r.answerPartial,
        toolErrors: r.toolErrors,
        proposed: r.proposed,
        confirmed: r.confirmed,
        actionsFailed: r.actionsFailed,
        minutesSaved: r.minutesSaved,
        taskTypes: r.taskTypes as Prisma.InputJsonValue,
        costMicroUsd: r.costMicroUsd,
      };
      await db.assistAdminDailyStat.upsert({
        where: { siteId_day_role: { siteId, day, role: r.role } },
        create: { accountId, siteId, day, role: r.role, ...data },
        update: data,
      });
    }
    // Роль, которой в этот день больше нет (пересчёт после ретенции), — прочь.
    await db.assistAdminDailyStat.deleteMany({
      where: { siteId, day, role: { notIn: rows.map((r) => r.role) } },
    });
    return rows.length;
  }

  /**
   * Тик: три последних дня по активным сайтам и дни диалогов, размеченных за
   * последние `ADMIN_ROLLUP_LABELED_LOOKBACK_MS` (разметка идёт до свёртки в
   * том же проходе — `AdminAnalyticsRunner`). Уборка — `purge`, раз в сутки.
   */
  async tick(p: {
    now: Date;
    deadline: number;
    siteIds?: string[] | null;
  }): Promise<{ sites: number; extraDays: number }> {
    const today = p.now.toISOString().slice(0, 10);
    const days = [addDaysIso(today, -2), addDaysIso(today, -1), today];
    const sites = await this.activeSites(
      new Date(`${days[0]}T00:00:00Z`),
      p.siteIds,
    );
    let n = 0;
    for (const s of sites) {
      if (Date.now() >= p.deadline) break;
      for (const d of days) await this.day(s.accountId, s.siteId, d);
      n++;
    }
    let extra = 0;
    const labeled = await this.labeledDays(
      new Date(p.now.getTime() - ADMIN_ROLLUP_LABELED_LOOKBACK_MS),
      p.siteIds,
    );
    for (const l of labeled) {
      if (Date.now() >= p.deadline) break;
      if (days.includes(l.day)) continue;
      await this.day(l.accountId, l.siteId, l.day);
      extra++;
    }
    return { sites: n, extraDays: extra };
  }

  /** Свёртки старше `ADMIN_DAILY_RETENTION_DAYS` — прочь (раз в сутки). */
  async purge(now: Date, siteIds?: string[] | null): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_admin_daily_stats"
        WHERE "day" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      addDaysIso(now.toISOString().slice(0, 10), -ADMIN_DAILY_RETENTION_DAYS),
      siteIds ?? null,
    );
  }
}
