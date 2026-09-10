/**
 * BlogService — CRUD и модерация записей блога (doc/TODO.md §II.3, ТЗ
 * §36, этап 57) + публичное чтение (витрина лендинга — этап 58 отдаёт ей
 * страницы, API уже готов сейчас).
 *
 * Модерация — тот же принцип, что у `PublicationService`/`LibraryService`
 * (§8/§21.1): ничего не публикуется без оператора, причина обязательна
 * при отклонении, `moderatorId`/`moderatedAt` пишутся вместе со сменой
 * статуса.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlogPostStatus, BlogTranslationStatus } from '@prisma/client';
import { blogSlugFor } from './blog-slug';
import { sanitizeBlogHtml } from '../../common/sanitize-blog-html';
import { LOCALE_LANGUAGE_NAMES } from '../grok/grok-translation-prompt';
import {
  AdminBlogPostDetail,
  AdminBlogPostListItem,
  AdminBlogPostPage,
  AdminBlogTranslationView,
  PublicBlogPostDetail,
  PublicBlogPostListItem,
  PublicBlogPostPage,
} from './blog.types';

/** Пять локалей продукта (frontend/landing i18n.ts, этап 55) — см. комментарий в grok-translation-prompt.ts про то, зачем список не импортируется оттуда напрямую. */
export const PRODUCT_LOCALES: readonly string[] = Object.keys(
  LOCALE_LANGUAGE_NAMES,
);

/** Локали, на которые статью ЕЩЁ нужно перевести — все, кроме её собственной. */
export function nonOriginalLocales(originalLocale: string): string[] {
  return PRODUCT_LOCALES.filter((l) => l !== originalLocale);
}

@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async requireRow(id: string) {
    const row = await this.prisma.blogPost.findUnique({
      where: { id },
      include: { translations: true },
    });
    if (!row) throw new NotFoundException('Blog post not found');
    return row;
  }

  // ── Админка ────────────────────────────────────────────────────────

  async adminList(opts: {
    status?: string;
    category?: string;
    page: number;
    pageSize: number;
  }): Promise<AdminBlogPostPage> {
    const where: Record<string, unknown> = {};
    if (opts.status) where.status = opts.status;
    if (opts.category) where.category = opts.category;

    // Явная аннотация — тот же приём, что library.service.ts, чтобы
    // `.map()` ниже не потерял тип элемента до `any` из-за
    // непровалидированного в песочнице Prisma-клиента (см. комментарий
    // о песочнице в PrismaService).
    const [rows, total]: [RowWithTranslationsPartial[], number] =
      await Promise.all([
        this.prisma.blogPost.findMany({
          where,
          include: { translations: { select: { status: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (opts.page - 1) * opts.pageSize,
          take: opts.pageSize,
        }),
        this.prisma.blogPost.count({ where }),
      ]);

    return {
      items: rows.map((row) => toListItem(row)),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async adminGet(id: string): Promise<AdminBlogPostDetail> {
    const row = await this.requireRow(id);
    return toDetail(row);
  }

  /** TODO §II.3: "тот же экран управляет ручными записями". */
  async adminCreateManual(
    operatorId: string,
    dto: {
      category: string;
      title: string;
      bodyHtml: string;
      originalLocale?: string;
    },
  ): Promise<AdminBlogPostDetail> {
    const originalLocale = dto.originalLocale ?? 'ru';
    const row = await this.prisma.blogPost.create({
      data: {
        slug: blogSlugFor(dto.title, cryptoRandomId()),
        status: BlogPostStatus.DRAFT,
        source: 'MANUAL',
        category: dto.category.trim(),
        title: dto.title.trim(),
        // Г-3.1: ручная запись — оператор тоже не источник доверия для
        // сырого HTML (та же санитизация, что у ИИ-черновиков).
        bodyHtml: sanitizeBlogHtml(dto.bodyHtml.trim()),
        originalLocale,
        moderatorId: operatorId,
      },
      include: { translations: true },
    });
    this.logger.log(
      `ручная запись блога создана оператором ${operatorId}: ${row.id}`,
    );
    return toDetail(row);
  }

  /**
   * Правка текста. Меняет статус переводов, которые уже были готовы или
   * поданы в пачку, обратно на PENDING — иначе после правки заголовка/
   * тела на витрине молча висел бы перевод СТАРОГО текста, а оператор бы
   * этого не узнал (тот же класс ошибки, которого solar-shop избегает
   * явным именем языка в промпте — здесь про рассинхрон текста, не языка,
   * но принцип тот же: не позволять переводу тихо разойтись с оригиналом).
   */
  async adminUpdate(
    id: string,
    dto: { title?: string; bodyHtml?: string; category?: string },
  ): Promise<AdminBlogPostDetail> {
    const row = await this.requireRow(id);
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    // Г-3.1: та же санитизация, что у создания ручной записи.
    if (dto.bodyHtml !== undefined)
      data.bodyHtml = sanitizeBlogHtml(dto.bodyHtml.trim());
    if (dto.category !== undefined) data.category = dto.category.trim();
    if (Object.keys(data).length === 0) return toDetail(row);

    const textChanged = dto.title !== undefined || dto.bodyHtml !== undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.blogPost.update({ where: { id }, data });
      if (textChanged) {
        // batchJobId НЕ трогаем: старая пачка xAI отработала честно (по
        // старому тексту), просто её результат больше не годится — новый
        // прогон перевода заведёт новую пачку сам.
        await tx.blogPostTranslation.updateMany({
          where: {
            postId: id,
            status: {
              in: [BlogTranslationStatus.READY, BlogTranslationStatus.QUEUED],
            },
          },
          data: {
            status: BlogTranslationStatus.PENDING,
            title: null,
            bodyHtml: null,
          },
        });
      }
      // Фетч ПОСЛЕ обоих обновлений — translations в ответе отражают
      // сброс, а не состояние до него.
      return tx.blogPost.findUniqueOrThrow({
        where: { id },
        include: { translations: true },
      });
    });

    this.logger.log(
      `запись блога ${id} отредактирована: ${JSON.stringify(Object.keys(data))}`,
    );
    return toDetail(updated);
  }

  /** DRAFT → APPROVED. Переводы ставятся в очередь отдельным прогоном крона. */
  async approve(id: string, operatorId: string): Promise<AdminBlogPostDetail> {
    const row = await this.requireRow(id);
    if (row.status !== BlogPostStatus.DRAFT) {
      throw new BadRequestException(
        `Post is ${row.status}, only DRAFT can be approved`,
      );
    }
    const updated = await this.prisma.blogPost.update({
      where: { id },
      data: {
        status: BlogPostStatus.APPROVED,
        moderatorId: operatorId,
        moderatedAt: new Date(),
        rejectReason: null,
      },
      include: { translations: true },
    });
    return toDetail(updated);
  }

  /** DRAFT|APPROVED → REJECTED, с причиной. */
  async reject(
    id: string,
    operatorId: string,
    reason: string,
  ): Promise<AdminBlogPostDetail> {
    const row = await this.requireRow(id);
    if (row.status === BlogPostStatus.PUBLISHED) {
      throw new BadRequestException(
        'Published post cannot be rejected — unpublish it first',
      );
    }
    if (!reason.trim()) {
      throw new BadRequestException('reason is required to reject a post');
    }
    const updated = await this.prisma.blogPost.update({
      where: { id },
      data: {
        status: BlogPostStatus.REJECTED,
        moderatorId: operatorId,
        moderatedAt: new Date(),
        rejectReason: reason.trim(),
      },
      include: { translations: true },
    });
    return toDetail(updated);
  }

  /** APPROVED → PUBLISHED. Переводы не обязаны быть готовы все сразу — витрина честно помечает недостающие (см. blog.types.ts). */
  async publish(id: string, operatorId: string): Promise<AdminBlogPostDetail> {
    const row = await this.requireRow(id);
    if (row.status !== BlogPostStatus.APPROVED) {
      throw new BadRequestException(
        `Post is ${row.status}, only APPROVED can be published`,
      );
    }
    const updated = await this.prisma.blogPost.update({
      where: { id },
      data: {
        status: BlogPostStatus.PUBLISHED,
        publishedAt: new Date(),
        moderatorId: operatorId,
        moderatedAt: new Date(),
      },
      include: { translations: true },
    });
    return toDetail(updated);
  }

  /** PUBLISHED → APPROVED — снять с витрины без отклонения совсем. */
  async unpublish(
    id: string,
    operatorId: string,
  ): Promise<AdminBlogPostDetail> {
    const row = await this.requireRow(id);
    if (row.status !== BlogPostStatus.PUBLISHED) {
      throw new BadRequestException(`Post is ${row.status}, not PUBLISHED`);
    }
    const updated = await this.prisma.blogPost.update({
      where: { id },
      data: {
        status: BlogPostStatus.APPROVED,
        publishedAt: null,
        moderatorId: operatorId,
        moderatedAt: new Date(),
      },
      include: { translations: true },
    });
    return toDetail(updated);
  }

  async delete(id: string): Promise<void> {
    await this.requireRow(id);
    await this.prisma.blogPost.delete({ where: { id } });
  }

  // ── Публичная витрина (этап 58 её вызывает; API готов сейчас) ────────

  async publicList(opts: {
    locale: string;
    category?: string;
    page: number;
    pageSize: number;
  }): Promise<PublicBlogPostPage> {
    const where: Record<string, unknown> = {
      status: BlogPostStatus.PUBLISHED,
    };
    if (opts.category) where.category = opts.category;

    const [rows, total]: [PublicListRow[], number] = await Promise.all([
      this.prisma.blogPost.findMany({
        where,
        include: {
          translations: {
            where: { locale: opts.locale, status: BlogTranslationStatus.READY },
          },
        },
        orderBy: { publishedAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.blogPost.count({ where }),
    ]);

    return {
      items: rows.map((row) => toPublicListItem(row, opts.locale)),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async publicGetBySlug(
    slug: string,
    locale: string,
  ): Promise<PublicBlogPostDetail> {
    const row = await this.prisma.blogPost.findUnique({
      where: { slug },
      include: {
        translations: {
          where: { locale, status: BlogTranslationStatus.READY },
        },
      },
    });
    if (!row || row.status !== BlogPostStatus.PUBLISHED) {
      throw new NotFoundException('Blog post not found');
    }
    const translation = row.translations[0];
    const isRequestedLocale =
      locale === row.originalLocale || Boolean(translation);
    return {
      slug: row.slug,
      title: translation?.title ?? row.title,
      bodyHtml: translation?.bodyHtml ?? row.bodyHtml,
      category: row.category,
      thumbnailUrl: row.thumbnailUrl,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      isRequestedLocale,
      youtubeVideoId: row.youtubeVideoId,
    };
  }
}

function cryptoRandomId(): string {
  // Короткий читаемый суффикс для слага ручных записей — не нужна
  // криптографическая стойкость, только отсутствие коллизий на глаз;
  // videoId для source=YOUTUBE_TREND играет ту же роль естественно.
  return Math.random().toString(36).slice(2, 10);
}

interface RowWithTranslationsPartial {
  id: string;
  slug: string;
  status: BlogPostStatus;
  source: string;
  category: string;
  title: string;
  thumbnailUrl: string | null;
  score: number | null;
  originalLocale: string;
  publishedAt: Date | null;
  createdAt: Date;
  translations: { status: BlogTranslationStatus }[];
}

function toListItem(row: RowWithTranslationsPartial): AdminBlogPostListItem {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    source: row.source as never,
    category: row.category,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    score: row.score,
    originalLocale: row.originalLocale,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    translationsReady: row.translations.filter(
      (t) => t.status === BlogTranslationStatus.READY,
    ).length,
    translationsTotal: nonOriginalLocales(row.originalLocale).length,
  };
}

interface FullRow extends RowWithTranslationsPartial {
  bodyHtml: string;
  scoreReasoning: string | null;
  youtubeVideoId: string | null;
  youtubeChannelTitle: string | null;
  youtubeViewCount: number | null;
  moderatorId: string | null;
  moderatedAt: Date | null;
  rejectReason: string | null;
  translations: {
    locale: string;
    status: BlogTranslationStatus;
    title: string | null;
    bodyHtml: string | null;
    errorMessage: string | null;
    translatedAt: Date | null;
  }[];
}

function toDetail(row: FullRow): AdminBlogPostDetail {
  return {
    ...toListItem(row),
    bodyHtml: row.bodyHtml,
    scoreReasoning: row.scoreReasoning,
    youtubeVideoId: row.youtubeVideoId,
    youtubeChannelTitle: row.youtubeChannelTitle,
    youtubeViewCount: row.youtubeViewCount,
    moderatorId: row.moderatorId,
    moderatedAt: row.moderatedAt?.toISOString() ?? null,
    rejectReason: row.rejectReason,
    translations: row.translations.map(
      (t): AdminBlogTranslationView => ({
        locale: t.locale,
        status: t.status,
        title: t.title,
        bodyHtml: t.bodyHtml,
        errorMessage: t.errorMessage,
        translatedAt: t.translatedAt?.toISOString() ?? null,
      }),
    ),
  };
}

interface PublicListRow {
  slug: string;
  title: string;
  category: string;
  thumbnailUrl: string | null;
  publishedAt: Date | null;
  originalLocale: string;
  translations: { title: string | null }[];
}

function toPublicListItem(
  row: PublicListRow,
  locale: string,
): PublicBlogPostListItem {
  const translation = row.translations[0];
  const isRequestedLocale =
    locale === row.originalLocale || Boolean(translation);
  return {
    slug: row.slug,
    title: translation?.title ?? row.title,
    category: row.category,
    thumbnailUrl: row.thumbnailUrl,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    isRequestedLocale,
  };
}
