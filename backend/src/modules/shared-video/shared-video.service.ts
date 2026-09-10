/**
 * SharedVideoService — публичная страница готового ролика и петля
 * шеринга (ТЗ §40, этап 60, doc/TODO.md §III.1).
 *
 * Устройство скопировано с `PublicationService` (та же природа снимка —
 * строка переживает TTL сессии, своя копия видео под собственным
 * префиксом), но с двумя принципиальными отличиями:
 *
 *  - у страницы нет площадки-получателя: одобрение сразу делает её
 *    видимой всем на `landing/`, а не переводит в очередь на выгрузку;
 *  - «отозвать» здесь — не «withdraw, пока PENDING» (как у заявки на
 *    публикацию), а полное удаление строки и её блобов В ЛЮБОМ статусе,
 *    в любой момент — только автором. Поэтому `reject()` не удаляет
 *    копию ролика: `withdraw()` доступен и после отказа, и удаление
 *    сделает он.
 *
 * Форк-сторона («Сделать такой же», решение 4 плана этапа 60) —
 * единственный ПУБЛИЧНЫЙ путь без идентификации: создаёт новую сессию и,
 * если у страницы есть привязанный разбор библиотеки и его видимость
 * (§21.3, `LibraryService.canView`) позволяет — применяет тот же разбор
 * БЕЗ гейта тарифа (`LibraryService.applyEntryToSessionFree`). Весь смысл
 * страницы — привести нового пользователя бесплатно; требовать от него
 * сначала завести тариф значило бы свести эту цель на нет.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { SessionService } from '../../common/session.service';
import { LibraryService } from '../library/library.service';
import { BlobService } from '../storage/blob.service';
import { Session } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { normalizeLocale } from '../../common/locale';
import {
  SharedVideoListResult,
  SharedVideoPageView,
  SharedVideoPublicView,
  SharedVideoStatus,
} from '../../common/types/shared-video.types';
import {
  CreateSharedVideoRequestDto,
  ForkSharedVideoRequestDto,
  RejectSharedVideoRequestDto,
} from './dto/shared-video.dto';

/** Structural row type — see project.service.ts for why not Prisma's. */
interface SharedVideoRow {
  id: string;
  userId: string;
  sessionId: string;
  generatedVideoId: string;
  status: SharedVideoStatus;
  videoUrl: string;
  videoPathname: string;
  aspectRatio: string | null;
  title: string;
  productName: string;
  productDescription: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  productImageUrl: string | null;
  productImagePathname: string | null;
  locale: string;
  libraryEntryId: string | null;
  moderatorId: string | null;
  moderatedAt: Date | null;
  rejectReason: string | null;
  viewCount: number;
  firstGenerationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'PUBLISHED',
  'REJECTED',
]);

/** Pure: что копируется в снимок страницы. Exported for tests. */
export function snapshotFromSession(
  session: Session,
  dto: CreateSharedVideoRequestDto,
): {
  videoUrl: string;
  videoPathname: string;
  generatedVideoId: string;
  aspectRatio: string | null;
  title: string;
  productName: string;
  productDescription: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  productImageUrl: string | null;
  productImagePathname: string | null;
  locale: string;
} {
  const video = session.generatedVideo;
  if (
    !video ||
    video.status !== GenerationStatus.COMPLETE ||
    !video.downloadUrl
  ) {
    throw new BadRequestException(
      'No completed video in this session — generate the video first',
    );
  }
  const product = session.productInformation;
  if (!product?.productName) {
    throw new BadRequestException(
      'No product information in this session — add the product first',
    );
  }
  const title = (dto.title ?? product.productName ?? '').trim().slice(0, 100);
  if (!title) {
    throw new BadRequestException(
      'title is required (no product name to fall back to)',
    );
  }
  return {
    // Тот же файл, что видит пользователь — не исходник Veo, если есть
    // постобработка (см. аналогичный комментарий в publication.service.ts).
    videoUrl: video.downloadUrl,
    videoPathname: video.postPathname ?? video.pathname,
    generatedVideoId: video.generatedVideoId,
    aspectRatio: video.renderedAspectRatio ?? video.aspectRatio ?? null,
    title,
    productName: product.productName,
    productDescription: product.productDescription?.trim() || null,
    price: product.price ?? null,
    currency: product.currency ?? null,
    category: product.category?.trim() || null,
    productImageUrl: product.productImageUrl ?? null,
    productImagePathname: product.productImagePathname ?? null,
    // Открытая страница — одна зафиксированная локаль (та, что была у
    // автора на момент публикации); переводов не запрашивалось (решение 5
    // плана этапа 60).
    locale: normalizeLocale(session.locale),
  };
}

export function toView(row: SharedVideoRow): SharedVideoPageView {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    generatedVideoId: row.generatedVideoId,
    status: row.status,
    videoUrl: row.videoUrl,
    aspectRatio: row.aspectRatio,
    title: row.title,
    productName: row.productName,
    productDescription: row.productDescription,
    price: row.price,
    currency: row.currency,
    category: row.category,
    productImageUrl: row.productImageUrl,
    locale: row.locale,
    moderatorId: row.moderatorId,
    moderatedAt: row.moderatedAt?.toISOString() ?? null,
    rejectReason: row.rejectReason,
    viewCount: row.viewCount,
    firstGenerationCount: row.firstGenerationCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPublicView(row: SharedVideoRow): SharedVideoPublicView {
  return {
    id: row.id,
    videoUrl: row.videoUrl,
    aspectRatio: row.aspectRatio,
    title: row.title,
    productName: row.productName,
    productDescription: row.productDescription,
    price: row.price,
    currency: row.currency,
    category: row.category,
    productImageUrl: row.productImageUrl,
    locale: row.locale,
    viewCount: row.viewCount,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class SharedVideoService {
  private readonly logger = new Logger(SharedVideoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly library: LibraryService,
    private readonly blob: BlobService,
  ) {}

  // ── Owner side (TelegramIdentityGuard) ──────────────────────────────────

  /**
   * POST /sessions/:id/shared-video. Требует владельца сессии — та же
   * причина, что и у публикации: анонимная сессия не публикует ничего от
   * своего имени (канала/страницы без владельца не бывает).
   */
  async create(
    userId: string,
    sessionId: string,
    dto: CreateSharedVideoRequestDto,
  ): Promise<SharedVideoPageView> {
    // §23: очередь публикации страницы — от Standard и выше, тот же
    // признак, что и у выгрузки на YouTube/TikTok (переиспользуем, а не
    // заводим отдельный PlanFeature — обе про «выпустить ролик наружу»).
    // Форк-сторона (посетитель, ниже) намеренно этой проверке не
    // подчиняется — см. `fork()`.
    await this.plans.assertUser(userId, 'publication');
    const session = await this.ownSession(userId, sessionId);
    const snap = snapshotFromSession(session, dto);
    const libraryEntryId = await this.resolveLibraryEntryId(
      session.librarySourceKey,
    );

    // Один открытый (PENDING/PUBLISHED) запрос на сессию — тот же приём
    // консультативной блокировки, что и в PublicationService.create(),
    // и по той же причине (частичный уникальный индекс не выражается в
    // schema.prisma, CI сверяет базу со схемой через `migrate diff`).
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shared-video:${sessionId}`}))`;

      const open = await tx.sharedVideoPage.findFirst({
        where: { sessionId, status: { in: ['PENDING', 'PUBLISHED'] } },
        select: { id: true, status: true },
      });
      if (open) {
        throw new ConflictException(
          open.status === 'PUBLISHED'
            ? 'This video already has a public page'
            : 'This video already has a pending shared-page request',
        );
      }

      return (await tx.sharedVideoPage.create({
        data: { userId, sessionId, libraryEntryId, ...snap },
      })) as SharedVideoRow;
    });
    return toView(await this.keepOwnCopy(row));
  }

  /**
   * Ключ записи библиотеки (`sourceKey`) → её `id` — то, что нужно
   * `LibraryService.applyEntryToSessionFree` (этап 60). Best-effort: сбой
   * поиска не должен ронять создание страницы, просто у неё не будет
   * форк-разбора (кнопка «Сделать такой же» тогда откроет TMA пустым, что
   * не хуже обычного визита без ссылки).
   */
  private async resolveLibraryEntryId(
    sourceKey: string | null | undefined,
  ): Promise<string | null> {
    if (!sourceKey) return null;
    try {
      const entry = await this.prisma.analysisLibraryEntry.findUnique({
        where: { sourceKey },
        select: { id: true },
      });
      return entry?.id ?? null;
    } catch (e) {
      this.logger.warn(
        `libraryEntryId resolve failed for ${sourceKey}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  /**
   * Собственные копии ролика и фото товара — переживают TTL сессии, как и
   * у заявки на публикацию (см. комментарий в publication.service.ts).
   * Фото копируется, только если у товара оно вообще было (необязательное
   * поле). Сбой копирования не отменяет создание страницы — она останется
   * со ссылкой на файл сессии, то есть с прежним (более хрупким) поведением.
   */
  private async keepOwnCopy(row: SharedVideoRow): Promise<SharedVideoRow> {
    const videoPathname = `shared-videos/${row.id}/video.mp4`;
    const videoUrl = await this.blob.copyBlob(
      row.videoPathname,
      videoPathname,
      'video/mp4',
    );
    const data: Record<string, unknown> = {};
    if (videoUrl) {
      data.videoUrl = videoUrl;
      data.videoPathname = videoPathname;
    }
    if (row.productImagePathname) {
      const photoPathname = `shared-videos/${row.id}/photo.jpg`;
      const photoUrl = await this.blob.copyBlob(
        row.productImagePathname,
        photoPathname,
        'image/jpeg',
      );
      if (photoUrl) {
        data.productImageUrl = photoUrl;
        data.productImagePathname = photoPathname;
      }
    }
    if (Object.keys(data).length === 0) return row;
    return (await this.prisma.sharedVideoPage.update({
      where: { id: row.id },
      data,
    })) as SharedVideoRow;
  }

  /** GET /sessions/:id/shared-video — страницы этой сессии, новые сверху. */
  async listForSession(
    userId: string,
    sessionId: string,
  ): Promise<SharedVideoPageView[]> {
    await this.ownSession(userId, sessionId);
    const rows: SharedVideoRow[] = await this.prisma.sharedVideoPage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  /**
   * DELETE /sessions/:id/shared-video/:pageId — отозвать в ЛЮБОМ статусе
   * (решение 2 плана этапа 60): полное удаление строки и её собственных
   * блобов, только автором.
   */
  async withdraw(
    userId: string,
    sessionId: string,
    pageId: string,
  ): Promise<void> {
    const row: SharedVideoRow | null =
      await this.prisma.sharedVideoPage.findFirst({
        where: { id: pageId, sessionId, userId },
      });
    if (!row)
      throw new NotFoundException(`Shared video page ${pageId} not found`);
    await this.prisma.sharedVideoPage.delete({ where: { id: pageId } });
    await this.blob.deleteMany([
      `shared-videos/${pageId}/video.mp4`,
      `shared-videos/${pageId}/photo.jpg`,
    ]);
  }

  // ── Public side (no guard — landing + «Сделать такой же») ──────────────

  /**
   * GET /shared-video/:id — только опубликованные страницы видны кому бы
   * то ни было. Бампает счётчик просмотров, best-effort (сбой счётчика не
   * должен превращать открытие страницы в ошибку).
   */
  async getPublic(id: string): Promise<SharedVideoPublicView> {
    const row: SharedVideoRow | null =
      await this.prisma.sharedVideoPage.findUnique({ where: { id } });
    if (!row || row.status !== 'PUBLISHED') {
      throw new NotFoundException(`Shared video page ${id} not found`);
    }
    await this.bumpViewCount(id);
    return toPublicView(row);
  }

  private async bumpViewCount(id: string): Promise<void> {
    try {
      await this.prisma.sharedVideoPage.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `viewCount bump failed for ${id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * POST /shared-video/:id/fork — «Сделать такой же» (решение 4 плана
   * этапа 60). Публичный: новая сессия создаётся анонимно, без
   * идентификации. Если у страницы есть привязанный разбор библиотеки —
   * пробуем применить его тем же путём, что и обычная кнопка «Взять
   * разбор», но без гейта тарифа; `canView` при этом действует как
   * обычно (§21.3), так что приватный разбор чужому не достанется, даже
   * если страница шеринга опубликована.
   */
  async fork(
    id: string,
    dto: ForkSharedVideoRequestDto,
  ): Promise<{ sessionId: string }> {
    const row: SharedVideoRow | null =
      await this.prisma.sharedVideoPage.findUnique({ where: { id } });
    if (!row || row.status !== 'PUBLISHED') {
      throw new NotFoundException(`Shared video page ${id} not found`);
    }
    const session = await this.sessions.createSession(
      undefined,
      undefined,
      dto.locale,
      id,
    );
    if (row.libraryEntryId) {
      try {
        await this.library.applyEntryToSessionFree(
          session.sessionId,
          row.libraryEntryId,
        );
      } catch (e) {
        // Приватный разбор (§21.3) или запись удалена оператором — форк
        // всё равно отдаёт новую сессию, просто без предзаполненного
        // разбора. Обычный визит без ссылки выглядит так же.
        this.logger.warn(
          `fork ${id}: library entry ${row.libraryEntryId} not applicable: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
    return { sessionId: session.sessionId };
  }

  /**
   * Счётчик «дошёл до первой генерации» (виджет конверсии, решение 7
   * плана этапа 60). Вызывается из `GenerationService` при первом
   * завершении рендера сессии, созданной по ссылке шеринга.
   * Best-effort, как и `LibraryService.markUsed()` — сбой счётчика не
   * должен портить пользователю только что законченный ролик.
   */
  async markConverted(pageId: string | null | undefined): Promise<void> {
    if (!pageId) return;
    try {
      await this.prisma.sharedVideoPage.update({
        where: { id: pageId },
        data: { firstGenerationCount: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `firstGenerationCount bump failed for ${pageId}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  // ── Operator side (/admin, behind AdminSessionGuard + isOperator) ──────

  async list(opts: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<SharedVideoListResult> {
    const where =
      opts.status && STATUSES.has(opts.status)
        ? { status: opts.status as SharedVideoStatus }
        : {};
    const [rows, total, pending] = await Promise.all([
      this.prisma.sharedVideoPage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }) as Promise<SharedVideoRow[]>,
      this.prisma.sharedVideoPage.count({ where }),
      this.prisma.sharedVideoPage.count({ where: { status: 'PENDING' } }),
    ]);
    return {
      items: rows.map(toView),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      pending,
    };
  }

  async get(id: string): Promise<SharedVideoPageView> {
    return toView(await this.find(id));
  }

  /** PENDING → PUBLISHED. Страница сразу становится видна на /video/:id. */
  async approve(id: string, moderatorId: string): Promise<SharedVideoPageView> {
    const row = await this.find(id);
    if (row.status !== 'PENDING') {
      throw new BadRequestException(
        `Request is ${row.status}, only PENDING can be approved`,
      );
    }
    const updated: SharedVideoRow = await this.prisma.sharedVideoPage.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        moderatorId,
        moderatedAt: new Date(),
        rejectReason: null,
      },
    });
    return toView(updated);
  }

  /**
   * PENDING → REJECTED, с причиной, которую увидит автор. Копию ролика
   * НЕ удаляем (в отличие от `PublicationService.reject`) — здесь у
   * автора остаётся `withdraw()` в любом статусе, он и уберёт файл, если
   * решит не пересматривать заявку.
   */
  async reject(
    id: string,
    moderatorId: string,
    dto: RejectSharedVideoRequestDto,
  ): Promise<SharedVideoPageView> {
    const row = await this.find(id);
    if (row.status !== 'PENDING') {
      throw new BadRequestException(
        `Request is ${row.status}, only PENDING can be rejected`,
      );
    }
    const updated: SharedVideoRow = await this.prisma.sharedVideoPage.update({
      where: { id },
      data: {
        status: 'REJECTED',
        moderatorId,
        moderatedAt: new Date(),
        rejectReason: dto.reason.trim(),
      },
    });
    return toView(updated);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async ownSession(
    userId: string,
    sessionId: string,
  ): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const owner = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!owner?.userId) {
      throw new ForbiddenException(
        'Публикация страницы требует владельца сессии — эта сессия анонимна',
      );
    }
    if (owner.userId !== userId) {
      throw new ForbiddenException('Эта сессия принадлежит другому аккаунту');
    }
    return session;
  }

  private async find(id: string): Promise<SharedVideoRow> {
    const row: SharedVideoRow | null =
      await this.prisma.sharedVideoPage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Shared video page ${id} not found`);
    return row;
  }
}
