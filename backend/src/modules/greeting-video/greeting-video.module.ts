import { Module } from '@nestjs/common';
import { GreetingVideoController } from './greeting-video.controller';
import { GreetingVideoService } from './greeting-video.service';
import { GrokVideoService } from '../generation/grok-video.service';
import { HedraClientService } from '../actors/hedra-client.service';
import { StorageModule } from '../storage/storage.module';
import { RenderAccessModule } from '../render-access/render-access.module';

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
  // `RenderAccessModule` — этап 132: поздравление стало вторым местом,
  // где стоит стена, и первым, где греетинг вообще касается кредитов.
  imports: [StorageModule, RenderAccessModule],
  controllers: [GreetingVideoController],
  // `HedraClientService` — по тому же доводу, что и `GrokVideoService`
  // строкой выше: `ActorsModule` его не экспортирует, а собственных
  // зависимостей у клиента нет (он только читает `HEDRA_API_KEY` и
  // ходит по HTTP), поэтому второй экземпляр здесь ровно так же
  // безопасен. `TtsProviderResolverService` отдельной регистрации не
  // требует — `TtsModule` помечен `@Global()` и экспортирует его.
  providers: [GreetingVideoService, GrokVideoService, HedraClientService],
  exports: [GreetingVideoService],
})
export class GreetingVideoModule {}
