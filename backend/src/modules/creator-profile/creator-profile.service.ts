/**
 * CreatorProfileService — Этап 0 / Фаза 1 маркетплейса (ТЗ на маркетплейс
 * §9, §19–§21; ТЗ на бэкенд §2–§3), плюс §20 (публикация/шеринг): vanity-
 * ссылка, счётчик просмотров, редакционный Featured-бейдж, «похожие
 * креаторы», минимальная аналитика для самого исполнителя.
 *
 * «Стать исполнителем» на этом этапе — не более чем создание
 * CreatorProfile с явным consentGivenAt и обратимым isAcceptingOrders,
 * плюс отметка CREATOR в User.roles (ТЗ §21.8).
 */

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { publicVideoUrl } from '../../common/watermark';
import { UserRole } from '@prisma/client';
import {
  AdminCreatorProfileListResult,
  CreatorCatalogItemView,
  CreatorCatalogResult,
  CreatorProfileView,
  CreatorStatsView,
  SimilarCreatorView,
} from '../../common/types/marketplace.types';
import { CreatorQuizDto, UpdateCreatorProfileDto } from './dto/creator-profile.dto';

function displayNameOf(user: { firstName: string | null; username: string | null }): string | null {
  return user.firstName ?? (user.username ? `@${user.username}` : null);
}

@Injectable()
export class CreatorProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** POST /creator-profiles/quiz — ТЗ §21.8: явное предложение, явное согласие. */
  async createViaQuiz(userId: string, dto: CreatorQuizDto): Promise<CreatorProfileView> {
    if (!dto.consent) {
      throw new ForbiddenException('explicit consent is required to become a Creator');
    }
    const existing = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (existing) {
      throw new ConflictException('this user already has a creator profile');
    }

    let profile;
    try {
      profile = await this.prisma.$transaction(async (tx) => {
        const created = await tx.creatorProfile.create({
          data: {
            userId,
            niches: dto.niches,
            priceRangeMin: dto.priceRangeMin ?? null,
            priceRangeMax: dto.priceRangeMax ?? null,
            bio: dto.bio ?? null,
            contactHandle: dto.contactHandle ?? null,
            slug: dto.slug ?? null,
            consentGivenAt: new Date(),
            socialLinks: {
              create: dto.socialLinks.map((l) => ({ platform: l.platform, url: l.url })),
            },
          },
          include: { socialLinks: true, user: true },
        });

        // roles не взаимоисключающие (ТЗ §21.8) — CREATOR добавляется, а не
        // заменяет то, что уже было (пользователь мог быть CUSTOMER раньше).
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.roles.includes(UserRole.CREATOR)) {
          await tx.user.update({
            where: { id: userId },
            data: { roles: { set: [...user.roles, UserRole.CREATOR] } },
          });
        }

        return created;
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('this vanity link is already taken');
      }
      throw e;
    }

    return this.toView(profile, profile.user);
  }

  async getOwn(userId: string): Promise<CreatorProfileView> {
    const profile = await this.prisma.creatorProfile.findUnique({
      where: { userId },
      include: { socialLinks: true, user: true },
    });
    if (!profile) throw new NotFoundException('no creator profile for this user');
    return this.toView(profile, profile.user);
  }

  /**
   * Обратимость (ТЗ §21.8): isAcceptingOrders выключается/включается тут
   * же, без удаления накопленных лайков/портфолио. socialLinks, если
   * передан, полностью заменяет прежний список (проще для клиента, чем
   * частичный diff по id).
   */
  async updateOwn(userId: string, dto: UpdateCreatorProfileDto): Promise<CreatorProfileView> {
    const existing = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('no creator profile for this user');

    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        if (dto.socialLinks) {
          await tx.creatorSocialLink.deleteMany({ where: { creatorProfileId: existing.id } });
        }
        return tx.creatorProfile.update({
          where: { id: existing.id },
          data: {
            isAcceptingOrders: dto.isAcceptingOrders,
            niches: dto.niches,
            priceRangeMin: dto.priceRangeMin,
            priceRangeMax: dto.priceRangeMax,
            bio: dto.bio,
            contactHandle: dto.contactHandle,
            slug: dto.slug,
            ...(dto.socialLinks
              ? {
                  socialLinks: {
                    create: dto.socialLinks.map((l) => ({ platform: l.platform, url: l.url })),
                  },
                }
              : {}),
          },
          include: { socialLinks: true, user: true },
        });
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('this vanity link is already taken');
      }
      throw e;
    }

    return this.toView(updated, updated.user);
  }

  /**
   * GET /creators/:idOrSlug — публичная страница профиля (§9), доступна
   * без входа. Принимает и cuid, и vanity-slug (§20 №1) одним маршрутом —
   * отдельный роут под slug не заводим, чтобы не дублировать SEO-вес.
   */
  async getPublic(idOrSlug: string): Promise<CreatorProfileView> {
    const profile = await this.prisma.creatorProfile.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: { socialLinks: true, user: true },
    });
    if (!profile) throw new NotFoundException('creator profile not found');
    return this.toView(profile, profile.user);
  }

  /** POST /creators/:id/view — best-effort, тот же приём, что у SharedVideoPage.viewCount (§20 №13). */
  async recordView(idOrSlug: string): Promise<void> {
    await this.prisma.creatorProfile
      .updateMany({
        where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
        data: { viewCount: { increment: 1 } },
      })
      .catch(() => undefined);
  }

  /** §20 №17 — «похожие креаторы» по пересечению ниш, топ-6. */
  async getSimilar(id: string): Promise<SimilarCreatorView[]> {
    const profile = await this.prisma.creatorProfile.findUnique({ where: { id } });
    if (!profile || profile.niches.length === 0) return [];
    const rows = await this.prisma.creatorProfile.findMany({
      where: {
        id: { not: id },
        isAcceptingOrders: true,
        niches: { hasSome: profile.niches },
      },
      include: { user: true },
      take: 6,
    });
    return rows.map((p) => ({ id: p.id, displayName: displayNameOf(p.user), niches: p.niches }));
  }

  /** §20 №14 — минимальная аналитика для самого исполнителя, не публичная. */
  async getOwnStats(userId: string): Promise<CreatorStatsView> {
    const profile = await this.prisma.creatorProfile.findUnique({
      where: { userId },
      include: { portfolioItems: true },
    });
    if (!profile) throw new NotFoundException('no creator profile for this user');
    return {
      profileViewCount: profile.viewCount,
      totalPortfolioViews: profile.portfolioItems.reduce((sum, i) => sum + i.viewCount, 0),
      totalLikes: profile.portfolioItems.reduce((sum, i) => sum + i.likeCount, 0),
      itemCount: profile.portfolioItems.length,
    };
  }

  /**
   * GET /creators — каталог/витрина (§9). Только принимающие заказы
   * сейчас; курсор — id последнего элемента предыдущей страницы (простая
   * keyset-пагинация, без отдельного счётчика total). Featured (§20 №19)
   * сортируются первыми — редакционный выбор оператора, не платный буст.
   */
  async listCatalog(params: {
    niche?: string;
    priceMax?: number;
    cursor?: string | null;
    pageSize: number;
  }): Promise<CreatorCatalogResult> {
    const rows = await this.prisma.creatorProfile.findMany({
      where: {
        isAcceptingOrders: true,
        ...(params.niche ? { niches: { has: params.niche } } : {}),
        ...(params.priceMax != null
          ? { OR: [{ priceRangeMin: null }, { priceRangeMin: { lte: params.priceMax } }] }
          : {}),
      },
      include: {
        user: true,
        portfolioItems: {
          where: { status: 'PUBLISHED' },
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
      },
      orderBy: [{ isFeatured: 'desc' }, { id: 'asc' }],
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      take: params.pageSize + 1,
    });

    const hasMore = rows.length > params.pageSize;
    const page = hasMore ? rows.slice(0, params.pageSize) : rows;

    const items: CreatorCatalogItemView[] = page.map((p) => ({
      id: p.id,
      slug: p.slug,
      displayName: displayNameOf(p.user),
      niches: p.niches,
      priceRangeMin: p.priceRangeMin,
      priceRangeMax: p.priceRangeMax,
      isFeatured: p.isFeatured,
      portfolioPreview: p.portfolioItems.map((i) => ({
        id: i.id,
        thumbnailUrl: i.thumbnailUrl,
        // Аудит-фикс (§9/§22, защита от пиратства): главная страница
        // каталога строит превью портфолио независимо от
        // PortfolioService/AuctionService и была пропущена при первом
        // проходе — показывала настоящий оригинал вместо защищённой
        // версии. Та же резолвинг-логика, что у остальных публичных
        // поверхностей.
        videoUrl: publicVideoUrl(i),
      })),
    }));

    return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /** PATCH /admin/creator-profiles/:id/featured — редакционный бейдж (§20 №19), только оператор. */
  /**
   * GET /admin/creator-profiles — список ВСЕХ профилей (не только
   * isAcceptingOrders: true, в отличие от публичного каталога §9) —
   * оператору нужно видеть и выключенные профили, чтобы решить про
   * Featured (§20 №19).
   */
  async adminList(params: {
    isFeatured?: boolean;
    page: number;
    pageSize: number;
  }): Promise<AdminCreatorProfileListResult> {
    const where = params.isFeatured != null ? { isFeatured: params.isFeatured } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.creatorProfile.findMany({
        where,
        include: { socialLinks: true, user: true, _count: { select: { portfolioItems: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.creatorProfile.count({ where }),
    ]);
    return {
      items: rows.map((p) => ({ ...this.toView(p, p.user), portfolioItemCount: p._count.portfolioItems })),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  async adminSetFeatured(id: string, isFeatured: boolean): Promise<CreatorProfileView> {
    const updated = await this.prisma.creatorProfile.update({
      where: { id },
      data: { isFeatured },
      include: { socialLinks: true, user: true },
    });
    return this.toView(updated, updated.user);
  }

  private toView(
    profile: {
      id: string;
      userId: string;
      slug: string | null;
      niches: string[];
      priceRangeMin: number | null;
      priceRangeMax: number | null;
      bio: string | null;
      isAcceptingOrders: boolean;
      contactHandle: string | null;
      viewCount: number;
      isFeatured: boolean;
      createdAt: Date;
      socialLinks: { id: string; platform: string; url: string }[];
    },
    user: { firstName: string | null; username: string | null },
  ): CreatorProfileView {
    return {
      id: profile.id,
      userId: profile.userId,
      displayName: displayNameOf(user),
      slug: profile.slug,
      niches: profile.niches,
      priceRangeMin: profile.priceRangeMin,
      priceRangeMax: profile.priceRangeMax,
      bio: profile.bio,
      isAcceptingOrders: profile.isAcceptingOrders,
      contactHandle: profile.contactHandle,
      socialLinks: profile.socialLinks,
      viewCount: profile.viewCount,
      isFeatured: profile.isFeatured,
      createdAt: profile.createdAt.toISOString(),
    };
  }
}
