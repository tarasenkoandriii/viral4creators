/**
 * CreatorInquiryService — форма заказа для Этапа 0 (ТЗ на маркетплейс §21).
 * НЕ Tender: нет окна приёма заявок, нет Submission/Contract/Escrow.
 * Заказчик описывает задачу → получает отфильтрованный список
 * исполнителей и техническую подсказку по формату → сам жмёт «Связаться»
 * (сделка и оплата происходят вне платформы, §21.1).
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { STANDARD_ASPECT_RATIOS } from '../../common/aspect-ratio';
import {
  CreatorInquiryMatchView,
  CreatorInquiryView,
  FormatAdviceView,
} from '../../common/types/marketplace.types';
import {
  ContactCreatorDto,
  CreateCreatorInquiryDto,
  TargetPlatform,
} from './dto/creator-inquiry.dto';

/**
 * §21.4 — соответствие площадки и технической подсказки. Переиспользует
 * `STANDARD_ASPECT_RATIOS` (те же значения, что в мастере генерации
 * self-serve продукта, common/aspect-ratio.ts), а не изобретает новый
 * список форматов. Только две доступных ступени качества в проекте —
 * fast/standard (common/veo-model-choice.ts) — третьей нет, поэтому
 * «лучше» для YouTube-преролла означает выбор standard, а не выдуманный
 * третий тир.
 */
const FORMAT_ADVICE: Record<
  TargetPlatform,
  Omit<FormatAdviceView, 'targetPlatform'>
> = {
  instagram_reels: {
    aspectRatio: '9:16',
    quality: 'fast',
    note: 'Вертикальный формат 9:16, быстрого качества достаточно для Reels.',
  },
  tiktok: {
    aspectRatio: '9:16',
    quality: 'fast',
    note: 'Вертикальный формат 9:16, быстрого качества достаточно для TikTok.',
  },
  youtube_shorts: {
    aspectRatio: '9:16',
    quality: 'fast',
    note: 'Вертикальный формат 9:16, быстрого качества достаточно для Shorts.',
  },
  youtube_long: {
    aspectRatio: '16:9',
    quality: 'standard',
    note: 'Горизонтальный 16:9 и повышенное (standard) качество — преролл смотрят на большом экране дольше, чем шортс.',
  },
  other: {
    aspectRatio: STANDARD_ASPECT_RATIOS[1], // '16:9' — безопасный дефолт
    quality: 'fast',
    note: 'Площадка не распознана — 16:9 как безопасный дефолт; уточните у исполнителя перед съёмкой.',
  },
};

@Injectable()
export class CreatorInquiryService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    dto: CreateCreatorInquiryDto,
  ): Promise<CreatorInquiryView> {
    // Аудит-фикс: раньше brandManifestId сохранялся без проверки владения —
    // можно было сослаться на чужой брендбук (стиль, персонажи бренда).
    if (dto.brandManifestId) {
      const manifest = await this.prisma.brandManifest.findUnique({
        where: { id: dto.brandManifestId },
      });
      if (!manifest || manifest.userId !== userId) {
        throw new NotFoundException('brand manifest not found');
      }
    }

    const inquiry = await this.prisma.creatorInquiry.create({
      data: {
        customerId: userId,
        projectId: dto.projectId ?? null,
        productDescription: dto.productDescription,
        isProductLine: dto.isProductLine ?? false,
        goal: dto.goal ?? null,
        targetPlatform: dto.targetPlatform,
        budgetHint: dto.budgetHint ?? null,
        brandManifestId: dto.brandManifestId ?? null,
        // Одношаговая форма — сразу SENT, а не DRAFT: черновика без
        // отдельного шага «сохранить и вернуться» в этом слое нет.
        status: 'SENT',
      },
    });
    return this.toView(inquiry);
  }

  async listMine(userId: string): Promise<CreatorInquiryView[]> {
    const rows = await this.prisma.creatorInquiry.findMany({
      where: { customerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  private async ownInquiryOrThrow(userId: string, id: string) {
    const inquiry = await this.prisma.creatorInquiry.findUnique({
      where: { id },
    });
    if (!inquiry || inquiry.customerId !== userId) {
      throw new NotFoundException('inquiry not found');
    }
    return inquiry;
  }

  /**
   * GET /creator-inquiries/:id — аудит-фикс: раньше страница подбора
   * узнавала «связался ли уже» только из локального useState, который
   * сбрасывался при обновлении страницы, хотя в БД contactedCreatorId
   * сохранён. Теперь можно перечитать актуальное состояние.
   */
  async getOne(userId: string, id: string): Promise<CreatorInquiryView> {
    const inquiry = await this.ownInquiryOrThrow(userId, id);
    return this.toView(inquiry);
  }

  /**
   * §21.3 — подбор без тендера: фильтр каталога по нише/цене, с грубым
   * скорингом по пересечению слов брифа с нишами профиля. Замена на
   * настоящую ИИ-логику (§16 «Подбор исполнителей») — последующий шаг,
   * не часть минимального среза Этапа 0.
   */
  async getMatches(
    userId: string,
    id: string,
  ): Promise<CreatorInquiryMatchView[]> {
    const inquiry = await this.ownInquiryOrThrow(userId, id);
    const haystack =
      `${inquiry.productDescription} ${inquiry.goal ?? ''}`.toLowerCase();

    const profiles = await this.prisma.creatorProfile.findMany({
      where: { isAcceptingOrders: true, userId: { not: userId } },
      include: { user: true },
      take: 200, // Этап 0: без индекса полнотекстового поиска, простой скан достаточно
    });

    const scored = profiles
      .map((p) => {
        let score = p.niches.reduce(
          (acc, niche) =>
            acc + (haystack.includes(niche.toLowerCase()) ? 1 : 0),
          0,
        );
        if (
          inquiry.budgetHint != null &&
          (p.priceRangeMin == null || p.priceRangeMin <= inquiry.budgetHint) &&
          (p.priceRangeMax == null || p.priceRangeMax >= inquiry.budgetHint)
        ) {
          score += 1;
        }
        return { p, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    return scored.map(({ p, score }) => ({
      creatorProfileId: p.id,
      displayName:
        p.user.firstName ?? (p.user.username ? `@${p.user.username}` : null),
      niches: p.niches,
      priceRangeMin: p.priceRangeMin,
      priceRangeMax: p.priceRangeMax,
      contactHandle: p.contactHandle,
      matchScore: score,
    }));
  }

  /** POST /creator-inquiries/:id/contact — заказчик нажал «Связаться» (§21.3). */
  async markContacted(
    userId: string,
    id: string,
    dto: ContactCreatorDto,
  ): Promise<CreatorInquiryView> {
    await this.ownInquiryOrThrow(userId, id);
    const creator = await this.prisma.creatorProfile.findUnique({
      where: { id: dto.creatorProfileId },
    });
    if (!creator) throw new NotFoundException('creator profile not found');
    // Аудит-фикс: раньше принимался любой существующий creatorProfileId,
    // включая исполнителя, который уже не принимает заказы.
    if (!creator.isAcceptingOrders) {
      throw new ConflictException(
        'this creator is not accepting orders anymore',
      );
    }

    const updated = await this.prisma.creatorInquiry.update({
      where: { id },
      data: { status: 'CONTACTED', contactedCreatorId: dto.creatorProfileId },
    });
    return this.toView(updated);
  }

  /** GET /creator-inquiries/:id/format-advice — ТЗ §21.4. */
  async getFormatAdvice(userId: string, id: string): Promise<FormatAdviceView> {
    const inquiry = await this.ownInquiryOrThrow(userId, id);
    const platform = inquiry.targetPlatform as TargetPlatform;
    const advice = FORMAT_ADVICE[platform] ?? FORMAT_ADVICE.other;
    return { targetPlatform: platform, ...advice };
  }

  private toView(row: {
    id: string;
    customerId: string;
    projectId: string | null;
    productDescription: string;
    isProductLine: boolean;
    goal: string | null;
    targetPlatform: string;
    budgetHint: number | null;
    brandManifestId: string | null;
    status: string;
    contactedCreatorId: string | null;
    createdAt: Date;
  }): CreatorInquiryView {
    return {
      id: row.id,
      customerId: row.customerId,
      projectId: row.projectId,
      productDescription: row.productDescription,
      isProductLine: row.isProductLine,
      goal: row.goal,
      targetPlatform: row.targetPlatform,
      budgetHint: row.budgetHint,
      brandManifestId: row.brandManifestId,
      status: row.status as CreatorInquiryView['status'],
      contactedCreatorId: row.contactedCreatorId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
