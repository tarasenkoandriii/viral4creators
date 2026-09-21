import { Module } from '@nestjs/common';
import { GreetingVideoController } from './greeting-video.controller';
import { GreetingVideoService } from './greeting-video.service';
import { GrokVideoService } from '../generation/grok-video.service';
import { StorageModule } from '../storage/storage.module';

/**
 * GreetingVideoModule — POST/GET /sessions/:id/greeting-video (ТЗ
 * TZ-Greeting-Video-Project-Type.md §5.3).
 *
 * `GrokVideoService` is its own provider here, NOT imported from
 * `GenerationModule` — that module doesn't export it (only
 * `GenerationService`/`GrokVideoBatchService` are exported) and isn't
 * `@Global()`. `GrokVideoService`'s constructor takes no DI dependencies
 * of its own (just reads config), so a second instance is exactly as
 * safe as the one `ActorsModule` already keeps for `GeminiFilesService`
 * for the same reason (see that module's doc-comment).
 * `PostProductionService`/`PlanService`/`SessionService`/`AiUsageService`
 * are all `@Global()`, nothing to import for those.
 */
@Module({
  imports: [StorageModule],
  controllers: [GreetingVideoController],
  providers: [GreetingVideoService, GrokVideoService],
  exports: [GreetingVideoService],
})
export class GreetingVideoModule {}
