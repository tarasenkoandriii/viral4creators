import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ProductAnalogController } from './product-analog.controller';
import { ProductAnalogService } from './product-analog.service';
import { SerpApiLensService } from './serpapi-lens.service';
import { ProductRecognitionService } from './product-recognition.service';
import { SerpApiUsageService } from './serpapi-usage.service';

/**
 * ProductAnalogModule — photo → market analogs (SerpApi Google Lens, ported
 * from SilverFinance) + auto category (Gemini vision) for a ProductItem.
 * doc/PRODUCT-PROJECT-SPEC.md §6.1; Stage 4 of the plan.
 *
 * Own module rather than a method on ProjectModule (the plan left this
 * open): it carries three external integrations (Blob, SerpApi, Gemini)
 * and the usage counter — keeping ProjectService a plain CRUD service.
 */
@Module({
  imports: [StorageModule],
  controllers: [ProductAnalogController],
  providers: [
    ProductAnalogService,
    SerpApiLensService,
    ProductRecognitionService,
    SerpApiUsageService,
  ],
  exports: [SerpApiUsageService],
})
export class ProductAnalogModule {}
