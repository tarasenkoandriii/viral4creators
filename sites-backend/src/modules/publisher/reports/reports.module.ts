import { Module } from '@nestjs/common';
import { PILOT_CLOCK_PORT } from '../core/ports';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { BackupService } from './backup.service';
import { backupStorageFromEnv, PUB_BACKUP_STORAGE } from './backup-storage';
import { ExperimentsService, PilotExperimentInit } from './experiments.service';
import {
  IntegrationsService,
  IntegrationsStalenessJob,
  MetricImportsService,
} from './integrations.service';
import {
  BackupPostPurchaseJob,
  BackupRotationJob,
  BackupWeeklyJob,
  PlacementDiagnosticsJob,
  ReportStalenessJob,
} from './report-jobs';
import { PublisherReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { RestoreService } from './restore.service';
import { TimeEntriesService } from './time-entries.service';

/**
 * AI Publisher — зона P-E (проектный документ §2, §16.7): отчёты и
 * метрики (§9.3–9.4), эксперименты F17 и `PilotClockPort`, труд,
 * интеграции и импорт метрик, резервные копии и восстановление (§15.4),
 * задания `integrations-staleness`, `report-staleness`,
 * `placement-diagnostics`, `backup-weekly`, `backup-post-purchase`,
 * `backup-rotation`, шаг создания продукта `pilot-experiment`.
 */
@Module({
  imports: [PublisherCoreModule],
  controllers: [PublisherReportsController],
  providers: [
    ReportsService,
    ExperimentsService,
    { provide: PILOT_CLOCK_PORT, useExisting: ExperimentsService },
    PilotExperimentInit,
    TimeEntriesService,
    IntegrationsService,
    MetricImportsService,
    BackupService,
    RestoreService,
    // Vercel Blob; каталог стенда — только стенд E2E (Р-PUB-Z2-22).
    { provide: PUB_BACKUP_STORAGE, useFactory: () => backupStorageFromEnv() },
    IntegrationsStalenessJob,
    ReportStalenessJob,
    PlacementDiagnosticsJob,
    BackupWeeklyJob,
    BackupPostPurchaseJob,
    BackupRotationJob,
  ],
  exports: [
    ReportsService,
    ExperimentsService,
    BackupService,
    RestoreService,
    PILOT_CLOCK_PORT,
  ],
})
export class PublisherReportsModule {}
