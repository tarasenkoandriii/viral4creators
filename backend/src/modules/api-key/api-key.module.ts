import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { V1Controller } from './v1.controller';
import { ApiVideoJobService } from './api-video-job.service';
import { ApiVideoJobWorker } from './api-video-job.worker';
import { ApiWebhookService } from './api-webhook.service';
import { ProjectSessionModule } from '../project-session/project-session.module';
import { LibraryModule } from '../library/library.module';
import { PromptModule } from '../prompt/prompt.module';
import { GenerationModule } from '../generation/generation.module';

/**
 * Ключи внешнего API и сам `/v1` (этап 144).
 *
 * Оба контроллера в одном модуле намеренно: управление ключами и вход
 * по ключу — две половины одного механизма, и разносить их значило бы
 * заводить между ними импорт ради красоты схемы.
 */
@Module({
  // `PlanModule` глобальный — отдельного импорта не требует. Остальные
  // четыре — путь мастера, который воркер проходит за человека
  // (этап 145): сессия от товара, разбор из библиотеки, промпт,
  // генерация.
  imports: [
    ProjectSessionModule,
    LibraryModule,
    PromptModule,
    GenerationModule,
  ],
  controllers: [ApiKeyController, V1Controller],
  providers: [
    ApiKeyService,
    ApiKeyGuard,
    ApiVideoJobService,
    ApiVideoJobWorker,
    // Этап 146 объявил сервис и внедрил его в воркер, но в провайдеры
    // не добавил: импорт в этом файле стоял, а строки здесь не было.
    // Nest не смог бы построить `ApiVideoJobWorker` — приложение не
    // поднялось бы вовсе. Тесты этого не ловят: они собирают сервисы
    // руками с дублями, минуя контейнер (найдено аудитом этапа 149 по
    // единственному следу — предупреждению eslint о неиспользованном
    // импорте).
    ApiWebhookService,
  ],
  exports: [ApiKeyService, ApiKeyGuard, ApiVideoJobWorker],
})
export class ApiKeyModule {}
