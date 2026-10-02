/**
 * Внутренний API sites-backend для обучалки генератора (Э-С Ш1; П-С3,
 * П-Т1; Ш2 — хранилище учётных данных, `internal-credentials.*`). Лист
 * графа: из продуктов берёт только ядра `site-core` и `site-credentials`, и его
 * никто не импортирует (правило `internal-sites-leaf`,
 * scripts/check-sites-import-graph.mjs) — канал «генератор → кабинет» не
 * должен прорастать в модули помощника и QA.
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCredentialsModule } from '../site-credentials/site-credentials.module';
import { InternalCredentialsController } from './internal-credentials.controller';
import { InternalCredentialsService } from './internal-credentials.service';
import { InternalSitesController } from './internal-sites.controller';
import { InternalSitesService } from './internal-sites.service';
import { InternalRequestLedger } from './request-ledger';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({
  imports: [SiteCoreModule, SiteCredentialsModule],
  controllers: [InternalSitesController, InternalCredentialsController],
  providers: [
    InternalSitesService,
    InternalCredentialsService,
    InternalRequestLedger,
    TutorialHmacGuard,
  ],
})
export class InternalSitesModule {}
