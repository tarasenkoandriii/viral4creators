/**
 * ActorsModule — пилот говорящего AI-аватара (Hedra Character-3 +
 * Resemble), doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md, этап 72.
 *
 * Первый (генерационный) срез уже предложенного в
 * doc/AI-ACTORS-NO-REFERENCE-SPEC.md §1.3 модуля `modules/actors/` —
 * `ActorCatalogService`/`SyntheticActor` (общий каталог актёров,
 * TODO п. 30) в этот пилот сознательно не входят (§3.3 документа).
 *
 * `AdminPanelModule`/`AdminAuthModule` — за `AdminPanelService`
 * (`assertOperator`) и `AdminSessionGuard`, тем же приёмом, что
 * `CronModule` уже подключает их для `AdminCronController` (этап 69).
 * `StorageModule`/`AiUsageModule` — за `BlobService`/`AiUsageService`.
 * `ResembleService` доступен без явного импорта `TtsModule` — тот
 * `@Global()` (см. tts.module.ts). Тем же приёмом доступен и
 * `FfmpegApiService` для прожига субтитров (этап 72а) — он экспортирован
 * из `@Global() PostProductionModule` (postprod.module.ts), отдельный
 * импорт здесь не нужен.
 *
 * `GeminiFilesService` (этап 73, звуковой чек — `runSoundCheck`) НЕ
 * глобальный и не экспортируется `AnalysisModule`/`VideoAuditModule` —
 * добавлен здесь своим провайдером, тем же приёмом, что
 * `VideoAuditModule` уже делает для себя (нет своих зависимостей, кроме
 * Gemini-ключа из окружения — безопасно завести второй экземпляр).
 */

import { Module } from '@nestjs/common';
import { ActorsController } from './actors.controller';
import { ActorsService } from './actors.service';
import { HedraClientService } from './hedra-client.service';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { GeminiFilesService } from '../analysis/gemini-files.service';

@Module({
  imports: [StorageModule, AiUsageModule, AdminPanelModule, AdminAuthModule],
  controllers: [ActorsController],
  providers: [ActorsService, HedraClientService, GeminiFilesService],
})
export class ActorsModule {}
