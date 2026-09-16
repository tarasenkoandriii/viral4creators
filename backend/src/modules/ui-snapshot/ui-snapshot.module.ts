import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { UiSnapshotRunnerService } from './ui-snapshot-runner.service';

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
  imports: [StorageModule],
  providers: [UiSnapshotRunnerService],
  exports: [UiSnapshotRunnerService],
})
export class UiSnapshotModule {}
