/**
 * Э6: маршруты внутреннего API обучалки генератора для роликов и карты
 * интерфейса (site-media.controller.ts) — свой модуль в папке Ш1, чтобы не
 * править её модуль: та же подпись (TutorialHmacGuard + журнал id), то же
 * правило графа `internal-sites-scope` (только site-core).
 *
 * Э-С Ш4: здесь же карта интерфейса для Flow-QA (internal-ui-map.*) — свой
 * секрет и вызывающий (QaHmacGuard), тот же журнал id.
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { InternalUiMapController } from './internal-ui-map.controller';
import { InternalUiMapService } from './internal-ui-map.service';
import { QaHmacGuard } from './qa-hmac.guard';
import { InternalRequestLedger } from './request-ledger';
import { InternalSiteMediaController } from './site-media.controller';
import { InternalSiteMediaService } from './site-media.service';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({
  imports: [SiteCoreModule],
  controllers: [InternalSiteMediaController, InternalUiMapController],
  providers: [
    InternalSiteMediaService,
    InternalUiMapService,
    InternalRequestLedger,
    TutorialHmacGuard,
    QaHmacGuard,
  ],
})
export class InternalSiteMediaModule {}
