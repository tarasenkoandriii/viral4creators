import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { GreetingReferenceController } from './greeting-reference.controller';
import { GreetingReferenceService } from './greeting-reference.service';

/** Reference images for Grok reference-to-video on GREETING_VIDEO sessions. */
@Module({
  imports: [StorageModule],
  controllers: [GreetingReferenceController],
  providers: [GreetingReferenceService],
  exports: [GreetingReferenceService],
})
export class GreetingReferenceModule {}
