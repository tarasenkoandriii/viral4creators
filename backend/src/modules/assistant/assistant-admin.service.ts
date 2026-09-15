/**
 * AssistantAdminService — данные для вкладки «ИИ-консультант» в админке
 * (ТЗ §9/§10): настройки + сегодняшние счётчики, лента обменов с
 * фильтрами, агрегаты за 7/30 дней.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  AssistantSettingsService,
  AssistantSettingsView,
  SetAssistantSettingsInput,
} from './assistant-settings.service';
import {
  ASSISTANT_KNOWLEDGE_BUILT_AT,
  ASSISTANT_KNOWLEDGE_COMMIT,
} from './knowledge/generated';

export interface AssistantAdminSettingsView extends AssistantSettingsView {
  knowledgeBuiltAt: string;
  knowledgeCommit: string;
  today: {
    questions: number;
    proactiveQuestions: number;
    spentMicroUsd: number;
    budgetMicroUsd: number;
    percentOfBudget: number;
  };
}

export interface AssistantFeedFilters {
  flagged?: boolean;
  locale?: string;
  stepId?: number;
  search?: string;
  page: number;
  pageSize: number;
}

export interface AssistantAggregates {
  days: number;
  questionsPerDay: number;
  avgCostMicroUsd: number;
  budgetExhaustedCount: number;
  actionsOpenAppShare: number;
  topQuestions: Array<{ question: string; count: number }>;
}

@Injectable()
export class AssistantAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AssistantSettingsService,
    private readonly aiUsage: AiUsageService,
  ) {}

  async getSettings(): Promise<AssistantAdminSettingsView> {
    const s = await this.settings.get();
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [spent, questions, proactiveQuestions] = await Promise.all([
      this.aiUsage.spentTodayForOperation('assistant'),
      this.prisma.assistantExchange.count({
        where: { createdAt: { gte: startOfDay } },
      }),
      this.prisma.assistantExchange.count({
        where: { createdAt: { gte: startOfDay }, triggeredBy: 'proactive' },
      }),
    ]);
    return {
      ...s,
      knowledgeBuiltAt: ASSISTANT_KNOWLEDGE_BUILT_AT,
      knowledgeCommit: ASSISTANT_KNOWLEDGE_COMMIT,
      today: {
        questions,
        proactiveQuestions,
        spentMicroUsd: spent,
        budgetMicroUsd: s.dailyBudgetMicroUsd,
        percentOfBudget:
          s.dailyBudgetMicroUsd > 0
            ? Math.round((spent / s.dailyBudgetMicroUsd) * 100)
            : 0,
      },
    };
  }

  async setSettings(
    input: SetAssistantSettingsInput,
    updatedBy: string,
  ): Promise<AssistantAdminSettingsView> {
    await this.settings.set(input, updatedBy);
    return this.getSettings();
  }

  async feed(filters: AssistantFeedFilters) {
    const where: Record<string, unknown> = {};
    if (filters.flagged !== undefined) where.flagged = filters.flagged;
    if (filters.locale) where.locale = filters.locale;
    if (filters.stepId !== undefined) where.stepId = filters.stepId;
    if (filters.search) {
      where.question = { contains: filters.search, mode: 'insensitive' };
    }
    const [rows, total] = await Promise.all([
      this.prisma.assistantExchange.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.assistantExchange.count({ where }),
    ]);
    return { rows, total, page: filters.page, pageSize: filters.pageSize };
  }

  async aggregates(days: 7 | 30): Promise<AssistantAggregates> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [count, costAgg, budgetExhaustedCount, rows] = await Promise.all([
      this.prisma.assistantExchange.count({
        where: { createdAt: { gte: since } },
      }),
      this.prisma.assistantExchange.aggregate({
        where: { createdAt: { gte: since } },
        _avg: { costMicroUsd: true },
      }),
      this.prisma.assistantEvent.count({
        where: {
          createdAt: { gte: since },
          kind: 'server_error',
          detail: 'budget_exhausted',
        },
      }),
      // §10 — топ вопросов и доля action.open-app считаются в памяти:
      // объём (десятки тысяч строк максимум за 30 дней при потолке
      // бюджета §7.2) не оправдывает более сложный SQL-запрос сейчас.
      this.prisma.assistantExchange.findMany({
        where: { createdAt: { gte: since } },
        select: { question: true, actions: true },
        take: 5000,
      }),
    ]);

    const normalized = new Map<string, number>();
    let withOpenApp = 0;
    for (const row of rows) {
      const key = row.question.trim().toLowerCase().slice(0, 200);
      if (key) normalized.set(key, (normalized.get(key) ?? 0) + 1);
      const actions = row.actions as Array<{ kind?: string }> | null;
      if (actions?.some((a) => a?.kind === 'open-app')) withOpenApp += 1;
    }
    const topQuestions = [...normalized.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([question, count]) => ({ question, count }));

    return {
      days,
      questionsPerDay: Math.round((count / days) * 10) / 10,
      avgCostMicroUsd: Math.round(costAgg._avg.costMicroUsd ?? 0),
      budgetExhaustedCount,
      actionsOpenAppShare: rows.length ? withOpenApp / rows.length : 0,
      topQuestions,
    };
  }
}
