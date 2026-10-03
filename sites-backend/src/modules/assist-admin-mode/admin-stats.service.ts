/**
 * «Статистика (сотрудники)» — минимум Э7 (ТЗ §5-тер.13, Р-48): только
 * `assistAdmin: owner`, свои таблицы (диалоги, очередь обучения, журнал
 * вызовов «Админки»), без поведенческого трекинга и без рейтинга
 * сотрудников. По умолчанию — агрегаты ПО РОЛЯМ; разрез «по сотруднику» —
 * только если владелец включил `statsPerEmployee` (тогда у сотрудника в
 * чате плашка прозрачности). Разметка диалогов ИИ, выводы недели и экспорт
 * «Админки» — хвост (assist_admin_conversation_labels/…_insights).
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { AdminModeService } from './admin-mode.service';

export interface AdminStatsView {
  days: number;
  conversations: number;
  questions: number;
  refusedShare: number;
  thumbsDown: number;
  learningNew: number;
  topQuestions: Array<{ clusterKey: string; sample: string; count: number }>;
  tools: Array<{ operation: string; ok: number; failed: number }>;
  byRole: Array<{ role: string; conversations: number; questions: number }>;
  /** Только при `statsPerEmployee` (§5-тер.13), иначе null. */
  byEmployee: Array<{ employee: string; questions: number }> | null;
}

@Injectable()
export class AdminStatsService {
  constructor(
    private readonly db: SitesDb,
    private readonly mode: AdminModeService,
  ) {}

  async stats(
    m: AccountMembership,
    siteId: string,
    days: number,
    now = new Date(),
  ): Promise<AdminStatsView> {
    await this.mode.requireSite(m.accountId, siteId);
    const settings = await this.mode.ensureSettings(m.accountId, siteId);
    const db = this.db.forAccount(m.accountId);
    const since = new Date(now.getTime() - days * 86_400_000);
    const convs = await db.assistAdminConversation.findMany({
      where: { siteId, createdAt: { gte: since } },
      select: { id: true, employeeRole: true, employeeRef: true },
    });
    const msgs = await db.assistAdminMessage.findMany({
      where: { siteId, createdAt: { gte: since } },
      select: {
        role: true,
        answerPath: true,
        rating: true,
        conversationId: true,
      },
    });
    const questions = msgs.filter((x) => x.role === 'employee');
    const answers = msgs.filter((x) => x.role === 'assistant');
    const refused = answers.filter((x) => x.answerPath === 'refused').length;
    const items = await db.assistAdminLearningItem.findMany({
      where: { siteId, createdAt: { gte: since } },
      select: { clusterKey: true, questionMasked: true, status: true },
    });
    const clusters = new Map<string, { sample: string; count: number }>();
    for (const it of items) {
      const c = clusters.get(it.clusterKey) ?? {
        sample: it.questionMasked,
        count: 0,
      };
      c.count++;
      clusters.set(it.clusterKey, c);
    }
    const logs = await db.assistAdminActionLog.groupBy({
      by: ['operation', 'outcome'],
      where: { siteId, at: { gte: since } },
      _count: { _all: true },
    });
    const tools = new Map<string, { ok: number; failed: number }>();
    for (const l of logs) {
      const t = tools.get(l.operation) ?? { ok: 0, failed: 0 };
      if (l.outcome === 'ok') t.ok += l._count._all;
      else t.failed += l._count._all;
      tools.set(l.operation, t);
    }
    const convRole = new Map(convs.map((c) => [c.id, c.employeeRole ?? '—']));
    const convEmp = new Map(convs.map((c) => [c.id, c.employeeRef]));
    const roles = new Map<
      string,
      { conversations: number; questions: number }
    >();
    for (const c of convs) {
      const r = roles.get(c.employeeRole ?? '—') ?? {
        conversations: 0,
        questions: 0,
      };
      r.conversations++;
      roles.set(c.employeeRole ?? '—', r);
    }
    const emp = new Map<string, number>();
    for (const q of questions) {
      const role = convRole.get(q.conversationId);
      if (role !== undefined) {
        const r = roles.get(role);
        if (r) r.questions++;
      }
      const e = convEmp.get(q.conversationId);
      if (e) emp.set(e, (emp.get(e) ?? 0) + 1);
    }
    return {
      days,
      conversations: convs.length,
      questions: questions.length,
      refusedShare: answers.length ? refused / answers.length : 0,
      thumbsDown: answers.filter((x) => x.rating === -1).length,
      learningNew: items.filter((x) => x.status === 'new').length,
      topQuestions: [...clusters.entries()]
        .map(([clusterKey, v]) => ({ clusterKey, ...v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      tools: [...tools.entries()]
        .map(([operation, v]) => ({ operation, ...v }))
        .sort((a, b) => b.ok + b.failed - (a.ok + a.failed)),
      byRole: [...roles.entries()].map(([role, v]) => ({ role, ...v })),
      byEmployee: settings.statsPerEmployee
        ? [...emp.entries()].map(([employee, n]) => ({
            employee,
            questions: n,
          }))
        : null,
    };
  }
}
