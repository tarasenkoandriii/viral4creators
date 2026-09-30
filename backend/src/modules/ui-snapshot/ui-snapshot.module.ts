import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { UiSnapshotAdminController } from './ui-snapshot-admin.controller';
import { UiSnapshotRunnerService } from './ui-snapshot-runner.service';
import { ClientSiteTutorialModule } from '../client-site-tutorial/client-site-tutorial.module';
import { TutorialFramesCaptureService } from './tutorial-frames-capture.service';
import { GreetingFramesCaptureService } from './greeting-frames-capture.service';
import { GreetingPromptModule } from '../greeting-prompt/greeting-prompt.module';
import { GreetingVideoModule } from '../greeting-video/greeting-video.module';
import { GreetingSessionEditModule } from '../greeting-session-edit/greeting-session-edit.module';

/**
 * UiSnapshotModule — крон-обход интерфейса TMA (Часть А ТЗ, §3
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 100). Отдельно от
 * `TutorialRunnerModule` (Часть Б, обучающие видео) сознательно — разные
 * крон-слоты с собственными джоб-локами (`ui-snapshot-run` vs
 * `tutorial-scenario-run`, см. `cron-jobs.service.ts`), разная частота
 * расписания (раз в две минуты тут, суточная там, `backend/vercel.json`) и
 * разное назначение (регресс-проверка вёрстки vs сбор обучающего
 * контента) — совмещать их в один модуль/крон означало бы делать их
 * бюджеты времени и алерты неразличимыми друг от друга. Общая
 * инфраструктура (`common/headless-chromium.ts`, `tutorial-runner/
 * route-templates.ts`) переиспользуется прямым импортом чистых функций,
 * не через общий модуль — см. доккомментарий `UiSnapshotRunnerService`.
 *
 * `PrismaService`/`TelegramNotifyService` — global-модули, явный импорт
 * не требуется (тот же приём, что у `TutorialRunnerModule`).
 * `StorageModule` (`BlobService`) — НЕ глобальный, импортируется явно.
 */
@Module({
  imports: [
    StorageModule,
    AdminAuthModule,
    AdminPanelModule,
    // Нужен ровно за одним: сбросить черновик обучалки перед съёмкой
    // (`TutorialFramesCaptureService`). Цикла нет — модуль обучалки про
    // снимки не знает.
    ClientSiteTutorialModule,
    // Нужны ровно за одним: оператор доводит ролик фикстуры под кадр 4
    // страницы поздравлений (`GreetingFramesCaptureService.fixtureVideo`)
    // тем же конвейером, что и кнопка человека. Цикла нет — модули
    // поздравления про снимки не знают.
    GreetingPromptModule,
    GreetingVideoModule,
    // Переснять готовый ролик фикстуры — новой версией сессии (CONTRACT6:
    // готовый ролик на месте не перерендеривается).
    GreetingSessionEditModule,
  ],
  controllers: [UiSnapshotAdminController],
  providers: [
    UiSnapshotRunnerService,
    TutorialFramesCaptureService,
    GreetingFramesCaptureService,
  ],
  exports: [
    UiSnapshotRunnerService,
    TutorialFramesCaptureService,
    GreetingFramesCaptureService,
  ],
})
export class UiSnapshotModule {}
