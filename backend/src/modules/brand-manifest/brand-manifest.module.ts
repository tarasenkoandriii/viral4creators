import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BrandManifestController } from './brand-manifest.controller';
import { BrandManifestService } from './brand-manifest.service';

/**
 * BrandManifestModule — the надпроектная сущность of
 * doc/PRODUCT-PROJECT-SPEC.md §12: brand style (filters/effects/notes) +
 * reusable brand characters. Stage 7 of the plan. Independent of the
 * Project module by data (own tables); only StorageModule for the
 * character-photo presigned flow.
 */
@Module({
  imports: [StorageModule],
  controllers: [BrandManifestController],
  providers: [BrandManifestService],
  exports: [BrandManifestService],
})
export class BrandManifestModule {}
