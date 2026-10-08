/**
 * Кабинет аналитики «Админки» (заход 10, №57; ТЗ §5-тер.13) — только
 * `assistAdmin: owner` (гвард контроллера): разметка за период агрегатами
 * (типы задач, «нашёл ли ответ», ошибки инструментов, «≈ N часов
 * сэкономлено»), выводы недели со статусами и 👍/👎. Разреза «по
 * сотруднику» здесь нет (он — в «Статистике (сотрудники)» и только при
 * `statsPerEmployee`), рейтинга нет (В-42).
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import { adminLiteModel } from './admin-analytics-env';
import {
  ADMIN_TASK_TYPES,
  minutesSaved,
  readTaskMinutes,
} from './admin-label-schema';
import {
  type AdminFinding,
  type AdminInsightItem,
  readFindings,
  readInsightItems,
} from './admin-report-text';

export interface AdminLabelsView {
  days: number;
  /** Разметка выключена владельцем или нет модели — экран так и пишет. */
  labeling: { enabled: boolean; model: boolean };
  conversations: number;
  labeled: number;
  answerYes: number;
  answerPartial: number;
  answerNo: number;
  toolErrors: number;
  failed: number;
  taskTypes: Array<{
    taskType: string;
    count: number;
    found: number;
    minutes: number;
  }>;
  minutesSaved: number;
  taskMinutes: Record<string, number>;
}

export interface AdminInsightView {
  id: string;
  weekStart: string;
  findings: AdminFinding[];
  items: AdminInsightItem[];
  status: string;
  feedback: number | null;
  createdAt: string;
}

@Injectable()
export class AdminAnalyticsCabinet {
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly mode: AdminModeService,
  ) {}

  async labels(
    m: AccountMembership,
    siteId: string,
    days: number,
    now = new Date(),
  ): Promise<AdminLabelsView> {
    await this.mode.requireSite(m.accountId, siteId);
    const s = await this.mode.ensureSettings(m.accountId, siteId);
    const db = this.sitesDb.forAccount(m.accountId);
    const since = new Date(now.getTime() - days * 86_400_000);
    const [conversations, rows] = await Promise.all([
      db.assistAdminConversation.count({
        where: { siteId, createdAt: { gte: since } },
      }),
      db.assistAdminConversationLabel.findMany({
        where: { siteId, conversationAt: { gte: since } },
        select: {
          taskType: true,
          answerFound: true,
          toolError: true,
          status: true,
        },
        take: 50_000,
      }),
    ]);
    const minutes = readTaskMinutes(s.analyticsTaskMinutes);
    const ok = rows.filter((r) => r.status !== 'failed');
    return {
      days,
      labeling: {
        enabled: s.analyticsLabeling,
        model: adminLiteModel(this.env).ok,
      },
      conversations,
      labeled: rows.length,
      answerYes: ok.filter((r) => r.answerFound === 'yes').length,
      answerPartial: ok.filter((r) => r.answerFound === 'partial').length,
      answerNo: ok.filter((r) => r.answerFound === 'no').length,
      toolErrors: rows.filter((r) => r.toolError).length,
      failed: rows.length - ok.length,
      taskTypes: ADMIN_TASK_TYPES.map((t) => {
        const of = ok.filter((r) => r.taskType === t);
        return {
          taskType: t,
          count: of.length,
          found: of.filter((r) => r.answerFound === 'yes').length,
          minutes: minutesSaved(of, minutes),
        };
      }).filter((x) => x.count > 0),
      minutesSaved: minutesSaved(ok, minutes),
      taskMinutes: minutes,
    };
  }

  async insights(
    m: AccountMembership,
    siteId: string,
  ): Promise<AdminInsightView[]> {
    await this.mode.requireSite(m.accountId, siteId);
    const rows = await this.sitesDb
      .forAccount(m.accountId)
      .assistAdminInsight.findMany({
        where: { siteId },
        orderBy: { weekStart: 'desc' },
        take: 12,
      });
    return rows.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      findings: readFindings(r.findings),
      items: readInsightItems(r.text),
      status: r.status,
      feedback: r.feedback,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async patchInsight(
    m: AccountMembership,
    siteId: string,
    insightId: string,
    dto: { status?: 'new' | 'done' | 'dismissed'; feedback?: -1 | 0 | 1 },
    now = new Date(),
  ): Promise<AdminInsightView> {
    await this.mode.requireSite(m.accountId, siteId);
    const db = this.sitesDb.forAccount(m.accountId);
    const w = await db.assistAdminInsight.updateMany({
      where: { id: insightId, siteId },
      data: {
        ...(dto.status !== undefined
          ? {
              status: dto.status,
              doneAt: dto.status === 'done' ? now : null,
            }
          : {}),
        ...(dto.feedback !== undefined
          ? { feedback: dto.feedback === 0 ? null : dto.feedback }
          : {}),
      },
    });
    if (w.count !== 1) {
      throw adminError(404, 'ADMIN_INSIGHT_NOT_FOUND', 'Вывод не найден');
    }
    const r = await db.assistAdminInsight.findFirstOrThrow({
      where: { id: insightId, siteId },
    });
    return {
      id: r.id,
      weekStart: r.weekStart,
      findings: readFindings(r.findings),
      items: readInsightItems(r.text),
      status: r.status,
      feedback: r.feedback,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
