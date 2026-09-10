import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { StorageModule } from '../storage/storage.module';

/**
 * ProductModule handles product information management
 *
 * Multer/MulterModule removed along with the direct-upload endpoint (see
 * ProductController's doc comment and doc/VERCEL-READINESS-AUDIT.md, finding
 * #4) — product images now go through the presigned-URL flow only, same
 * as the reference video, so there's no multipart body for Nest to parse.
 */
@Module({
  imports: [StorageModule],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
