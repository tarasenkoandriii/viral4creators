import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { CastingController } from './casting.controller';
import { CastingService } from './casting.service';

/**
 * CastingModule — which analysed characters stay in the video and how
 * they are replaced (spec §10; Stage 14). SessionService is global.
 */
@Module({
  imports: [StorageModule],
  controllers: [CastingController],
  providers: [CastingService],
  exports: [CastingService],
})
export class CastingModule {}
