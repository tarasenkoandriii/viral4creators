/**
 * Внутренний API sites-backend для обучалки генератора (Э-С Ш1; П-С3,
 * П-Т1). Лист графа: из продуктов берёт только ядро `site-core`, и его
 * никто не импортирует (правило `internal-sites-leaf`,
 * scripts/check-sites-import-graph.mjs) — канал «генератор → кабинет» не
 * должен прорастать в модули помощника и QA.
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { InternalSitesController } from './internal-sites.controller';
import { InternalSitesService } from './internal-sites.service';
import { InternalRequestLedger } from './request-ledger';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({
  imports: [SiteCoreModule],
  controllers: [InternalSitesController],
  providers: [InternalSitesService, InternalRequestLedger, TutorialHmacGuard],
})
export class InternalSitesModule {}
