import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { BlobService } from '../storage/blob.service';
import { SubmitProductInfoRequestDto } from './dto/submit-product-info-request.dto';
import { SubmitProductInfoResponseDto } from './dto/submit-product-info-response.dto';
import { UploadProductImageRequestDto } from './dto/upload-product-image-request.dto';
import { UploadProductImageResponseDto } from './dto/upload-product-image-response.dto';
import { ConfirmProductImageRequestDto } from './dto/confirm-product-image.dto';
import { SessionStatus } from '../../common/types/session.types';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';

/**
 * Размер для текста «фото больше 10 МБ»: вверх до десятой и с запятой.
 * Обычное округление превращало 10 МБ + 1 байт в «(10.0 МБ)» — отказ,
 * который противоречит сам себе.
 */
function photoSizeMb(bytes: number): string {
  return String(Math.ceil((bytes / 1024 / 1024) * 10) / 10).replace('.', ',');
}

/** Фото товара грузится после названия и описания — шаг «Товар» не пройден. */
export const PRODUCT_INFO_FIRST =
  'Сначала заполните название и описание товара, потом загружайте фото';

/** Загруженное фото не нашлось или пришло не по своему пути. */
const PRODUCT_PHOTO_UPLOAD_FAILED =
  'Фото товара не загрузилось — попробуйте загрузить его ещё раз';

/**
 * ProductService handles product information submission and image uploads
 */
@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly sessionService: SessionService,
    private readonly blobService: BlobService,
  ) {}

  /**
   * Submit product information and store in session
   * @param sessionId - Session UUID
   * @param dto - Product information (name and description)
   * @returns Confirmation with updated session status
   */
  async submitProductInfo(
    sessionId: string,
    dto: SubmitProductInfoRequestDto,
  ): Promise<SubmitProductInfoResponseDto> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    // MERGE into the existing product info, never replace it: a session
    // started from a project item (Stage 10) already carries the photo
    // pathname, category, currency, market language… — the form on this
    // step only edits name/description (+ voice-over language, spec §13).
    const updatedSession = await this.sessionService.updateSession(sessionId, {
      productInformation: {
        ...(session.productInformation ?? {}),
        productName: dto.productName,
        productDescription: dto.productDescription,
        ...(dto.dialogueLanguage !== undefined
          ? { dialogueLanguage: dto.dialogueLanguage.toLowerCase() }
          : {}),
        addedAt: new Date(),
      },
      status: SessionStatus.PRODUCT_INFO_ADDED,
    });

    if (!updatedSession) {
      this.logger.warn(`сессия ${sessionId} исчезла между чтением и записью`);
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    return {
      sessionId,
      productName: dto.productName,
      productDescription: dto.productDescription,
      status: updatedSession.status,
    };
  }

  /**
   * Generate a presigned Vercel Blob upload URL for the product image.
   * Same direct-to-storage pattern as the reference video (VideoService) —
   * the image bytes never pass through this Function's body.
   * @param sessionId - Session UUID
   * @param dto - Image upload request details
   * @returns Presigned PUT URL and the Blob pathname it targets
   */
  async generateProductImageUploadUrl(
    sessionId: string,
    dto: UploadProductImageRequestDto,
  ): Promise<UploadProductImageResponseDto> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    // Validate product info has been added
    if (!session.productInformation) {
      throw new BadRequestException(PRODUCT_INFO_FIRST);
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (dto.fileSize > maxSize) {
      throw new BadRequestException(
        `Фото больше 10 МБ (${photoSizeMb(dto.fileSize)} МБ) — выберите файл поменьше`,
      );
    }

    // Validate MIME type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(dto.mimeType)) {
      throw new BadRequestException(
        'Такой формат фото не подходит — нужен PNG, JPEG или WebP',
      );
    }

    // Blob pathname for product image
    const fileExtension = dto.mimeType.split('/')[1];
    const pathname = `sessions/${sessionId}/product-image.${fileExtension}`;

    // Generate presigned PUT URL
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      maxSize,
    );

    // Путь в сессию здесь НЕ пишется (В-1.8, этап 123): ссылка выдана —
    // ещё не значит, что файл загружен. Раньше запись стояла именно
    // тут, и сорвавшийся PUT оставлял сессию с путём, по которому
    // ничего нет: мастер показывал фото загруженным, а генерация
    // упиралась в техническую ошибку скачивания. Записывает
    // `confirmProductImage()` — после того, как файл реально нашёлся.

    return {
      success: true,
      data: {
        uploadUrl,
        pathname,
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: `req_${Date.now()}`,
      },
    };
  }

  /**
   * Подтвердить, что фото товара действительно загружено (В-1.8, этап
   * 123).
   *
   * Проверка — обращение к хранилищу за этим путём: если файла нет,
   * отказ приходит СЕЙЧАС, человеку, который только что жал «загрузить»,
   * а не потом, платной генерации, в виде технической ошибки скачивания.
   *
   * Путь сверяется с префиксом сессии: он приходит от клиента, и без
   * этой проверки подтверждением чужого пути можно было бы подставить в
   * свою сессию чужой файл.
   */
  async confirmProductImage(
    sessionId: string,
    dto: ConfirmProductImageRequestDto,
  ): Promise<{ success: true; pathname: string }> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }
    if (!session.productInformation) {
      throw new BadRequestException(PRODUCT_INFO_FIRST);
    }

    // Путь приходит от клиента, поэтому проверяется не «начинается с», а
    // ЦЕЛИКОМ: `startsWith` пропускает
    // `sessions/<моя>/product-image.png/../../<чужая>/product-image.png`
    // — хранилище такой путь нормализует, а мы записали бы его в свою
    // сессию. Дальше он попал бы и в список файлов сессии (`blob-paths`),
    // то есть уборка удалила бы чужое фото, а генерация подставила бы
    // его первым кадром.
    const prefix = `sessions/${sessionId}/product-image.`;
    const extension = dto.pathname.startsWith(prefix)
      ? dto.pathname.slice(prefix.length)
      : '';
    const MIME_BY_EXTENSION: Record<string, string> = {
      png: 'image/png',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    };
    const mimeType = MIME_BY_EXTENSION[extension.toLowerCase()];
    if (!mimeType) {
      this.logger.warn(
        `сессия ${sessionId}: фото товара пришло с чужим путём ${dto.pathname}`,
      );
      throw new BadRequestException(PRODUCT_PHOTO_UPLOAD_FAILED);
    }

    try {
      await this.blobService.getPublicUrl(dto.pathname);
    } catch (e) {
      this.logger.warn(
        `сессия ${sessionId}: фото товара ${dto.pathname} не нашлось в хранилище (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
      throw new BadRequestException(PRODUCT_PHOTO_UPLOAD_FAILED);
    }

    const updated = await this.sessionService.updateSession(sessionId, {
      productInformation: {
        ...session.productInformation,
        productImagePathname: dto.pathname,
        productImageMimeType: mimeType,
        // §3.3 ТЗ скетча: НОВОЕ фото отвязывает прежний скетч — иначе
        // загрузка молча ничего не меняла бы, генерация продолжала бы
        // брать рисунок со старого снимка (аудит A-14). Сам скетч
        // остаётся в истории и применяется повторно одним нажатием.
        sketch: null,
        originalDeleted: false,
      },
    });
    // Сессию могли удалить между чтением и записью. Ответить «сохранено»
    // на несохранённое — ровно та ложь экрану, ради которой этот
    // подтверждающий шаг и заводится (тот же приём, что в
    // `submitProductInfo` выше).
    if (!updated) {
      this.logger.warn(`сессия ${sessionId} исчезла между чтением и записью`);
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    return { success: true, pathname: dto.pathname };
  }
}
