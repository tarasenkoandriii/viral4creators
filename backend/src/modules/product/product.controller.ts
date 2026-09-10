import { Controller, Post, Body, Param } from '@nestjs/common';
import { ProductService } from './product.service';
import { SubmitProductInfoRequestDto } from './dto/submit-product-info-request.dto';
import { SubmitProductInfoResponseDto } from './dto/submit-product-info-response.dto';
import { UploadProductImageRequestDto } from './dto/upload-product-image-request.dto';
import { UploadProductImageResponseDto } from './dto/upload-product-image-response.dto';

/**
 * ProductController handles product information endpoints
 *
 * Note: there used to be a second, direct-upload endpoint here
 * (`POST .../image/upload`, Multer, "bypasses S3 CORS") — removed. It
 * buffered the whole image in the request body, which is exactly what
 * Vercel's 4.5MB Function body limit forbids; a real phone photo
 * (3-8MB) would fail with 413 FUNCTION_PAYLOAD_TOO_LARGE every time.
 * See doc/VERCEL-READINESS-AUDIT.md, finding #4. The presigned-URL endpoint
 * below (already the frontend's only path — see
 * frontend/src/services/api.ts's uploadProductImage) is the same fix
 * already applied to the reference-video upload; the body never passes
 * through the backend either way. It now issues a Vercel Blob URL rather
 * than an S3 one — the product image and the generated video both moved
 * off S3 onto Blob, so there's exactly one storage provider in the app.
 */
@Controller('sessions/:sessionId/product')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  /**
   * Submit product information (name and description)
   * POST /sessions/:sessionId/product
   */
  @Post()
  async submitProductInfo(
    @Param('sessionId') sessionId: string,
    @Body() dto: SubmitProductInfoRequestDto,
  ): Promise<SubmitProductInfoResponseDto> {
    return this.productService.submitProductInfo(sessionId, dto);
  }

  /**
   * Get presigned upload URL for product image
   * POST /sessions/:sessionId/product/image/upload-url
   */
  @Post('image/upload-url')
  async getProductImageUploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: UploadProductImageRequestDto,
  ): Promise<UploadProductImageResponseDto> {
    return this.productService.generateProductImageUploadUrl(sessionId, dto);
  }
}
