/**
 * Э6: маршруты внутреннего API обучалки генератора для роликов и карты
 * интерфейса (site-media.controller.ts) — свой модуль в папке Ш1, чтобы не
 * править её модуль: та же подпись (TutorialHmacGuard + журнал id), то же
 * правило графа `internal-sites-scope` (только site-core).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { InternalRequestLedger } from './request-ledger';
import { InternalSiteMediaController } from './site-media.controller';
import { InternalSiteMediaService } from './site-media.service';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({
  imports: [SiteCoreModule],
  controllers: [InternalSiteMediaController],
  providers: [
    InternalSiteMediaService,
    InternalRequestLedger,
    TutorialHmacGuard,
  ],
})
export class InternalSiteMediaModule {}
