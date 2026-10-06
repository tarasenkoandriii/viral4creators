/**
 * Канал браузерного воркера Ш3 (`/internal/worker/v1/*`). Лист графа
 * (правило `internal-worker-scope`): берёт только очередь `browser-jobs`,
 * реестр учёток `site-credentials` (аренда `assist-admin-login`) и ядро; его
 * не импортирует никто.
 */
import { Module } from '@nestjs/common';
import { BrowserJobsModule } from '../browser-jobs/browser-jobs.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCredentialsModule } from '../site-credentials/site-credentials.module';
import { InternalWorkerController } from './internal-worker.controller';
import { InternalWorkerService } from './internal-worker.service';
import { WorkerHmacGuard } from './worker-hmac.guard';
import { WorkerRequestLedger } from './worker-request-ledger';

@Module({
  imports: [BrowserJobsModule, SiteCoreModule, SiteCredentialsModule],
  controllers: [InternalWorkerController],
  providers: [InternalWorkerService, WorkerHmacGuard, WorkerRequestLedger],
})
export class InternalWorkerModule {}
