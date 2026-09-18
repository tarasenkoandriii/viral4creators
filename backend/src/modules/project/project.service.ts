/**
 * ProjectService — Project / ProductItem CRUD.
 * doc/PRODUCT-PROJECT-SPEC.md §2–§5, §7; Stage 3 of
 * doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md.
 *
 * Ownership model. Every read and write is scoped by `userId` in the
 * WHERE clause (`{ id, userId }`), never by id alone — a caller can only
 * ever see or touch their own projects. A miss is reported as 404, not
 * 403, so the API doesn't reveal whether somebody else's id exists.
 *
 * Why an identity is required here at all (spec §7.8 says Sessions may
 * stay anonymous): a Project is a PERSISTENT catalog the user comes back
 * to and lists — with no owner there is nothing to list it under, and
 * "anyone who guesses the id can read/edit it" is not acceptable for
 * saved product/price data. The anonymous flow is untouched: it keeps
 * running on Session alone, without a Project, exactly as today.
 *
 * Decisions from the spec enforced here:
 *  §7.1/§7.2  currency is derived from countryCode, never accepted from
 *             the client, one per project;
 *  §7.3       LINE projects hold at most `config.project.lineItemLimit`
 *             items (20 by default), SINGLE projects exactly one;
 *  §7.4       `isComplete` = has price AND description; nothing is
 *             required merely to save.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import { currencyForCountry } from '../../common/data/countries';
import {
  ItemDeletePreview,
  ProductAnalogView,
  ProductItemView,
  ProductPriceSource,
  ProjectDeletePreview,
  ProjectSummaryView,
  ProjectType,
  ProjectView,
} from '../../common/types/project.types';
import { CreateProjectRequestDto } from './dto/create-project-request.dto';
import { UpdateProjectRequestDto } from './dto/update-project-request.dto';
import { ProductItemRequestDto } from './dto/product-item-request.dto';
import { Prisma } from '@prisma/client';
import { BlobService } from '../storage/blob.service';
import { itemPhotoPathname } from '../../common/blob-paths';
import { AudienceProfile } from '../../common/types/audience.types';
import { audienceOf } from '../project-session/snapshot';
import {
  ProjectItemPurgeResult,
  SOFT_DELETE_GRACE_MS,
} from '../../common/soft-delete';
import { isRecordNotFoundError } from '../../common/prisma-errors';
import { activeRowPhotoUrl, SketchableRow } from '../../common/active-image';

/** Батч на один прогон крона — тот же порядок величины, что
 * `CLEANUP_BATCH` в `session.service.ts`. */
const PURGE_BATCH = 500;

/** Домашний рынок продукта — страна проекта «сайт заказчика», когда
 * подсказать её нечем (у пользователя ещё нет ни одного проекта). См.
 * `resolveCountryCode` ниже: у этого типа проекта страна ничего не
 * считает, и спрашивать её на входе дороже, чем угадать. */
const DEFAULT_COUNTRY_CODE = 'UA';

/**
 * Minimal structural types for what we read back from Prisma. Written
 * out by hand (instead of importing Prisma's generated types) so this
 * file — and its unit tests — type-check even where `prisma generate`
 * hasn't run; see doc/TELEGRAM-ADMIN.md §5. `price` is whatever Prisma
 * hands back for a Decimal column: an object with toString() — we only
 * ever convert it via Number().
 */
type DecimalLike = { toString(): string } | number | string;

interface AnalogRow {
  id: string;
  title: string;
  sourceUrl: string;
  price: DecimalLike | null;
  currency: string | null;
  thumbnailUrl: string | null;
  relevanceRank: number;
}

interface ItemRow {
  id: string;
  projectId: string;
  title: string | null;
  photoUrl: string | null;
  description: string | null;
  category: string | null;
  audience?: unknown;
  price: DecimalLike | null;
  priceSource: ProductPriceSource;
  createdAt: Date;
  updatedAt: Date;
  analogs?: AnalogRow[];
}

interface ProjectRow {
  id: string;
  type: ProjectType;
  title: string;
  countryCode: string;
  currency: string;
  brandManifestId: string | null;
  createdAt: Date;
  updatedAt: Date;
  items?: ItemRow[];
}

/**
 * Ordering of nested items/analogs used by every read that includes
 * them. `where: { deletedAt: null }` (этап 89) — мягко удалённый товар
 * не должен всплывать в списке живого проекта просто потому, что
 * физическая уборка ещё не наступила.
 */
const ITEMS_INCLUDE = {
  items: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' as const },
    include: {
      analogs: { orderBy: { relevanceRank: 'asc' as const } },
      // Применённый ИИ-скетч: экран товара показывает АКТИВНОЕ
      // изображение, иначе после перезагрузки он снова покажет
      // оригинал, который пользователь уже подменил (ТЗ скетча §6.3).
      activeSketch: true,
    },
  },
};

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  private readonly lineItemLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {
    this.lineItemLimit = loadConfiguration().project.lineItemLimit;
  }

  // ── Projects ──────────────────────────────────────────────────────────

  async createProject(
    userId: string,
    dto: CreateProjectRequestDto,
  ): Promise<ProjectView> {
    const countryCode = await this.resolveCountryCode(userId, dto);
    const currency = this.resolveCurrency(countryCode);

    if (dto.brandManifestId !== undefined) {
      await this.assertOwnBrandManifest(userId, dto.brandManifestId);
    }

    const row: ProjectRow = await this.prisma.project.create({
      data: {
        userId,
        type: dto.type,
        title: dto.title.trim(),
        countryCode,
        currency,
        brandManifestId: dto.brandManifestId ?? null,
      },
      include: ITEMS_INCLUDE,
    });
    return toProjectView(row);
  }

  async listProjects(userId: string): Promise<ProjectSummaryView[]> {
    // Только то, что реально читает toProjectSummaryView (счётчик товаров
    // и «заполнен ли товар») — не полный ItemRow, той же логике, что
    // library.service.ts's candidates() экономит колонку `analysis`.
    const rows: Array<
      Omit<ProjectRow, 'items'> & {
        items: Pick<ItemRow, 'id' | 'price' | 'description'>[];
      }
    > = await this.prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: {
        items: {
          where: { deletedAt: null },
          select: { id: true, price: true, description: true },
        },
      },
    });
    return rows.map(toProjectSummaryView);
  }

  async getProject(userId: string, projectId: string): Promise<ProjectView> {
    const row = await this.findOwnProject(userId, projectId, ITEMS_INCLUDE);
    return toProjectView(row);
  }

  async updateProject(
    userId: string,
    projectId: string,
    dto: UpdateProjectRequestDto,
  ): Promise<ProjectView> {
    const current = await this.findOwnProject(userId, projectId, ITEMS_INCLUDE);
    const items = current.items ?? [];
    const data: Record<string, unknown> = {};

    if (dto.title !== undefined) {
      data.title = dto.title.trim();
    }

    if (dto.type !== undefined && dto.type !== current.type) {
      // LINE → SINGLE only if it can actually hold what's already there.
      if (dto.type === 'SINGLE' && items.length > 1) {
        throw new BadRequestException(
          `Cannot change to SINGLE: project has ${items.length} items, a SINGLE project holds exactly one. Remove the extra items first.`,
        );
      }
      data.type = dto.type;
    }

    if (
      dto.countryCode !== undefined &&
      dto.countryCode.toUpperCase() !== current.countryCode
    ) {
      // Prices are stored as bare numbers in project.currency — changing
      // the country would silently re-denominate every one of them.
      if (items.some((item) => item.price !== null)) {
        throw new BadRequestException(
          'Cannot change country: some items already have a price in the current currency. Clear the prices first, or create a separate project for the other country (spec §7.1).',
        );
      }
      const countryCode = dto.countryCode.toUpperCase();
      data.countryCode = countryCode;
      data.currency = this.resolveCurrency(countryCode);
    }

    if (dto.brandManifestId !== undefined) {
      if (dto.brandManifestId !== null) {
        await this.assertOwnBrandManifest(userId, dto.brandManifestId);
      }
      data.brandManifestId = dto.brandManifestId;
    }

    if (Object.keys(data).length === 0) {
      return toProjectView(current);
    }

    const row: ProjectRow = await this.prisma.project.update({
      where: { id: projectId },
      data,
      include: ITEMS_INCLUDE,
    });
    return toProjectView(row);
  }

  /**
   * Софт-delete (этап 89) — раньше это был немедленный `prisma.project.
   * delete()`, каскадом уносивший товары/аналоги и прогоны пакетной
   * генерации/A-B-теста/импорта фида (см. `onDelete: Cascade` в schema.
   * prisma) прямо в этом запросе. Теперь запрос только ставит метку;
   * физическое удаление (тот же каскад БД плюс файлы товаров в Blob) —
   * за `purgeSoftDeletedProjects()` из крона, спустя `SOFT_DELETE_GRACE_MS`.
   * Sessions, созданные из проекта, по-прежнему переживают удаление в
   * любом случае — `projectId` → NULL (spec §7.8, `SetNull`, не Cascade).
   */
  async deleteProject(userId: string, projectId: string): Promise<void> {
    await this.findOwnProject(userId, projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * «Умный» алерт (этап 89, прямой запрос владельца продукта) — перед
   * удалением проекта пользователь должен видеть не «удалить проект?», а
   * сколько всего реально уйдёт вместе с ним. Считает прямых потомков,
   * которых унесёт DB-каскад (см. `deleteProject`) — не их собственных
   * детей (CatalogBatchItem/AbTestVariant/ProductFeedImportItem тоже
   * каскадятся, но отдельно не считаются, см. доккомментарий
   * `ProjectDeletePreview`, найдено доп. аудитом): sessions в этот
   * список НЕ входят — они переживают удаление (SetNull).
   */
  async getProjectDeletePreview(
    userId: string,
    projectId: string,
  ): Promise<ProjectDeletePreview> {
    await this.findOwnProject(userId, projectId);
    const [items, catalogBatchRuns, abTestRuns, feedImportRuns] =
      await Promise.all([
        this.prisma.productItem.count({
          where: { projectId, deletedAt: null },
        }),
        this.prisma.catalogBatchRun.count({ where: { projectId } }),
        this.prisma.abTestRun.count({ where: { projectId } }),
        this.prisma.productFeedImportRun.count({ where: { projectId } }),
      ]);
    return { items, catalogBatchRuns, abTestRuns, feedImportRuns };
  }

  /**
   * Крон-проход (этап 89): проекты, мягко удалённые больше
   * `SOFT_DELETE_GRACE_MS` назад — физически. Тот же порядок, что был в
   * старом синхронном `deleteProject`: собрать пути файлов товаров ДО
   * удаления строки (каскад БД снесёт сами товары вместе с проектом за
   * один `delete`, но файлы в Blob каскадом не уносятся — doc/
   * STORAGE-AUDIT.md, этап 26), затем удалить строку, затем — файлы.
   */
  async purgeSoftDeletedProjects(
    maxRows = PURGE_BATCH,
  ): Promise<ProjectItemPurgeResult> {
    const cutoff = new Date(Date.now() - SOFT_DELETE_GRACE_MS);
    const rows: Array<{ id: string }> = await this.prisma.project.findMany({
      where: { deletedAt: { lt: cutoff } },
      orderBy: { deletedAt: 'asc' },
      take: maxRows,
      select: { id: true },
    });
    if (rows.length === 0) return { count: 0, hasMore: false };

    let count = 0;
    for (const { id: projectId } of rows) {
      // Свой try/catch на проект: сбой одного не должен ронять партию.
      try {
        const items: Array<{ id: string; photoUrl: string | null }> =
          await this.prisma.productItem.findMany({
            where: { projectId },
            select: { id: true, photoUrl: true },
          });
        // Черновик обучалки по сайту заказчика уходит каскадом FK, а его
        // кадры предпросмотра в Blob — нет: после удаления строки
        // `draftId` взять больше неоткуда, и префикс осиротел бы
        // навсегда (найдено аудитом этапа 116 — тот же класс, что уже
        // решён для файлов товара парой строк ниже). Идентификатор
        // читаем ДО удаления по той же причине.
        const draft: { id: string } | null =
          await this.prisma.clientSiteTutorialDraft.findUnique({
            where: { projectId },
            select: { id: true },
          });
        await this.prisma.project.delete({ where: { id: projectId } });
        count += 1;
        for (const item of items) {
          await this.deleteItemFiles(projectId, item.id, item.photoUrl ?? null);
        }
        if (draft) await this.deleteClientSiteFrames(draft.id);
      } catch (e) {
        // isRecordNotFoundError (P2025) — та же ситуация, что и в
        // purgeSoftDeletedItems: строка уже пропала (два параллельных
        // прогона крона, или проект уже физически убран другим путём).
        // «Уже нечего удалять» — не сбой, не логируем как warn.
        const alreadyGone = isRecordNotFoundError(e);
        if (!alreadyGone) {
          this.logger.warn(
            `не удалось физически удалить мягко удалённый проект ${projectId}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
    }
    return { count, hasMore: rows.length === maxRows };
  }

  // ── Items ─────────────────────────────────────────────────────────────

  async addItem(
    userId: string,
    projectId: string,
    dto: ProductItemRequestDto,
  ): Promise<ProductItemView> {
    const project = await this.findOwnProject(userId, projectId, {
      items: { where: { deletedAt: null }, select: { id: true } },
    });
    const count = project.items?.length ?? 0;

    if (project.type === 'SINGLE' && count >= 1) {
      throw new BadRequestException(
        'A SINGLE project holds exactly one item. Switch the project to LINE to add more.',
      );
    }
    if (project.type === 'LINE' && count >= this.lineItemLimit) {
      throw new BadRequestException(
        `Line limit reached: at most ${this.lineItemLimit} items per project (PROJECT_LINE_ITEM_LIMIT).`,
      );
    }

    const row: ItemRow = await this.prisma.productItem.create({
      data: { projectId, ...itemDataFromDto(dto) },
      include: { analogs: { orderBy: { relevanceRank: 'asc' } } },
    });
    await this.touchProject(projectId);
    return toItemView(row);
  }

  async updateItem(
    userId: string,
    projectId: string,
    itemId: string,
    dto: ProductItemRequestDto,
  ): Promise<ProductItemView> {
    await this.findOwnItem(userId, projectId, itemId);
    if (dto.priceSource === 'ANALOG' && dto.price != null) {
      await this.assertAnalogPriceInProjectCurrency(
        projectId,
        itemId,
        Number(dto.price),
      );
    }
    const row: ItemRow = await this.prisma.productItem.update({
      where: { id: itemId },
      data: itemDataFromDto(dto),
      include: {
        analogs: { orderBy: { relevanceRank: 'asc' } },
        // Без этого правка названия или цены возвращала бы товар «без
        // скетча» (`activeSketch` просто не прочитан), и карточка на
        // экране откатывалась бы к оригиналу — хотя в базе скетч на
        // месте и именно он уйдёт в ролик.
        activeSketch: true,
      },
    });
    await this.touchProject(projectId);
    return toItemView(row);
  }

  /**
   * Цена «из аналога» обязана быть ценой аналога В ВАЛЮТЕ ПРОЕКТА (этап 54,
   * В-4.7). У `product_analogs` валюта своя — источник мог быть
   * иностранным, — а у `product_items.price` валюта одна на проект.
   * Раньше число переносилось как есть: «$19» становилось «19 UAH».
   * Клиент теперь не даёт нажать на чужую валюту; сервер проверяет то же,
   * потому что клиентов больше одного, а колонка с деньгами — одна.
   * Курс не применяется: его у сервиса нет, а выдумывать нельзя.
   */
  private async assertAnalogPriceInProjectCurrency(
    projectId: string,
    itemId: string,
    price: number,
  ): Promise<void> {
    const [project, analogs]: [
      { currency: string } | null,
      Array<{ price: DecimalLike | null; currency: string | null }>,
    ] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { currency: true },
      }),
      this.prisma.productAnalog.findMany({
        where: { productItemId: itemId },
        select: { price: true, currency: true },
      }),
    ]);
    const currency = project?.currency.toUpperCase();
    const match = analogs.some(
      (a) =>
        a.price !== null &&
        Number(a.price) === price &&
        (!a.currency || a.currency.toUpperCase() === currency),
    );
    if (!match) {
      throw new BadRequestException(
        `Цена «из аналога» должна совпадать с ценой одного из аналогов в валюте проекта (${project?.currency ?? '—'}). Для цены в другой валюте введите её вручную.`,
      );
    }
  }

  /**
   * Софт-delete (этап 89) — тот же приём, что у `deleteProject`: строка
   * (и файлы в Blob) физически исчезает не здесь, а из
   * `purgeSoftDeletedItems()` спустя `SOFT_DELETE_GRACE_MS`.
   */
  async deleteItem(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<void> {
    await this.findOwnItem(userId, projectId, itemId);
    await this.prisma.productItem.update({
      where: { id: itemId },
      data: { deletedAt: new Date() },
    });
    await this.touchProject(projectId);
  }

  /** «Умный» алерт (этап 89) для удаления одного товара. */
  async getItemDeletePreview(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<ItemDeletePreview> {
    await this.findOwnItem(userId, projectId, itemId);
    const [analogs, catalogBatchItems] = await Promise.all([
      this.prisma.productAnalog.count({ where: { productItemId: itemId } }),
      this.prisma.catalogBatchItem.count({
        where: { productItemId: itemId },
      }),
    ]);
    return { analogs, catalogBatchItems };
  }

  /**
   * Крон-проход (этап 89): товары, мягко удалённые ПООТДЕЛЬНОСТИ (не
   * вместе с целым проектом — тот случай уносит `purgeSoftDeletedProjects`
   * за один каскадный `delete`) больше `SOFT_DELETE_GRACE_MS` назад.
   */
  async purgeSoftDeletedItems(
    maxRows = PURGE_BATCH,
  ): Promise<ProjectItemPurgeResult> {
    const cutoff = new Date(Date.now() - SOFT_DELETE_GRACE_MS);
    const rows: Array<{
      id: string;
      projectId: string;
      photoUrl: string | null;
    }> = await this.prisma.productItem.findMany({
      where: { deletedAt: { lt: cutoff } },
      orderBy: { deletedAt: 'asc' },
      take: maxRows,
      select: { id: true, projectId: true, photoUrl: true },
    });
    if (rows.length === 0) return { count: 0, hasMore: false };

    let count = 0;
    for (const item of rows) {
      try {
        // Родительский проект мог быть удалён физически этим же прогоном
        // (`purgeSoftDeletedProjects`) — тогда строки товара уже нет,
        // Prisma бросит P2025, ловим и просто пропускаем как «уже нечего
        // удалять», не как сбой.
        await this.prisma.productItem.delete({ where: { id: item.id } });
        count += 1;
        await this.deleteItemFiles(
          item.projectId,
          item.id,
          item.photoUrl ?? null,
        );
      } catch (e) {
        const alreadyGone = isRecordNotFoundError(e);
        if (!alreadyGone) {
          this.logger.warn(
            `не удалось физически удалить мягко удалённый товар ${item.id}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
    }
    return { count, hasMore: rows.length === maxRows };
  }

  /**
   * Все файлы товара, а не только фото (этап 39, А-2.14).
   *
   * Голосовые записи описания (§6.2) лежат под тем же префиксом, но с
   * именем из отметки времени — перечислить их по базе нельзя, они там
   * не хранятся. Поэтому уборка идёт по префиксу: она заодно уносит и
   * фото, и всё, что появится под этим префиксом потом.
   *
   * Best-effort: сбой хранилища не должен ронять удаление товара —
   * пользователь просил удалить товар, а не подождать хранилище.
   */
  private async deleteItemFiles(
    projectId: string,
    itemId: string,
    photoUrl: string | null,
  ): Promise<void> {
    const prefix = `projects/${projectId}/items/${itemId}/`;
    try {
      const paths = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: {
          blobs: Array<{ pathname: string }>;
          cursor: string | null;
        } = await this.blob.listByPrefix(prefix, {
          cursor: cursor ?? undefined,
        });
        for (const b of page.blobs) paths.add(b.pathname);
        cursor = page.cursor;
      } while (cursor);

      // Фото добавляем и из базы: если листинг не отдал его (задержка
      // согласованности хранилища), удалить его всё равно надо.
      const fromDb = itemPhotoPathname(photoUrl);
      if (fromDb) paths.add(fromDb);

      if (paths.size > 0) await this.blob.deleteMany([...paths]);
    } catch (e) {
      this.logger.warn(
        `не удалось убрать файлы товара ${itemId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // `deletePhotos` (уборка по списку `photoUrl`) убрана вместе с Б-2.8:
  // единственный её вызов — удаление проекта — перешёл на уборку по
  // префиксу, а два способа делать одно и то же по-разному и есть та
  // трещина, в которую утекли голосовые записи.

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Страна проекта: для `SINGLE`/`LINE` — как и раньше, обязательное
   * поле запроса; для `CLIENT_SITE` — необязательное (§4.1
   * doc/CLIENT-SITE-TUTORIAL-SPEC.md).
   *
   * Почему у «сайта заказчика» её можно не спрашивать: у такого проекта
   * нет ни товара, ни цены — страна и валюта там ничего не считают.
   * Колонка при этом остаётся `NOT NULL`, и это осознанно: делать её
   * nullable значит добавить null-проверки во все места, которые уже
   * читают `Project.countryCode`, ради поля, которое для одного типа
   * проекта просто не используется. Поэтому страна не убирается, а
   * УГАДЫВАЕТСЯ — по последнему проекту пользователя, а для самого
   * первого берётся домашний рынок продукта. Цена ошибки нулевая,
   * выигрыш — на один обязательный шаг меньше на входе в фичу.
   */
  private async resolveCountryCode(
    userId: string,
    dto: CreateProjectRequestDto,
  ): Promise<string> {
    if (dto.countryCode) return dto.countryCode.toUpperCase();
    if (dto.type !== 'CLIENT_SITE') {
      throw new BadRequestException(
        'countryCode is required for SINGLE and LINE projects',
      );
    }
    const previous = await this.prisma.project.findFirst({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { countryCode: true },
    });
    return previous?.countryCode ?? DEFAULT_COUNTRY_CODE;
  }

  /**
   * Кадры предпросмотра обучалки по сайту заказчика
   * (`tutorial-video-frames/{draftId}/*`). Best-effort, как и уборка
   * файлов товара: строка проекта уже удалена, и сбой хранилища не
   * должен ронять партию крона.
   */
  private async deleteClientSiteFrames(draftId: string): Promise<void> {
    const prefix = `tutorial-video-frames/${draftId}/`;
    try {
      let cursor: string | undefined;
      do {
        const page = await this.blob.listByPrefix(prefix, { cursor });
        if (page.blobs.length > 0) {
          await this.blob.deleteMany(page.blobs.map((b) => b.pathname));
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
    } catch (e) {
      this.logger.warn(
        `не удалось убрать кадры обучалки ${draftId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private resolveCurrency(countryCode: string): string {
    const currency = currencyForCountry(countryCode);
    if (!currency) {
      throw new BadRequestException(
        `Unknown countryCode "${countryCode}" — expected an ISO 3166-1 alpha-2 code from GET /reference/countries.`,
      );
    }
    return currency;
  }

  private async findOwnProject(
    userId: string,
    projectId: string,
    include?: Record<string, unknown>,
  ): Promise<ProjectRow> {
    // `deletedAt: null` (этап 89) — мягко удалённый проект читается как
    // «не найдено», тем же 404, что и чужой/несуществующий: грейс-период
    // до физической уборки не должен давать доступ, которого больше нет.
    const row: ProjectRow | null = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      ...(include ? { include } : {}),
    });
    if (!row) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return row;
  }

  private async findOwnItem(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<ItemRow> {
    // Ownership is checked through the parent: the item must belong to a
    // project that belongs to the caller. `deletedAt: null` on both —
    // мягко удалённый товар или его мягко удалённый проект читаются как
    // «не найдено» (этап 89).
    const row: ItemRow | null = await this.prisma.productItem.findFirst({
      where: {
        id: itemId,
        projectId,
        deletedAt: null,
        project: { userId, deletedAt: null },
      },
    });
    if (!row) {
      throw new NotFoundException(
        `Item ${itemId} not found in project ${projectId}`,
      );
    }
    return row;
  }

  private async assertOwnBrandManifest(
    userId: string,
    brandManifestId: string,
  ): Promise<void> {
    const manifest = await this.prisma.brandManifest.findFirst({
      where: { id: brandManifestId, userId },
      select: { id: true },
    });
    if (!manifest) {
      throw new BadRequestException(
        `Brand manifest ${brandManifestId} not found`,
      );
    }
  }

  /**
   * Item edits should surface the project at the top of "recently
   * worked on" (GET /projects orders by updatedAt) — Prisma's @updatedAt
   * only fires on the row that was written, so bump the parent by hand.
   */
  private async touchProject(projectId: string): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { updatedAt: new Date() },
    });
  }
}

// ── Pure mapping helpers (exported for unit tests) ──────────────────────

/**
 * Translate the request body into a Prisma `data` object. Only keys that
 * were actually sent are included, so a PATCH with `{ price: 25 }` leaves
 * title/description alone, while an explicit `null` clears a field.
 * Clearing the price also resets priceSource to MANUAL — an "ANALOG"
 * source with no price is meaningless.
 */
export function itemDataFromDto(
  dto: ProductItemRequestDto,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (dto.title !== undefined) data.title = dto.title?.trim() ?? null;
  if (dto.description !== undefined) {
    data.description = dto.description?.trim() ?? null;
  }
  if (dto.price !== undefined) {
    data.price = dto.price;
    if (dto.price === null) data.priceSource = 'MANUAL';
  }
  if (dto.audience !== undefined) {
    data.audience =
      dto.audience === null
        ? Prisma.DbNull
        : ({
            ageRange: dto.audience.ageRange?.trim() || null,
            gender: dto.audience.gender ?? null,
            interests: (dto.audience.interests ?? [])
              .map((t) => t.trim())
              .filter(Boolean),
            summary: dto.audience.summary?.trim() || null,
            source: 'user',
          } satisfies AudienceProfile);
  }
  if (dto.priceSource !== undefined && dto.price !== null) {
    data.priceSource = dto.priceSource;
  }
  return data;
}

/** Spec §7.4 (decided): price AND non-empty description; nothing else. */
export function isItemComplete(item: {
  price: DecimalLike | null;
  description: string | null;
}): boolean {
  return item.price !== null && (item.description?.trim().length ?? 0) > 0;
}

function decimalToNumber(value: DecimalLike | null): number | null {
  return value === null ? null : Number(value.toString());
}

function toAnalogView(row: AnalogRow): ProductAnalogView {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.sourceUrl,
    price: decimalToNumber(row.price),
    currency: row.currency,
    thumbnailUrl: row.thumbnailUrl,
    relevanceRank: row.relevanceRank,
  };
}

export function toItemView(row: ItemRow & SketchableRow): ProductItemView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    // Активное изображение: скетч, если он применён (ТЗ скетча §6.3).
    photoUrl: activeRowPhotoUrl(row) ?? row.photoUrl,
    photoVariant: row.activeSketch ? 'sketch' : 'original',
    originalPhotoUrl: row.photoUrl,
    originalDeleted: !!row.originalDeletedAt,
    activeSketchId: row.activeSketch?.id ?? null,
    description: row.description,
    category: row.category,
    audience: audienceOf(row.audience),
    price: decimalToNumber(row.price),
    priceSource: row.priceSource,
    isComplete: isItemComplete(row),
    analogs: (row.analogs ?? []).map(toAnalogView),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProjectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    countryCode: row.countryCode,
    currency: row.currency,
    brandManifestId: row.brandManifestId,
    items: (row.items ?? []).map(toItemView),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProjectSummaryView(
  row: Omit<ProjectRow, 'items'> & {
    items?: Pick<ItemRow, 'price' | 'description'>[];
  },
): ProjectSummaryView {
  const items = row.items ?? [];
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    countryCode: row.countryCode,
    currency: row.currency,
    brandManifestId: row.brandManifestId,
    itemCount: items.length,
    completeItemCount: items.filter(isItemComplete).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
