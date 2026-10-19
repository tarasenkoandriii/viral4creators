import { NarratorPreambleService } from './narrator-preamble.service';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BrandManifestController } from './brand-manifest.controller';
import { BrandManifestService } from './brand-manifest.service';
import { ImageSketchModule } from '../image-sketch/image-sketch.module';
import { NarratorLooksController } from './narrator-looks.controller';
import { NarratorLooksService } from './narrator-looks.service';

/**
 * BrandManifestModule — the надпроектная сущность of
 * doc/PRODUCT-PROJECT-SPEC.md §12: brand style (filters/effects/notes) +
 * reusable brand characters. Stage 7 of the plan. Independent of the
 * Project module by data (own tables); only StorageModule for the
 * character-photo presigned flow.
 */
@Module({
  // ImageSketchModule — тот же генератор картинок, что у скетча и образов
  // персоны (WP5: образы рассказчика Story‑Tales).
  imports: [StorageModule, ImageSketchModule],
  controllers: [BrandManifestController, NarratorLooksController],
  providers: [
    BrandManifestService,
    NarratorPreambleService,
    NarratorLooksService,
  ],
  // NarratorLooksService.resolveNarratorImage — точка интеграции видео Story (WP4).
  exports: [
    BrandManifestService,
    NarratorPreambleService,
    NarratorLooksService,
  ],
})
export class BrandManifestModule {}
