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

    // Update session with image metadata (will be updated after actual upload)
    await this.sessionService.updateSession(sessionId, {
      productInformation: {
        ...session.productInformation,
        productImagePathname: pathname,
        productImageMimeType: dto.mimeType,
      },
    });

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
}
