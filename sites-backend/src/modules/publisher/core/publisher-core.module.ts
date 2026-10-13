import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { SiteCoreModule } from '../../site-core/site-core.module';
import { AuditService } from './audit';
import { PubContributions } from './contributions';
import { GateService } from './gates';
import {
  IdempotencyHousekeepingJob,
  RateHitsSweepJob,
} from './housekeeping.job';
import { MembersReconcileJob } from './members-reconcile.job';
import { PubOperations } from './operation';
import { ParametersService } from './parameters.service';
import {
  AUDIT_PORT,
  GATE_PORT,
  PARAMETER_PORT,
  PubPorts,
  REVIEW_PORT,
} from './ports';
import { ProductAccessService } from './product-access.service';
import { PublisherCoreController } from './product.controller';
import { ProductService } from './product.service';
import { PubRoleGuard } from './pub-role.guard';
import { ReviewTasksService } from './review-tasks.service';
import { RoleGrantsService } from './role-grants.service';
import { SiteRevalidateJob } from './site-revalidate.job';

/**
 * AI Publisher — ядро (P-A1, проектный документ §2, §16.2): продукт↔сайт,
 * роли и гейты, параметры, аудит, идемпотентность и ревизии
 * (`PubOperations`), задачи проверки, порты, вклады пакетов, задания
 * `members-reconcile`/`housekeeping`/`rate-hits-sweep`.
 *
 * Пакеты этапа 1 импортируют ЭТОТ модуль: он реэкспортирует `SiteCoreModule`
 * (гварды кабинета для `@PubCabinetController`) и всё, что нужно их
 * сервисам (`PubOperations`, `PubPorts`, `ProductAccessService`, …). Свои
 * порты пакет кладёт провайдером с токеном в СВОЙ модуль — `PubPorts`
 * найдёт его без импорта.
 */
@Module({
  imports: [SiteCoreModule, DiscoveryModule],
  controllers: [PublisherCoreController],
  providers: [
    AuditService,
    PubOperations,
    PubPorts,
    PubContributions,
    ProductAccessService,
    PubRoleGuard,
    ParametersService,
    GateService,
    ReviewTasksService,
    RoleGrantsService,
    ProductService,
    MembersReconcileJob,
    IdempotencyHousekeepingJob,
    RateHitsSweepJob,
    SiteRevalidateJob,
    { provide: AUDIT_PORT, useExisting: AuditService },
    { provide: REVIEW_PORT, useExisting: ReviewTasksService },
    { provide: GATE_PORT, useExisting: GateService },
    { provide: PARAMETER_PORT, useExisting: ParametersService },
  ],
  exports: [
    SiteCoreModule,
    AuditService,
    PubOperations,
    PubPorts,
    PubContributions,
    ProductAccessService,
    PubRoleGuard,
    ParametersService,
    GateService,
    ReviewTasksService,
    AUDIT_PORT,
    REVIEW_PORT,
    GATE_PORT,
    PARAMETER_PORT,
  ],
})
export class PublisherCoreModule {}
