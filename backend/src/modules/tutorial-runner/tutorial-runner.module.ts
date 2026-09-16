import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { PublicationModule } from '../publication/publication.module';
import { StorageModule } from '../storage/storage.module';
import { TutorialScenarioRunnerService } from './tutorial-scenario-runner.service';
import { TutorialVideoAdminController } from './tutorial-video-admin.controller';
import { TutorialVideoAdminService } from './tutorial-video-admin.service';

/**
 * TutorialRunnerModule — исполнитель уже сгенерированных сценариев
 * обучающих видео (§5 ТЗ doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md,
 * этап 97). Отдельно от `TutorialScenarioModule` (этап 94, генерация
 * сценариев ИИ) намеренно: разная семантика (авторство vs исполнение),
 * разный риск-профиль (генерация — только текстовый вызов Gemini,
 * исполнение — реальный headless-браузер и запросы к самому продукту) и
 * свой крон-слот с job-локом (`tutorial-scenario-run`, см.
 * `cron-jobs.service.ts`) — совмещать их в один проход значило бы
 * пускать в исполнение только что сгенерированный, ещё не одобренный
 * платный сценарий в ту же секунду, что подрывает смысл одобрения
 * (§4.11 ТЗ: одобрение должно успеть случиться МЕЖДУ генерацией и
 * первым исполнением).
 *
 * `PrismaService`/`TelegramNotifyService`/`FfmpegApiService` —
 * global-модули (последний — через `PostProductionModule`, `@Global()`),
 * явный импорт не требуется (тот же приём, что у `TutorialScenarioModule`).
 * `StorageModule` (`BlobService`, этап 98 — загрузка кадров-транзитов и
 * готового слайд-шоу) — НЕ глобальный, импортируется явно.
 *
 * `TutorialVideoAdminController`/`Service` (этап 99, §4.9) — вкладка
 * «Видео-контент»/«Состояние данных» админки, тот же приём, что
 * `TutorialScenarioAdminController` в соседнем `TutorialScenarioModule`:
 * `AdminAuthModule`/`AdminPanelModule` импортируются явно (не global) для
 * `AdminSessionGuard`/`AdminPanelService.assertOperator`.
 *
 * `PublicationModule` (этап 101, ТЗ §4.7, Фаза 3) — `POST .../:id/publish`
 * контроллера выше делегирует в `PublicationService.publishTutorialVideo`,
 * ту же очередь/воркер, что уже обслуживает рекламные ролики (не новый
 * модуль/воркер специально под обучающие видео).
 */
@Module({
  imports: [
    StorageModule,
    AdminAuthModule,
    AdminPanelModule,
    PublicationModule,
  ],
  controllers: [TutorialVideoAdminController],
  providers: [TutorialScenarioRunnerService, TutorialVideoAdminService],
  exports: [TutorialScenarioRunnerService],
})
export class TutorialRunnerModule {}
