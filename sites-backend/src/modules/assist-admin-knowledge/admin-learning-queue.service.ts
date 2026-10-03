/**
 * Очередь обучения «Админки» — контур (г), Э7 (ТЗ §4-тер.6, §4-тер.15 п.15):
 * кандидаты сотрудников (👎, «правильно так: …»), отказы «не знаю»,
 * ошибки параметров и сбои инструментов — assist_admin_learning_items.
 *
 * Публикует ТОЛЬКО `assistAdmin: owner` (гвард контроллера): «принять» =
 * проверенный ответ в assist_admin_faq (`origin = golden`) через то же ядро
 * FAQ, что экран «Знания для сотрудников» (индексация в базу «Админки»).
 * Ответ пишет владелец (или берёт предложенный сотрудником) — черновика по
 * данным API нет: результаты инструментов знаниями не становятся.
 * Перетока в «Сайт» нет ни в коде, ни в API (Р-34; граф admin↛site).
 */
import { Injectable } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { notFoundSite } from '../site-core/site-core.constants';
import { AdminSourcesService } from './admin-sources.service';

export interface AdminLearningItemView {
  id: string;
  kind: string;
  status: string;
  question: string;
  answer: string | null;
  proposedAnswer: string | null;
  clusterKey: string;
  clusterSize: number;
  faqId: string | null;
  createdAt: string;
}

const notFound = () =>
  new HttpException(
    {
      error: 'LEARNING_ITEM_NOT_FOUND',
      code: 'LEARNING_ITEM_NOT_FOUND',
      message: 'Элемент очереди не найден',
    },
    404,
  );

@Injectable()
export class AdminLearningQueueService {
  constructor(
    private readonly db: SitesDb,
    private readonly sources: AdminSourcesService,
  ) {}

  private async requireSite(m: AccountMembership, siteId: string) {
    const s = await this.db
      .forAccount(m.accountId)
      .site.findFirst({ where: { id: siteId }, select: { id: true } });
    if (!s) throw notFoundSite();
  }

  async list(
    m: AccountMembership,
    siteId: string,
    status: 'new' | 'accepted' | 'rejected' = 'new',
  ): Promise<AdminLearningItemView[]> {
    await this.requireSite(m, siteId);
    const db = this.db.forAccount(m.accountId);
    const rows = await db.assistAdminLearningItem.findMany({
      where: { siteId, status },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const counts = await db.assistAdminLearningItem.groupBy({
      by: ['clusterKey'],
      where: { siteId, status: 'new' },
      _count: { _all: true },
    });
    const size = new Map(counts.map((c) => [c.clusterKey, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      question: r.questionMasked,
      answer: r.answerMasked,
      proposedAnswer: r.proposedAnswer,
      clusterKey: r.clusterKey,
      clusterSize: size.get(r.clusterKey) ?? 1,
      faqId: r.faqId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Принять кандидата: проверенный ответ «Админки»; весь кластер — решён. */
  async accept(
    m: AccountMembership,
    siteId: string,
    itemId: string,
    body: { question?: string; answer: string },
  ) {
    await this.requireSite(m, siteId);
    const db = this.db.forAccount(m.accountId);
    const item = await db.assistAdminLearningItem.findFirst({
      where: { id: itemId, siteId },
    });
    if (!item) throw notFound();
    const faq = await this.sources.core.createFaq(m, siteId, {
      question: (body.question ?? item.questionMasked).slice(0, 500),
      answer: body.answer,
    });
    await db.assistAdminFaq.updateMany({
      where: { id: faq.id },
      data: { origin: 'golden', fromConversationId: item.conversationId },
    });
    const now = new Date();
    await db.assistAdminLearningItem.updateMany({
      where: { siteId, clusterKey: item.clusterKey, status: 'new' },
      data: {
        status: 'accepted',
        faqId: faq.id,
        resolvedByTelegramId: m.telegramId,
        resolvedAt: now,
      },
    });
    return { faqId: faq.id };
  }

  async reject(m: AccountMembership, siteId: string, itemId: string) {
    await this.requireSite(m, siteId);
    const db = this.db.forAccount(m.accountId);
    const n = await db.assistAdminLearningItem.updateMany({
      where: { id: itemId, siteId },
      data: {
        status: 'rejected',
        resolvedByTelegramId: m.telegramId,
        resolvedAt: new Date(),
      },
    });
    if (n.count === 0) throw notFound();
    return { ok: true };
  }
}
