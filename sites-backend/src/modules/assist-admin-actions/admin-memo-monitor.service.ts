/**
 * Монитор мемо «Админки» — «требует проверки» (аудит 06.10.2026; ТЗ
 * §5-бис.17 п.8 п.4–5, п.12 «прогоны и `needs_review` — в мониторе»).
 * Отдельного крона нет (Vercel Hobby): как монитор голосового управления
 * «Админки» — на концах запусков (сбой запуска → проверка ЭТОГО мемо сразу,
 * `AdminMemoService.onRunFailed`) плюс страховочный проход по всем кабинетам
 * в существующем кроне «Админки» `assist-admin-retention`.
 *
 * Решение — `decideAdminMemoReview` (пороги `MEMO_REVIEW` ядра): сбой/
 * `pinMismatch` на одном шаге у ≥ 3 разных сотрудников за 7 дней или успех
 * цели < 60% на ≥ 10 запусках — мемо `needs_review` с причиной (в бою не
 * исполняется: вызов по номеру — «не найдено или выключено», по фразе —
 * обычный ход), владельцу — уведомление, в журнал — запись `memo`.
 * Считаются запуски ТОЛЬКО опубликованной версии: сбои старой версии не
 * возвращают исправленную в «требует проверки». Само-лечения нет: выход —
 * новая версия, сухой прогон и публикация владельцем.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import { MEMO_REVIEW } from '../assist-ui-core/memo';
import { AdminActionsNotifier } from './action-notifier';
import { AdminMemoService } from './admin-memo.service';
import { decideAdminMemoReview } from './admin-memo-review';

export interface AdminMemoMonitorResult {
  checked: number;
  reviews: number;
}

@Injectable()
export class AdminMemoMonitorService {
  private readonly logger = new Logger(AdminMemoMonitorService.name);
  now: () => Date = () => new Date();
  /** Только тесты: кабинеты прохода (наборы на общей базе идут параллельно). */
  onlyAccountIds: string[] | null = null;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly log: AdminActionLogService,
    private readonly notifier: AdminActionsNotifier,
    memos: AdminMemoService,
  ) {
    memos.onRunFailed = (accountId, memoId) =>
      this.reviewMemo(accountId, memoId);
  }

  /** Страховочный проход: все опубликованные мемо «Админки». */
  async run(now = this.now()): Promise<AdminMemoMonitorResult> {
    const memos = await this.sitesDb
      .system('монитор мемо «Админки»: опубликованные мемо всех кабинетов')
      .assistAdminMemo.findMany({
        where: {
          status: 'published',
          publishedVersion: { not: null },
          ...(this.onlyAccountIds
            ? { accountId: { in: this.onlyAccountIds } }
            : {}),
        },
        select: { id: true, accountId: true },
        orderBy: { updatedAt: 'asc' },
        take: 2_000,
      });
    let reviews = 0;
    for (const m of memos) {
      try {
        if (await this.reviewMemo(m.accountId, m.id, now)) reviews++;
      } catch (e) {
        this.logger.error(`мемо «Админки» ${m.id}: ${(e as Error).name}`);
      }
    }
    if (reviews) this.logger.log(`мемо «Админки» → needs_review: ${reviews}`);
    return { checked: memos.length, reviews };
  }

  /** Одно мемо: перевести в `needs_review`, если пороги пройдены. */
  async reviewMemo(
    accountId: string,
    memoId: string,
    now = this.now(),
  ): Promise<boolean> {
    const db = this.sitesDb.forAccount(accountId);
    const memo = await db.assistAdminMemo.findFirst({
      where: {
        id: memoId,
        status: 'published',
        publishedVersion: { not: null },
      },
      select: { id: true, siteId: true, number: true, publishedVersion: true },
    });
    if (!memo || memo.publishedVersion === null) return false;
    const runs = await db.assistAdminMemoRun.findMany({
      where: {
        siteId: memo.siteId,
        memoId: memo.id,
        memoVersion: memo.publishedVersion,
        createdAt: { gte: new Date(now.getTime() - MEMO_REVIEW.windowMs) },
      },
      select: {
        actor: true,
        status: true,
        step: true,
        goalStatus: true,
        progress: true,
        createdAt: true,
      },
      take: 5_000,
    });
    const reason = decideAdminMemoReview(runs, memo.publishedVersion, now);
    if (!reason) return false;
    // Условно: человек мог выключить/переопубликовать мемо между чтением и
    // записью — их решение не затираем.
    const w = await db.assistAdminMemo.updateMany({
      where: {
        id: memo.id,
        status: 'published',
        publishedVersion: memo.publishedVersion,
      },
      data: {
        status: 'needs_review',
        reviewReason: reason as unknown as Prisma.InputJsonValue,
      },
    });
    if (w.count !== 1) return false;
    await this.log.append({
      accountId,
      siteId: memo.siteId,
      actor: 'system:monitor',
      actorRole: null,
      channel: 'embed',
      conversationId: null,
      connectorId: null,
      operationRowId: null,
      operation: `memo:АМ-${memo.number}`,
      kind: 'memo',
      outcome: 'needs_review',
      httpStatus: null,
      durationMs: null,
      requestMasked: {
        memo: memo.id,
        ...reason,
      } as unknown as Prisma.InputJsonValue,
      responseBytes: null,
      error: null,
    });
    await this.notifier
      .memoReview({
        accountId,
        siteId: memo.siteId,
        number: memo.number,
        code: reason.code,
        step: reason.step,
      })
      .catch(() => undefined);
    return true;
  }
}
