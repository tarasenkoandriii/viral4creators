import { Module } from '@nestjs/common';
import { GreetingBriefModule } from '../greeting-brief/greeting-brief.module';
import { PromptModule } from '../prompt/prompt.module';
import { StorageModule } from '../storage/storage.module';
import { GreetingSessionEditController } from './greeting-session-edit.controller';
import { GreetingSessionEditService } from './greeting-session-edit.service';

/**
 * Этап C (§3.6): правка брифа и сценария после старта сессии.
 * SessionService и PlanService — глобальные провайдеры.
 *
 * `GreetingBriefModule` — ради одной проверки правки на оба пути
 * (`GreetingBriefService.resolveNext`); `PromptModule` — ради той же
 * модерации, что у сборки сценария; `StorageModule` — копии файлов
 * для новой версии сессии.
 */
@Module({
  imports: [GreetingBriefModule, PromptModule, StorageModule],
  controllers: [GreetingSessionEditController],
  providers: [GreetingSessionEditService],
  // Перерендер фикстуры новой версией (`UiSnapshotModule`, CONTRACT6).
  exports: [GreetingSessionEditService],
})
export class GreetingSessionEditModule {}
