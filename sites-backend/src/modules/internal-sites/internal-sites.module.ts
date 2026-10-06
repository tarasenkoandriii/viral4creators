/**
 * Внутренний API sites-backend для обучалки генератора (Э-С Ш1; П-С3,
 * П-Т1; Ш2 — хранилище учётных данных, `internal-credentials.*`). Лист
 * графа: из продуктов берёт только ядра `site-core`, `site-credentials` и
 * (Ш3) очередь `browser-jobs` (кадры обучалки воркером), и его
 * никто не импортирует (правило `internal-sites-leaf`,
 * scripts/check-sites-import-graph.mjs) — канал «генератор → кабинет» не
 * должен прорастать в модули помощника и QA.
 */
import { Module } from '@nestjs/common';
import { BrowserJobsModule } from '../browser-jobs/browser-jobs.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCredentialsModule } from '../site-credentials/site-credentials.module';
import { InternalCredentialsController } from './internal-credentials.controller';
import { InternalCredentialsService } from './internal-credentials.service';
import { InternalFramesController } from './internal-frames.controller';
import { InternalFramesService } from './internal-frames.service';
import { InternalSitesController } from './internal-sites.controller';
import { InternalSitesService } from './internal-sites.service';
import { InternalRequestLedger } from './request-ledger';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({
  imports: [SiteCoreModule, SiteCredentialsModule, BrowserJobsModule],
  controllers: [
    InternalSitesController,
    InternalCredentialsController,
    InternalFramesController,
  ],
  providers: [
    InternalSitesService,
    InternalCredentialsService,
    InternalFramesService,
    InternalRequestLedger,
    TutorialHmacGuard,
  ],
})
export class InternalSitesModule {}
