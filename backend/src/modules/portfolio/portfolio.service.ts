/**
 * PortfolioService — Этап 0 / Фаза 1 (ТЗ на маркетплейс §9–§11.1, §10
 * «Важно»), плюс §20 (публикация/шеринг): счётчик просмотров, тематические
 * подборки, лента для RSS/JSON, «похожие работы», уведомление исполнителю
 * о лайках, еженедельная подборка в Telegram-канал платформы.
 *
 * Переиспользует ровно тот паттерн, что уже есть у SharedVideoPage/
 * SharedVideoLike (модерация PENDING → PUBLISHED/REJECTED, лайк по паре
 * userId+itemId) — см. shared-video.service.ts.
 *
 * sourceType здесь всегда SELF_UPLOAD: CONTRACT (двойное согласие,
 * публикация из завершённой сделки) — это Фаза 2, ещё не строится.
 */

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import {
  AdminPortfolioListResult,
  PortfolioCollectionSummaryView,
  PortfolioFeedItemView,
  PortfolioItemView,
  SimilarPortfolioItemView,
} from '../../common/types/marketplace.types';
import {
  CreatePortfolioItemDto,
  RejectPortfolioItemDto,
  UpdatePortfolioItemDto,
} from './dto/portfolio.dto';

/** Уведомляем не на каждый лайк подряд — только на первом и каждом десятом (§20 №18). */
function isNotifyWorthy(likeCount: number): boolean {
  return likeCount === 1 || likeCount % 10 === 0;
}

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
  ) {}

  private async ownCreatorProfileOrThrow(userId: string) {
    const profile = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new ForbiddenException(
        'complete the creator quiz first (POST /creator-profiles/quiz)',
      );
    }
    return profile;
  }

  async create(userId: string, dto: CreatePortfolioItemDto): Promise<PortfolioItemView> {
    const profile = await this.ownCreatorProfileOrThrow(userId);
    const item = await this.prisma.portfolioItem.create({
      data: {
        creatorProfileId: profile.id,
        sourceType: 'SELF_UPLOAD',
        videoUrl: dto.videoUrl,
        title: dto.title,
        thumbnailUrl: dto.thumbnailUrl ?? null,
        collectionTag: dto.collectionTag ?? null,
        creatorConsent: true,
        // customerConsent остаётся false намеренно — на Этапе 0 нет
        // стороннего заказчика, поле актуально только для sourceType=CONTRACT.
      },
    });
    return this.toView(item, false);
  }

  async listMine(userId: string): Promise<PortfolioItemView[]> {
    const profile = await this.ownCreatorProfileOrThrow(userId);
    const items = await this.prisma.portfolioItem.findMany({
      where: { creatorProfileId: profile.id },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => this.toView(i, false));
  }

  /** PATCH /portfolio-items/:id — сейчас только сама подборка (§20 №20), не статус/видео. */
  async updateOwn(
    userId: string,
    id: string,
    dto: UpdatePortfolioItemDto,
  ): Promise<PortfolioItemView> {
    const profile = await this.ownCreatorProfileOrThrow(userId);
    const item = await this.prisma.portfolioItem.findUnique({ where: { id } });
    if (!item || item.creatorProfileId !== profile.id) {
      throw new NotFoundException('portfolio item not found');
    }
    const updated = await this.prisma.portfolioItem.update({
      where: { id },
      data: { collectionTag: dto.collectionTag },
    });
    return this.toView(updated, false);
  }

  /** DELETE /portfolio-items/:id — отзыв в любом статусе, только владельцем. */
  async withdraw(userId: string, id: string): Promise<void> {
    const profile = await this.ownCreatorProfileOrThrow(userId);
    const item = await this.prisma.portfolioItem.findUnique({ where: { id } });
    if (!item || item.creatorProfileId !== profile.id) {
      throw new NotFoundException('portfolio item not found');
    }
    await this.prisma.portfolioItem.delete({ where: { id } });
  }

  /** GET /creators/:creatorProfileId/portfolio — публичный грид (§9). */
  async listPublicForCreator(
    creatorProfileId: string,
    viewerUserId: string | null,
  ): Promise<PortfolioItemView[]> {
    const items = await this.prisma.portfolioItem.findMany({
      where: { creatorProfileId, status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      include: viewerUserId
        ? { likes: { where: { userId: viewerUserId }, select: { id: true } } }
        : undefined,
    });
    return items.map((i) => this.toView(i, viewerUserId ? (i as any).likes.length > 0 : false));
  }

  async getPublic(id: string, viewerUserId: string | null): Promise<PortfolioItemView> {
    const item = await this.prisma.portfolioItem.findUnique({
      where: { id },
      include: viewerUserId
        ? { likes: { where: { userId: viewerUserId }, select: { id: true } } }
        : undefined,
    });
    if (!item || item.status !== 'PUBLISHED') {
      throw new NotFoundException('portfolio item not found');
    }
    return this.toView(item, viewerUserId ? (item as any).likes.length > 0 : false);
  }

  /** POST /portfolio-items/:id/view — best-effort счётчик (§20 №13), тот же приём, что у SharedVideoPage. */
  async recordView(id: string): Promise<void> {
    await this.prisma.portfolioItem
      .updateMany({ where: { id, status: 'PUBLISHED' }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);
  }

  /** §20 №17 — «похожие работы»: другие PUBLISHED работы того же исполнителя, затем по нише. */
  async getSimilar(id: string): Promise<SimilarPortfolioItemView[]> {
    const item = await this.prisma.portfolioItem.findUnique({
      where: { id },
      include: { creatorProfile: true },
    });
    if (!item) return [];

    const sameCreator = await this.prisma.portfolioItem.findMany({
      where: { creatorProfileId: item.creatorProfileId, status: 'PUBLISHED', id: { not: id } },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });
    if (sameCreator.length >= 3 || item.creatorProfile.niches.length === 0) {
      return sameCreator.map((i) => this.toSimilarView(i));
    }

    const byNiche = await this.prisma.portfolioItem.findMany({
      where: {
        status: 'PUBLISHED',
        id: { notIn: [id, ...sameCreator.map((i) => i.id)] },
        creatorProfile: { niches: { hasSome: item.creatorProfile.niches } },
      },
      orderBy: { createdAt: 'desc' },
      take: 6 - sameCreator.length,
    });
    return [...sameCreator, ...byNiche].map((i) => this.toSimilarView(i));
  }

  /** GET /portfolio-items/feed — плоская лента для RSS/JSON (§20 №11). */
  async getFeed(limit: number): Promise<PortfolioFeedItemView[]> {
    const items = await this.prisma.portfolioItem.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { creatorProfile: { include: { user: true } } },
    });
    return items.map((i) => ({
      id: i.id,
      creatorProfileId: i.creatorProfileId,
      creatorDisplayName:
        i.creatorProfile.user.firstName ??
        (i.creatorProfile.user.username ? `@${i.creatorProfile.user.username}` : null),
      title: i.title,
      videoUrl: i.videoUrl,
      thumbnailUrl: i.thumbnailUrl,
      niches: i.creatorProfile.niches,
      createdAt: i.createdAt.toISOString(),
    }));
  }

  /** GET /portfolio-items/collections — список подборок с числом работ (§20 №20). */
  async listCollections(): Promise<PortfolioCollectionSummaryView[]> {
    const rows = await this.prisma.portfolioItem.groupBy({
      by: ['collectionTag'],
      where: { status: 'PUBLISHED', collectionTag: { not: null } },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ tag: r.collectionTag as string, itemCount: r._count._all }))
      .sort((a, b) => b.itemCount - a.itemCount);
  }

  /** GET /portfolio-items/collections/:tag — работы конкретной подборки (§20 №20). */
  async listByCollection(tag: string): Promise<PortfolioItemView[]> {
    const items = await this.prisma.portfolioItem.findMany({
      where: { status: 'PUBLISHED', collectionTag: tag },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => this.toView(i, false));
  }

  /**
   * Лайк — переиспользует ровно паттерн SharedVideoLike (ТЗ §11.1):
   * уникальная пара (userId, portfolioItemId), likeCount денормализован
   * на самой карточке. Любой залогиненный пользователь, не только
   * участники сделки — которой на Этапе 0 и нет. На порогах — DM
   * исполнителю (§20 №18), best-effort, не влияет на ответ запроса.
   */
  async like(userId: string, id: string): Promise<{ likeCount: number; likedByViewer: boolean }> {
    const item = await this.prisma.portfolioItem.findUnique({ where: { id } });
    if (!item || item.status !== 'PUBLISHED') {
      throw new NotFoundException('portfolio item not found');
    }
    try {
      await this.prisma.$transaction([
        this.prisma.portfolioLike.create({ data: { userId, portfolioItemId: id } }),
        this.prisma.portfolioItem.update({
          where: { id },
          data: { likeCount: { increment: 1 } },
        }),
      ]);
    } catch (e: unknown) {
      // Аудит-фикс: раньше здесь проглатывалась ЛЮБАЯ ошибка транзакции,
      // не только «уже лайкнуто» (P2002 на уникальной паре userId+item) —
      // при реальном сбое БД метод молча возвращал бы «likedByViewer: true»,
      // хотя лайк не записался. Прокидываем всё, кроме дубликата.
      if ((e as { code?: string })?.code !== 'P2002') {
        throw e;
      }
    }
    const fresh = await this.prisma.portfolioItem.findUniqueOrThrow({ where: { id } });
    if (isNotifyWorthy(fresh.likeCount)) {
      void this.notifyCreatorOfLikes(fresh.creatorProfileId, fresh.title, fresh.likeCount);
    }
    return { likeCount: fresh.likeCount, likedByViewer: true };
  }

  async unlike(userId: string, id: string): Promise<{ likeCount: number; likedByViewer: boolean }> {
    const existing = await this.prisma.portfolioLike.findUnique({
      where: { userId_portfolioItemId: { userId, portfolioItemId: id } },
    });
    if (existing) {
      await this.prisma.$transaction([
        this.prisma.portfolioLike.delete({ where: { id: existing.id } }),
        this.prisma.portfolioItem.update({
          where: { id },
          data: { likeCount: { decrement: 1 } },
        }),
      ]);
    }
    const fresh = await this.prisma.portfolioItem.findUniqueOrThrow({ where: { id } });
    return { likeCount: fresh.likeCount, likedByViewer: false };
  }

  private async notifyCreatorOfLikes(
    creatorProfileId: string,
    title: string,
    likeCount: number,
  ): Promise<void> {
    try {
      const profile = await this.prisma.creatorProfile.findUnique({
        where: { id: creatorProfileId },
        include: { user: true },
      });
      if (!profile) return;
      const word = likeCount === 1 ? 'первый лайк' : `${likeCount}-й лайк`;
      await this.notify.dm(
        profile.user.telegramId,
        `❤️ Работа «${title}» получила ${word} на витрине viral4creators.`,
      );
    } catch {
      // best-effort — заблокированный бот/сетевой сбой не должны ничего ронять
    }
  }

  /**
   * §20 №8 — еженедельная подборка в Telegram-канал платформы. Ручной
   * admin-триггер, не cron: автоматизация публикации по расписанию —
   * следующий шаг, не часть этого прохода (см. DELIVERY-NOTES).
   */
  async adminBroadcastTopOfWeek(): Promise<{ sent: boolean; count: number }> {
    const channelId = process.env.TELEGRAM_MARKETPLACE_CHANNEL_ID?.trim();
    if (!channelId) return { sent: false, count: 0 };

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const top = await this.prisma.portfolioItem.findMany({
      where: { status: 'PUBLISHED', createdAt: { gte: since } },
      orderBy: { likeCount: 'desc' },
      take: 5,
      include: { creatorProfile: { include: { user: true } } },
    });
    if (top.length === 0) return { sent: false, count: 0 };

    const lines = top.map((i, idx) => {
      const name =
        i.creatorProfile.user.firstName ??
        (i.creatorProfile.user.username ? `@${i.creatorProfile.user.username}` : 'исполнитель');
      return `${idx + 1}. «${i.title}» — ${name} (${i.likeCount}❤️)\n${i.videoUrl}`;
    });
    const sent = await this.notify.dm(
      channelId,
      `🏆 Лучшие работы недели на витрине viral4creators:\n\n${lines.join('\n\n')}`,
    );
    return { sent, count: top.length };
  }

  // ── Admin (по образцу AdminSharedVideoController) ───────────────────

  async adminList(params: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<AdminPortfolioListResult> {
    const where = params.status ? { status: params.status as any } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.portfolioItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.portfolioItem.count({ where }),
    ]);
    return {
      items: items.map((i) => this.toView(i, false)),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  async adminApprove(id: string, moderatorId: string): Promise<PortfolioItemView> {
    const item = await this.prisma.portfolioItem.update({
      where: { id },
      data: { status: 'PUBLISHED', moderatedById: moderatorId, rejectionReason: null },
    });
    return this.toView(item, false);
  }

  async adminReject(
    id: string,
    moderatorId: string,
    dto: RejectPortfolioItemDto,
  ): Promise<PortfolioItemView> {
    const item = await this.prisma.portfolioItem.update({
      where: { id },
      data: { status: 'REJECTED', moderatedById: moderatorId, rejectionReason: dto.reason },
    });
    return this.toView(item, false);
  }

  private toSimilarView(item: {
    id: string;
    creatorProfileId: string;
    title: string;
    thumbnailUrl: string | null;
    videoUrl: string;
  }): SimilarPortfolioItemView {
    return {
      id: item.id,
      creatorProfileId: item.creatorProfileId,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      videoUrl: item.videoUrl,
    };
  }

  private toView(
    item: {
      id: string;
      creatorProfileId: string;
      sourceType: string;
      videoUrl: string;
      title: string;
      thumbnailUrl: string | null;
      status: string;
      likeCount: number;
      viewCount: number;
      collectionTag: string | null;
      rejectionReason?: string | null;
      createdAt: Date;
    },
    likedByViewer: boolean,
  ): PortfolioItemView {
    return {
      id: item.id,
      creatorProfileId: item.creatorProfileId,
      sourceType: item.sourceType as PortfolioItemView['sourceType'],
      videoUrl: item.videoUrl,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      status: item.status as PortfolioItemView['status'],
      likeCount: item.likeCount,
      viewCount: item.viewCount,
      collectionTag: item.collectionTag,
      rejectionReason: item.rejectionReason ?? null,
      likedByViewer,
      createdAt: item.createdAt.toISOString(),
    };
  }
}
