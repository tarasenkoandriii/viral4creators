import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import {
  ReferenceSlotsController,
  ScenesController,
} from './reference-assets.controller';
import { ReferenceAssetsService } from './reference-assets.service';

/** Scenes + explicit referenceImage slots (spec §17). */
@Module({
  imports: [StorageModule],
  controllers: [ScenesController, ReferenceSlotsController],
  providers: [ReferenceAssetsService],
  exports: [ReferenceAssetsService],
})
export class ReferenceAssetsModule {}
