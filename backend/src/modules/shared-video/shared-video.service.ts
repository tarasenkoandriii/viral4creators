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
import { activeProductImage } from '../../common/active-image';
import { Session } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { normalizeLocale } from '../../common/locale';
import { GreetingOccasion } from '../../common/types/greeting.types';
import {
  SharedVideoFeedItemView,
  SharedVideoFeedResult,
  SharedVideoListResult,
  SharedVideoPageView,
  SharedVideoPublicView,
  SharedVideoShowcaseResult,
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
  projectType: ProjectType | null;
  occasion: GreetingOccasion | null;
  showcasedAt: Date | null;
  productName: string | null;
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
  likeCount: number;
  shareCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'PUBLISHED',
  'REJECTED',
]);

/**
 * Фильтры витрины приходят строками из query — Prisma ждёт члены enum,
 * и именно на этом упала сборка: `string` туда не подходит.
 *
 * Обычные type guard'ы, без символов-сентинелов: сужение через
 * `raw is T` предсказуемо читается и компилятором, и человеком, а
 * «невалидное значение» выражается тем, что сузить не удалось.
 */
const PROJECT_TYPES = [
  'SINGLE',
  'LINE',
  'CLIENT_SITE',
  'GREETING_VIDEO',
] as const;

const OCCASIONS = [
  'BIRTHDAY',
  'WEDDING',
  'ANNIVERSARY',
  'NEW_YEAR',
  'GRADUATION',
  'CORPORATE',
  'OTHER',
] as const;

function isProjectType(raw: string): raw is (typeof PROJECT_TYPES)[number] {
  return (PROJECT_TYPES as readonly string[]).includes(raw);
}

function isOccasion(raw: string): raw is GreetingOccasion {
  return (OCCASIONS as readonly string[]).includes(raw);
}

/** Тип проекта в снимке — только то, что витрине нужно различать. */
type SnapshotProjectType = 'SINGLE' | 'LINE' | 'CLIENT_SITE' | 'GREETING_VIDEO';
type ProjectType = SnapshotProjectType;

export interface SharedVideoSnapshot {
  videoUrl: string;
  videoPathname: string;
  generatedVideoId: string;
  aspectRatio: string | null;
  title: string;
  projectType: ProjectType | null;
  occasion: GreetingOccasion | null;
  productName: string | null;
  productDescription: string | null;
  price: number | null;
  currency: string | null;
  category: string | null;
  productImageUrl: string | null;
  productImagePathname: string | null;
  locale: string;
}

/**
 * Pure: что копируется в снимок страницы. Exported for tests.
 *
 * Этап 1 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md,
 * находка 1.1. До этой правки функция начиналась с проверки
 * `if (!product?.productName) throw` — и поэтому НИ ОДНО поздравление
 * нельзя было опубликовать публичной страницей: у GREETING_VIDEO нет
 * `productInformation` по определению типа проекта. От этой страницы
 * зависят витрина лендинга (§5 ТЗ лендинга) и фичи №20/№21/№29
 * компаньон-ТЗ — то есть отказ здесь блокировал четыре фичи и весь
 * лендинг сразу.
 *
 * Разделение ветвей идёт по `greetingBriefSnapshot`, а не по какому-либо
 * полю «тип проекта» на сессии: такого поля у `Session` нет, а снимок
 * брифа есть ровно у поздравлений — тот же дискриминатор, которым уже
 * пользуется `PostProductionService.planWork()` (там — наличие
 * `productInformation`).
 *
 * Общая часть обеих ветвей — готовое видео: его отсутствие по-прежнему
 * 400, и это единственная причина отказа, оставшаяся для поздравления.
 */
export function snapshotFromSession(
  session: Session,
  dto: CreateSharedVideoRequestDto,
): SharedVideoSnapshot {
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

  const common = {
    // Тот же файл, что видит пользователь — не исходник Veo, если есть
    // постобработка (см. аналогичный комментарий в publication.service.ts).
    videoUrl: video.downloadUrl,
    videoPathname: video.postPathname ?? video.pathname,
    generatedVideoId: video.generatedVideoId,
    aspectRatio: video.renderedAspectRatio ?? video.aspectRatio ?? null,
    // Открытая страница — одна зафиксированная локаль (та, что была у
    // автора на момент публикации); переводов не запрашивалось (решение 5
    // плана этапа 60).
    locale: normalizeLocale(session.locale),
  };

  const greeting = session.greetingBriefSnapshot;
  if (greeting) {
    /**
     * Заголовок поздравления НЕ подставляется из имени получателя, даже
     * когда оно есть в брифе, и это не забывчивость.
     *
     * Имя получателя — персональные данные ТРЕТЬЕГО лица: человек,
     * которого поздравляют, страницу не публиковал, согласия не давал и
     * о витрине не знает. Автоматически вынести «С днём рождения,
     * Марина!» в публичный заголовок, в `og:title` и в выдачу Google
     * значило бы опубликовать его за него. Поэтому по умолчанию в
     * заголовок идёт только повод, а имя может появиться там лишь одним
     * путём — если автор САМ впишет его в `dto.title`.
     *
     * Та же логика, что уже требует §4.7 ТЗ лендинга от ответа в FAQ про
     * хранение данных получателя, просто применённая на шаг раньше — не
     * в тексте ответа, а в коде, который решает, что публиковать.
     */
    const fallback = greeting.customOccasionText?.trim() || greeting.occasion;
    const title = (dto.title ?? fallback).trim().slice(0, 100);
    if (!title) {
      throw new BadRequestException('title is required');
    }
    return {
      ...common,
      title,
      projectType: 'GREETING_VIDEO',
      occasion: greeting.occasion,
      // Товара у поздравления нет — все товарные поля пусты, и это
      // ровно то, ради чего `productName` стал nullable миграцией
      // 20261207090000.
      productName: null,
      productDescription: null,
      price: null,
      currency: null,
      category: null,
      productImageUrl: null,
      productImagePathname: null,
    };
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
    ...common,
    title,
    // NULL, а не 'SINGLE': сессия не знает, из проекта какого вида
    // (SINGLE или LINE) она вышла, а витрине это различие не нужно —
    // она отбирает по явному равенству 'GREETING_VIDEO'.
    projectType: null,
    occasion: null,
    productName: product.productName,
    productDescription: product.productDescription?.trim() || null,
    price: product.price ?? null,
    currency: product.currency ?? null,
    category: product.category?.trim() || null,
    productImageUrl: product.productImageUrl ?? null,
    productImagePathname: product.productImagePathname ?? null,
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
    projectType: row.projectType,
    occasion: row.occasion,
    featured: row.showcasedAt !== null,
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
    likeCount: row.likeCount,
    shareCount: row.shareCount,
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
    projectType: row.projectType,
    occasion: row.occasion,
    featured: row.showcasedAt !== null,
    productName: row.productName,
    productDescription: row.productDescription,
    price: row.price,
    currency: row.currency,
    category: row.category,
    productImageUrl: row.productImageUrl,
    locale: row.locale,
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    shareCount: row.shareCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Лента (этап 80) — `toPublicView` + флаг "уже лайкнул этот вошедший". */
export function toFeedItemView(
  row: SharedVideoRow,
  likedByViewer: boolean,
): SharedVideoFeedItemView {
  return { ...toPublicView(row), likedByViewer };
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
    // Этап 80, TODO §III.9: «право публикации — у платного и
    // незаблокированного подписчика» — тариф уже проверен строкой выше,
    // блокировка до этой правки не проверялась вовсе (см.
    // doc/SOCIAL-FEED-SPEC.md §1). Уже PUBLISHED-страницы блокировка не
    // трогает — только вход в новую заявку.
    await this.plans.assertUserNotBlocked(userId);
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
      // Копируем АКТИВНОЕ изображение товара: при применённом скетче на
      // публичную страницу уходит он, а не оригинал (§4 п.11 ТЗ скетча).
      const session = await this.sessions.getSession(row.sessionId);
      const active = activeProductImage(session?.productInformation);
      const from = active?.pathname ?? row.productImagePathname;
      const mime = active?.mimeType ?? 'image/jpeg';
      const photoPathname = `shared-videos/${row.id}/photo.${
        mime === 'image/png' ? 'png' : 'jpg'
      }`;
      const photoUrl = await this.blob.copyBlob(from, photoPathname, mime);
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

  // ── Лента (этап 80, TODO §III.9, doc/SOCIAL-FEED-SPEC.md §4) ────────────

  /**
   * GET /shared-video/feed — без гварда (лента читаема анонимно, как и
   * одиночная страница), но `viewerUserId` подставляется контроллером из
   * `req.telegramUserId`, если middleware его заполнила (см. doc §4) —
   * НЕ требуем identity для чтения, только используем её, если она уже
   * есть, чтобы посчитать `likedByViewer`.
   *
   * Курсор — id последней строки предыдущей порции; сортировка
   * `(createdAt desc, id desc)` даёт стабильный порядок, `cursor`/`skip:
   * 1` Prisma — стандартный приём курсорной пагинации по уникальному
   * полю поверх составной сортировки.
   */
  async listFeed(opts: {
    cursor?: string | null;
    pageSize: number;
    viewerUserId?: string | null;
  }): Promise<SharedVideoFeedResult> {
    const rows: SharedVideoRow[] = await this.prisma.sharedVideoPage.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.pageSize + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.pageSize;
    const page = hasMore ? rows.slice(0, opts.pageSize) : rows;

    let likedIds = new Set<string>();
    if (opts.viewerUserId && page.length > 0) {
      const likes: Array<{ sharedVideoPageId: string }> =
        await this.prisma.sharedVideoLike.findMany({
          where: {
            userId: opts.viewerUserId,
            sharedVideoPageId: { in: page.map((r) => r.id) },
          },
          select: { sharedVideoPageId: true },
        });
      likedIds = new Set(likes.map((l) => l.sharedVideoPageId));
    }

    return {
      items: page.map((row) => toFeedItemView(row, likedIds.has(row.id))),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  // ── Витрина (этап 1, docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md) ──

  /**
   * GET /shared-video/showcase — кураторская витрина для лендинга
   * (§5 docs-tz/TZ-Greeting-Video-Landing.md).
   *
   * Отдельный метод, а не параметры к `listFeed`, при том что запрос к
   * базе похож. Причина не в SQL, а в правиле отбора: лента показывает
   * ВСЁ опубликованное, витрина — только то, что оператор отметил
   * руками. Склеить их в одну функцию с флагом значило бы поставить
   * снятие кураторского фильтра на расстояние одного неверного
   * аргумента от чужого вызова; §5 ТЗ требует ровно обратного —
   * «не любой публично расшаренный ролик подряд», чтобы у человека,
   * опубликовавшего личное поздравление, оно не оказалось на витрине
   * без отдельного явного решения.
   *
   * `showcasedAt: { not: null }` и сортировка по нему же: оператор
   * управляет и составом, и порядком одним действием.
   */
  async listShowcase(opts: {
    projectType?: string | null;
    occasion?: string | null;
    cursor?: string | null;
    pageSize: number;
  }): Promise<SharedVideoShowcaseResult> {
    // Маршрут публичный, значения приходят из query-строки. Непустое, но
    // не принадлежащее enum значение — это НЕ «фильтра нет»: молча его
    // отбросить значило бы отдать наружу всю витрину целиком в ответ на
    // опечатку в параметре. Пустая выдача — правильная сторона ошибки.
    const rawType = opts.projectType?.trim() || undefined;
    const rawOccasion = opts.occasion?.trim() || undefined;
    const projectType =
      rawType && isProjectType(rawType) ? rawType : undefined;
    const occasion =
      rawOccasion && isOccasion(rawOccasion) ? rawOccasion : undefined;
    if ((rawType && !projectType) || (rawOccasion && !occasion)) {
      return { items: [], nextCursor: null };
    }
    const rows: SharedVideoRow[] = await this.prisma.sharedVideoPage.findMany({
      where: {
        status: 'PUBLISHED',
        showcasedAt: { not: null },
        ...(projectType ? { projectType } : {}),
        ...(occasion ? { occasion } : {}),
      },
      orderBy: [{ showcasedAt: 'desc' }, { id: 'desc' }],
      take: opts.pageSize + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.pageSize;
    const page = hasMore ? rows.slice(0, opts.pageSize) : rows;
    return {
      items: page.map(toPublicView),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * POST /admin/shared-videos/:id/showcase — оператор добавляет страницу
   * в витрину или снимает её оттуда (раздел 7 компаньон-ТЗ, «чек-бокс
   * показать в витрине»).
   *
   * Добавить можно только PUBLISHED-страницу: витрина — подмножество
   * опубликованного, и отметить черновик значило бы завести второй,
   * необязательный путь публикации в обход модерации. СНЯТЬ можно в
   * любом статусе — снятие всегда безопасно, и запрет на него означал
   * бы, что отклонённая страница не убирается с витрины.
   */
  async setShowcase(id: string, showcase: boolean): Promise<SharedVideoPageView> {
    const row: SharedVideoRow | null =
      await this.prisma.sharedVideoPage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Shared video page ${id} not found`);
    if (showcase && row.status !== 'PUBLISHED') {
      throw new ConflictException(
        'Only a published page can be added to the showcase',
      );
    }
    const updated = (await this.prisma.sharedVideoPage.update({
      where: { id },
      data: { showcasedAt: showcase ? new Date() : null },
    })) as SharedVideoRow;
    return toView(updated);
  }

  /**
   * POST /shared-video/:id/like — идемпотентно (TODO §III.9: «лайк
   * привязан к Telegram-пользователю, иначе накрутка ничего не стоит»,
   * doc/SOCIAL-FEED-SPEC.md §3.2/§4). Требует identity (гвард в
   * контроллере), НЕ проверяет тариф/блокировку — лайк не тратит внешние
   * API, ограничение «только платные» из TODO относится к публикации,
   * не к вовлечённости.
   */
  async like(
    userId: string,
    id: string,
  ): Promise<{ likeCount: number; likedByViewer: boolean }> {
    const row = await this.findPublished(id);
    try {
      // Без $transaction — тот же best-effort уровень строгости, что у
      // остальных счётчиков в этом файле (viewCount/firstGenerationCount):
      // редчайший сбой ВТОРОГО вызова (счётчик не бампнулся при уже
      // созданном лайке) не хуже уже существующей асимметрии в
      // markConverted/bumpViewCount, а не заводит новую категорию риска.
      await this.prisma.sharedVideoLike.create({
        data: { userId, sharedVideoPageId: id },
      });
    } catch (e) {
      // P2002 — уже лайкнул раньше (уникальный индекс §3.2): не ошибка,
      // повторный лайк — no-op, отдаём текущее состояние как есть.
      if (this.isUniqueViolation(e)) {
        return { likeCount: row.likeCount, likedByViewer: true };
      }
      throw e;
    }
    await this.prisma.sharedVideoPage.update({
      where: { id },
      data: { likeCount: { increment: 1 } },
    });
    return { likeCount: row.likeCount + 1, likedByViewer: true };
  }

  /** DELETE /shared-video/:id/like — снятие лайка, тоже идемпотентно. */
  async unlike(
    userId: string,
    id: string,
  ): Promise<{ likeCount: number; likedByViewer: boolean }> {
    const row = await this.findPublished(id);
    const deleted = await this.prisma.sharedVideoLike.deleteMany({
      where: { userId, sharedVideoPageId: id },
    });
    if (deleted.count === 0) {
      // Не был лайкнут — no-op, а не 404: клиент мог уже снять лайк в
      // другой вкладке, повторный DELETE не должен выглядеть ошибкой.
      return { likeCount: row.likeCount, likedByViewer: false };
    }
    await this.prisma.sharedVideoPage.update({
      where: { id },
      data: { likeCount: { decrement: 1 } },
    });
    return { likeCount: Math.max(row.likeCount - 1, 0), likedByViewer: false };
  }

  /**
   * POST /shared-video/:id/share — best-effort, тот же паттерн, что
   * `bumpViewCount`: и кнопка «Поделиться» в ленте, и та же кнопка в
   * `ShareVideoPanel` (владелец делится собственным роликом) бампают
   * один и тот же счётчик (doc/SOCIAL-FEED-SPEC.md §5). Не требует
   * identity и не проверяет статус жёстко — страница уже показана
   * клиенту, если он досюда дошёл.
   */
  async recordShare(id: string): Promise<void> {
    try {
      await this.prisma.sharedVideoPage.update({
        where: { id },
        data: { shareCount: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `shareCount bump failed for ${id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private async findPublished(id: string): Promise<SharedVideoRow> {
    const row = await this.find(id);
    if (row.status !== 'PUBLISHED') {
      throw new NotFoundException(`Shared video page ${id} not found`);
    }
    return row;
  }

  /** Prisma P2002 (unique constraint violation) — структурно, без импорта
   * `Prisma.PrismaClientKnownRequestError` (тот же приём избегания
   * прямого импорта из `@prisma/client`, что и структурный `SharedVideoRow`
   * выше — см. комментарий в project.service.ts). */
  private isUniqueViolation(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: unknown }).code === 'P2002'
    );
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
