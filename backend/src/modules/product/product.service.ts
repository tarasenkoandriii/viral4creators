import {
  Injectable,
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

/**
 * ProductService handles product information submission and image uploads
 */
@Injectable()
export class ProductService {
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
      throw new NotFoundException(`Session ${sessionId} not found`);
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
      throw new NotFoundException(`Failed to update session ${sessionId}`);
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
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    // Validate product info has been added
    if (!session.productInformation) {
      throw new BadRequestException(
        'Product information must be submitted before uploading image',
      );
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (dto.fileSize > maxSize) {
      throw new BadRequestException(
        `Image file size exceeds maximum of 10MB. Received: ${dto.fileSize} bytes`,
      );
    }

    // Validate MIME type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedTypes.includes(dto.mimeType)) {
      throw new BadRequestException(
        `Invalid image format. Allowed: ${allowedTypes.join(', ')}`,
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
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    if (!session.productInformation) {
      throw new BadRequestException(
        'Product information must be submitted before uploading image',
      );
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
      throw new BadRequestException(
        `pathname должен быть ровно "${prefix}<png|jpeg|webp>" — это не файл этой сессии`,
      );
    }

    try {
      await this.blobService.getPublicUrl(dto.pathname);
    } catch (e) {
      throw new BadRequestException(
        `Фото не найдено в хранилище по пути "${dto.pathname}" — загрузите его ещё раз (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }

    const updated = await this.sessionService.updateSession(sessionId, {
      productInformation: {
        ...session.productInformation,
        productImagePathname: dto.pathname,
        productImageMimeType: mimeType,
      },
    });
    // Сессию могли удалить между чтением и записью. Ответить «сохранено»
    // на несохранённое — ровно та ложь экрану, ради которой этот
    // подтверждающий шаг и заводится (тот же приём, что в
    // `submitProductInfo` выше).
    if (!updated) {
      throw new NotFoundException(`Failed to update session ${sessionId}`);
    }

    return { success: true, pathname: dto.pathname };
  }
}
