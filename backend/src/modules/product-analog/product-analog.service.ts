/**
 * ProductAnalogService — the "photo → market analogs + category" flow.
 * doc/PRODUCT-PROJECT-SPEC.md §4 (Экраны 2–3), §6.1, §7.5; Stage 4.
 *
 * Two steps, mirroring the existing product-image flow (ProductService.
 * generateProductImageUploadUrl) so the photo never passes through the
 * backend body (Vercel's 4.5 MB Function limit — see that controller's
 * doc comment):
 *
 *   1. createPhotoUploadUrl  → presigned Vercel Blob PUT; the TMA uploads
 *      the photo straight to Blob.
 *   2. processPhoto          → the actual work, in this order:
 *        a. resolve the blob's public URL, download the bytes, SHA-256
 *           them → `photoHash`;
 *        b. CACHE (§7.5, decided): if the same user already has an item
 *           with this hash and saved analogs, copy them — no SerpApi
 *           call, no counter tick;
 *        c. otherwise check the daily cap (§7.5) → 429 if spent;
 *        d. SerpApi Google Lens (public URL) → analogs, ranked by
 *           SerpApi's position (§6.1); tick the counter only if SerpApi
 *           actually answered (billed);
 *        e. Gemini vision → free-text category (+ suggested title, only
 *           if the item has none yet) — spec §6.1/§9.4, SilverFinance
 *           recognize.ts pattern;
 *        f. persist photoUrl / photoHash / category / analogs (replacing
 *           any previous analogs of this item).
 *
 * Every external failure degrades, never blocks (spec §4 Экран 3, §7.4):
 * an empty analog list with a `reason` is a valid outcome — the user
 * types the price by hand on Экран 5. Only ownership/limit/validation
 * problems are HTTP errors.
 */

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { head } from '@vercel/blob';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { SerpApiLensService, LensMatch } from './serpapi-lens.service';
import { ProductRecognitionService } from './product-recognition.service';
import { AudienceProfile } from '../../common/types/audience.types';
import { SerpApiUsageService } from './serpapi-usage.service';
import { findCountry } from '../../common/data/countries';
import { ProductItemView } from '../../common/types/project.types';
import { toItemView } from '../project/project.service';
import { PhotoUploadUrlRequestDto } from './dto/photo-upload-url-request.dto';
import { ProcessPhotoRequestDto } from './dto/process-photo-request.dto';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { MAX_PHOTO_BYTES } from '../../common/photo-limits';

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

export interface PhotoUploadUrl {
  uploadUrl: string;
  /** Pass this back to processPhoto once the PUT has succeeded. */
  pathname: string;
}

export interface ProcessPhotoResult {
  item: ProductItemView;
  /** Where the analogs came from — the UI can show "из кеша" / etc. */
  analogsSource: 'serpapi' | 'cache' | 'none';
  /** Present when analogs are empty due to a problem (not "found nothing"). */
  analogsReason?: string;
  /** Present when category detection failed (soft — item saved anyway). */
  recognitionReason?: string;
}

/** Deterministic per-item Blob key; exported for tests. */
export function photoPathname(
  projectId: string,
  itemId: string,
  mimeType: string,
): string {
  const ext =
    mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
  return `projects/${projectId}/items/${itemId}/photo.${ext}`;
}

/** SHA-256 hex of the photo bytes — the §7.5 cache key. Exported for tests. */
export function hashPhoto(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** LensMatch → ProductAnalog row data. Exported for tests. */
export function analogRowsFromMatches(matches: LensMatch[]): Array<{
  title: string;
  sourceUrl: string;
  price: number | null;
  currency: string | null;
  thumbnailUrl: string | null;
  relevanceRank: number;
}> {
  return matches.map((m) => ({
    title: m.title,
    sourceUrl: m.url,
    price: m.priceNumber,
    currency: m.currency,
    thumbnailUrl: m.thumbnail ?? m.image,
    relevanceRank: m.position,
  }));
}

/** Shape of a cached analog row as selected below (structural, so it type-checks without the generated client). */
interface CachedAnalogRow {
  title: string;
  sourceUrl: string;
  price: unknown;
  currency: string | null;
  thumbnailUrl: string | null;
  relevanceRank: number;
}

interface CachedItem {
  id: string;
  category: string | null;
  analogs: CachedAnalogRow[];
}

interface OwnedItem {
  id: string;
  projectId: string;
  title: string | null;
  photoHash: string | null;
  project: { userId: string | null; countryCode: string };
}

@Injectable()
export class ProductAnalogService {
  private readonly logger = new Logger(ProductAnalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blobService: BlobService,
    private readonly lens: SerpApiLensService,
    private readonly recognition: ProductRecognitionService,
    private readonly usage: SerpApiUsageService,
    private readonly aiUsage: AiUsageService,
    private readonly plans: PlanService,
  ) {}

  async createPhotoUploadUrl(
    userId: string,
    projectId: string,
    itemId: string,
    dto: PhotoUploadUrlRequestDto,
  ): Promise<PhotoUploadUrl> {
    await this.findOwnedItem(userId, projectId, itemId);

    if (dto.fileSize > MAX_PHOTO_BYTES) {
      throw new BadRequestException(
        `Photo exceeds the 10MB limit (received ${dto.fileSize} bytes)`,
      );
    }
    if (!ALLOWED_MIME.includes(dto.mimeType)) {
      throw new BadRequestException(
        `Invalid image format. Allowed: ${ALLOWED_MIME.join(', ')}`,
      );
    }

    const pathname = photoPathname(projectId, itemId, dto.mimeType);
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_PHOTO_BYTES,
    );
    return { uploadUrl, pathname };
  }

  async processPhoto(
    userId: string,
    projectId: string,
    itemId: string,
    dto: ProcessPhotoRequestDto,
  ): Promise<ProcessPhotoResult> {
    // ТЗ §25.3: заблокированному платные вызовы запрещены.
    await this.plans.assertCanSpendUser(userId);

    const item = await this.findOwnedItem(userId, projectId, itemId);

    // The client tells us which pathname it PUT to; it must be this
    // item's own key — never let one item claim another's photo.
    const expectedPrefix = `projects/${projectId}/items/${itemId}/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `pathname must start with "${expectedPrefix}"`,
      );
    }

    // (a) public URL + bytes + hash. head() throws if nothing was PUT.
    let publicUrl: string;
    let bytes: Buffer;
    let mimeType: string;
    try {
      const meta = await head(dto.pathname);
      publicUrl = meta.url;
      mimeType = meta.contentType || 'image/jpeg';
      bytes = await this.blobService.downloadBuffer(dto.pathname);
    } catch (e) {
      throw new BadRequestException(
        `Photo not found in storage at "${dto.pathname}" — upload it first via the upload-url step (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const photoHash = hashPhoto(bytes);

    // (b) cache by hash — same user, any item, that already has analogs.
    const cached: CachedItem | null = await this.prisma.productItem.findFirst({
      where: {
        photoHash,
        project: { userId },
        analogs: { some: {} },
      },
      select: {
        id: true,
        category: true,
        analogs: {
          orderBy: { relevanceRank: 'asc' },
          select: {
            title: true,
            sourceUrl: true,
            price: true,
            currency: true,
            thumbnailUrl: true,
            relevanceRank: true,
          },
        },
      },
    });

    if (cached) {
      this.logger.log(
        `photoHash cache hit for item ${itemId} (from item ${cached.id}) — no SerpApi call`,
      );
      // Same item, same photo, already processed → nothing to change but
      // the URL/hash (idempotent re-entry to Экран 3).
      const analogRows =
        cached.id === itemId
          ? null
          : cached.analogs.map((a: CachedAnalogRow) => ({
              title: a.title,
              sourceUrl: a.sourceUrl,
              price: a.price,
              currency: a.currency,
              thumbnailUrl: a.thumbnailUrl,
              relevanceRank: a.relevanceRank,
            }));
      const saved = await this.persist(itemId, {
        photoUrl: publicUrl,
        photoHash,
        category: cached.category,
        analogs: analogRows,
      });
      return { item: saved, analogsSource: 'cache' };
    }

    // (c) daily cap — слот занимается ДО платного вызова (Б-1.9).
    //
    // Раньше здесь читался счётчик, а увеличивался он после ответа
    // SerpApi — между этими двумя шагами помещался второй запрос, и
    // двадцать фото, загруженных разом, давали двадцать оплаченных
    // поисков при остатке в один.
    if (!(await this.usage.reserve(userId))) {
      const status = await this.usage.status(userId);
      throw new HttpException(
        // Текст видит пользователь — по-русски, как весь интерфейс
        // (этап 48, В-5.2).
        `Дневной лимит поиска аналогов исчерпан (${status.used} из ${status.limit} за сегодня). Попробуйте завтра или введите цену вручную.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // (d) SerpApi Google Lens, localised to the project's market.
    const country = findCountry(item.project.countryCode);
    let lensResult: Awaited<ReturnType<typeof this.lens.visualMatches>>;
    try {
      lensResult = await this.lens.visualMatches(publicUrl, {
        countryCode: item.project.countryCode,
        language: country?.language,
      });
    } catch (error) {
      // Провайдер не ответил — слот возвращаем: пользователь не должен
      // платить квотой за чужую аварию.
      await this.usage.release(userId);
      throw error;
    }
    if (!lensResult.billed) {
      // Кеш провайдера или отказ конфигурации — счёта не было.
      await this.usage.release(userId);
    }
    if (lensResult.billed) {
      // ТЗ §26: суточная квота и учёт денег — разные вещи. Квота гасит
      // перерасход, журнал отвечает, во что этот пользователь обошёлся.
      await this.aiUsage.record({
        operation: 'analog-search',
        model: 'serpapi',
        userId,
      });
    }

    // (e) category (+ title suggestion) — soft.
    const recognition = await this.recognition.recognize(
      bytes,
      mimeType,
      { userId },
      dto.locale,
    );

    // (f) persist.
    const saved = await this.persist(itemId, {
      photoUrl: publicUrl,
      photoHash,
      category: recognition.category,
      audience: recognition.audience,
      titleIfEmpty: item.title ? null : recognition.title,
      analogs: analogRowsFromMatches(lensResult.matches),
    });

    const result: ProcessPhotoResult = {
      item: saved,
      analogsSource: lensResult.matches.length > 0 ? 'serpapi' : 'none',
    };
    if (lensResult.reason) result.analogsReason = lensResult.reason;
    if (recognition.reason) result.recognitionReason = recognition.reason;
    return result;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async findOwnedItem(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<OwnedItem> {
    const item: OwnedItem | null = await this.prisma.productItem.findFirst({
      where: { id: itemId, projectId, project: { userId } },
      select: {
        id: true,
        projectId: true,
        title: true,
        photoHash: true,
        project: { select: { userId: true, countryCode: true } },
      },
    });
    if (!item) {
      throw new NotFoundException(
        `Item ${itemId} not found in project ${projectId}`,
      );
    }
    return item;
  }

  /**
   * One transaction: update the item, replace its analogs (when a new
   * list is given), bump the parent project's updatedAt. `analogs: null`
   * means "leave the existing analogs alone" (same-item cache hit).
   */
  private async persist(
    itemId: string,
    data: {
      photoUrl: string;
      photoHash: string;
      category: string | null;
      audience?: AudienceProfile | null;
      titleIfEmpty?: string | null;
      analogs: Array<Record<string, unknown>> | null;
    },
  ): Promise<ProductItemView> {
    const itemData: Record<string, unknown> = {
      photoUrl: data.photoUrl,
      photoHash: data.photoHash,
    };
    // Only overwrite a category we actually got — a failed recognition
    // must not wipe a previously detected one.
    if (data.category) itemData.category = data.category;
    // Same for the audience (§18) — and never over the user's own edit:
    // a hand-written profile outranks a fresh guess from a new photo.
    if (data.audience) {
      const current = await this.prisma.productItem.findUnique({
        where: { id: itemId },
        select: { audience: true },
      });
      const existing = current?.audience as AudienceProfile | null | undefined;
      if (existing?.source !== 'user') itemData.audience = data.audience;
    }
    if (data.titleIfEmpty) itemData.title = data.titleIfEmpty;

    // Явная аннотация параметра `tx` здесь раньше была отдельным
    // структурным интерфейсом (`PersistTx`, методы с `args: unknown`) —
    // тот же корневой баг, что и 39-ошибочная волна на Vercel (см.
    // doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md, «Внеплановый фикс»):
    // явный тип параметра колбэка `$transaction` не резолвится с
    // реальным сгенерированным клиентом, только с локальным стабом.
    // Аннотация убрана — TypeScript выводит правильный тип `tx`
    // из контекста сам; `itemData`/`data.analogs`, оставшиеся нестрого
    // типизированными (см. их объявление выше), приводятся явным
    // касом к типам, которых Prisma ожидает на входе.
    const row = await this.prisma.$transaction(async (tx) => {
      if (data.analogs !== null) {
        await tx.productAnalog.deleteMany({ where: { productItemId: itemId } });
        if (data.analogs.length > 0) {
          await tx.productAnalog.createMany({
            data: data.analogs.map((a) => ({
              ...a,
              productItemId: itemId,
            })) as unknown as Prisma.ProductAnalogCreateManyInput[],
          });
        }
      }
      const updated = (await tx.productItem.update({
        where: { id: itemId },
        data: itemData as unknown as Prisma.ProductItemUpdateInput,
        include: { analogs: { orderBy: { relevanceRank: 'asc' } } },
      })) as Parameters<typeof toItemView>[0];
      await tx.project.update({
        where: { id: updated.projectId },
        data: { updatedAt: new Date() },
      });
      return updated;
    });
    return toItemView(row);
  }
}
