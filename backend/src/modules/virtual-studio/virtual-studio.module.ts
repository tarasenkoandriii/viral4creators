/**
 * VirtualStudioModule — «Виртуальная студия»
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md, Этап 1-3).
 *
 * По образцу `actors.module.ts`: `AdminPanelModule`/`AdminAuthModule` —
 * за `AdminPanelService`/`AdminSessionGuard`; `StorageModule`/
 * `AiUsageModule` — за `BlobService`/`AiUsageService`. `TtsModule`
 * — `@Global()` (см. tts.module.ts), поэтому `TtsProviderResolverService`
 * доступен без явного импорта, как и у `ActorsModule` для
 * `ResembleService`. `GeminiFilesService` — не глобальный и не
 * экспортируется своим модулем анализа — заведён здесь своим
 * провайдером, тем же приёмом, что `ActorsModule` уже делает для себя.
 *
 * `HedraClientService` переиспускается напрямую (тот же класс, что уже
 * заведён в `ActorsModule`) — оба модуля независимо заводят свой
 * экземпляр (нет общих зависимостей у самого клиента, см. доккомментарий
 * `hedra-client.service.ts`), тем же приёмом, что `AuctionAiAssessmentService`
 * заводит свой `GeminiFilesService`, не импортируя чужой модуль ради
 * одного провайдера. `GrokVideoService`/`GrokImageService` — тот же
 * принцип: оба без DI-зависимостей (`loadConfiguration()` напрямую),
 * заводятся своими провайдерами, не требуют импорта `GenerationModule`.
 */
import { Module } from '@nestjs/common';
import { VirtualStudioController } from './virtual-studio.controller';
import { VirtualStudioService } from './virtual-studio.service';
import { GrokImageService } from './grok-image.service';
import { GrokVideoService } from '../generation/grok-video.service';
import { HedraClientService } from '../actors/hedra-client.service';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [StorageModule, AiUsageModule, AdminPanelModule, AdminAuthModule],
  controllers: [VirtualStudioController],
  providers: [
    VirtualStudioService,
    GrokImageService,
    GrokVideoService,
    HedraClientService,
    GeminiFilesService,
  ],
})
export class VirtualStudioModule {}
