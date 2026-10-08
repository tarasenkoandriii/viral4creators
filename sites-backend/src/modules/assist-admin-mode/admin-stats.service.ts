/**
 * «Статистика (сотрудники)» — минимум Э7 (ТЗ §5-тер.13, Р-48): только
 * `assistAdmin: owner`, свои таблицы (диалоги, очередь обучения, журнал
 * вызовов «Админки»), без поведенческого трекинга и без рейтинга
 * сотрудников. По умолчанию — агрегаты ПО РОЛЯМ; разрез «по сотруднику» —
 * только если владелец включил `statsPerEmployee` (тогда у сотрудника в
 * чате плашка прозрачности). Разметка диалогов ИИ, выводы недели и экспорт
 * «Админки» — хвост (assist_admin_conversation_labels/…_insights).
 * Заход 9: блок «Действия» — доля «Да», `unknown`, компенсации и метрики
 * монитора §5-бис.15 п.12 агрегатами предложений на лету.
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
  /** Э8-хвост (6): действия и метрики монитора §5-бис.15 п.12 (на лету). */
  actions: AdminActionStats;
}

/**
 * Действия «Админки» за период (Э8-хвост (6); ТЗ §5-бис.15 п.12) — агрегаты
 * предложений на лету, без своих таблиц:
 *  - доля «Да» среди решённых карточек (Да / (Да + Нет + истекло));
 *  - исходы исполнения и доля `unknown` среди исполненных;
 *  - цепочки «со следами после сбоя» (`unknown` / сбой компенсации);
 *  - компенсации: предложено, принято «Да», успешность; тревога «разметка
 *    отмены устарела» — успешность < 80% на ≥ 10 попытках за 24 ч (без
 *    деградации, только сигнал владельцу в статистике).
 */
export interface AdminActionStats {
  proposed: number;
  confirmed: number;
  rejected: number;
  expired: number;
  /** null — решённых карточек нет. */
  yesShare: number | null;
  done: number;
  failed: number;
  unknown: number;
  /** null — исполнений нет. */
  unknownShare: number | null;
  unrequested: number;
  chainsWithTraces: number;
  compensations: {
    proposed: number;
    confirmed: number;
    done: number;
    failed: number;
    unknown: number;
    /** null — попыток нет. */
    successRate: number | null;
    /** Успешность < 80% на ≥ 10 попытках за последние 24 ч. */
    alert: boolean;
  };
  byOperation: Array<{
    operation: string;
    proposed: number;
    confirmed: number;
    done: number;
    unknown: number;
  }>;
}

/** Порог тревоги компенсаций (ТЗ §5-бис.15 п.12). */
export const COMPENSATION_ALERT = {
  minAttempts: 10,
  minSuccess: 0.8,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

export interface ActionStatRow {
  operation: string;
  status: string;
  attempts: number;
  compensationOf: string | null;
  chainStatus: string | null;
  unrequested: boolean;
  createdAt: Date;
  executedAt: Date | null;
}

const EXECUTED = new Set(['executing', 'done', 'failed', 'unknown']);

/** Чистый расчёт (юнит-тест): строки предложений → агрегаты. */
export function actionStats(
  rows: ActionStatRow[],
  now: Date,
): AdminActionStats {
  // «Да» было: попытка исполнения (attempts > 0) или статус исполнения.
  const yes = (r: ActionStatRow) => r.attempts > 0 || EXECUTED.has(r.status);
  // Исход неизвестен: `unknown`, а также `expired` после «Да» (повтор закрыт
  // по сроку Р-З9-21 или остановкой мемо) — исход мог примениться.
  const unk = (r: ActionStatRow) =>
    r.status === 'unknown' || (r.status === 'expired' && r.attempts > 0);
  const count = (f: (r: ActionStatRow) => boolean) => rows.filter(f).length;
  const confirmed = count(yes);
  const rejected = count((r) => r.status === 'rejected');
  const expired = count((r) => r.status === 'expired' && !yes(r));
  const done = count((r) => r.status === 'done');
  const failed = count((r) => r.status === 'failed');
  const unknown = count(unk);
  const executed = done + failed + unknown;
  const comp = rows.filter((r) => r.compensationOf !== null);
  const cDone = comp.filter((r) => r.status === 'done').length;
  const cFailed = comp.filter((r) => r.status === 'failed').length;
  const cUnknown = comp.filter(unk).length;
  const cAttempts = cDone + cFailed + cUnknown;
  const recent = comp.filter(
    (r) =>
      now.getTime() - (r.executedAt ?? r.createdAt).getTime() <=
        COMPENSATION_ALERT.windowMs &&
      (r.status === 'done' || r.status === 'failed' || unk(r)),
  );
  const recentOk = recent.filter((r) => r.status === 'done').length;
  const ops = new Map<string, AdminActionStats['byOperation'][number]>();
  for (const r of rows) {
    const o = ops.get(r.operation) ?? {
      operation: r.operation,
      proposed: 0,
      confirmed: 0,
      done: 0,
      unknown: 0,
    };
    o.proposed++;
    if (yes(r)) o.confirmed++;
    if (r.status === 'done') o.done++;
    if (unk(r)) o.unknown++;
    ops.set(r.operation, o);
  }
  const decided = confirmed + rejected + expired;
  return {
    proposed: rows.length,
    confirmed,
    rejected,
    expired,
    yesShare: decided ? confirmed / decided : null,
    done,
    failed,
    unknown,
    unknownShare: executed ? unknown / executed : null,
    unrequested: count((r) => r.unrequested),
    chainsWithTraces: count(
      (r) =>
        r.compensationOf === null &&
        (r.chainStatus === 'unknown' ||
          r.chainStatus === 'compensation_failed'),
    ),
    compensations: {
      proposed: comp.length,
      confirmed: comp.filter(yes).length,
      done: cDone,
      failed: cFailed,
      unknown: cUnknown,
      successRate: cAttempts ? cDone / cAttempts : null,
      alert:
        recent.length >= COMPENSATION_ALERT.minAttempts &&
        recentOk / recent.length < COMPENSATION_ALERT.minSuccess,
    },
    byOperation: [...ops.values()]
      .sort((a, b) => b.proposed - a.proposed)
      .slice(0, 20),
  };
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
      // Э8: только вызовы API (чтение и исполнения «Да»), без записей
      // предложений, решений, цепочек и изменений мемо.
      where: {
        siteId,
        at: { gte: since },
        kind: { in: ['read', 'write', 'danger'] },
      },
      _count: { _all: true },
    });
    const tools = new Map<string, { ok: number; failed: number }>();
    for (const l of logs) {
      const t = tools.get(l.operation) ?? { ok: 0, failed: 0 };
      if (l.outcome === 'ok') t.ok += l._count._all;
      else t.failed += l._count._all;
      tools.set(l.operation, t);
    }
    // Э8-хвост (6): действия — по предложениям периода (окно тревоги
    // компенсаций — 24 ч, внутри любого периода экрана).
    const proposals = await db.assistAdminActionProposal.findMany({
      where: { siteId, createdAt: { gte: since } },
      select: {
        operation: true,
        status: true,
        attempts: true,
        compensationOf: true,
        chainStatus: true,
        unrequested: true,
        createdAt: true,
        executedAt: true,
      },
      take: 50_000,
    });
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
      actions: actionStats(proposals, now),
    };
  }
}
