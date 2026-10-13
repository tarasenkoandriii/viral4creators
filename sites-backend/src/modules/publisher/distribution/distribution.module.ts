import { Module } from '@nestjs/common';
import { PublisherCoreModule } from '../core/publisher-core.module';
import {
  BUDGET_LIMIT_PORT,
  BUDGET_READ_PORT,
  PUBLICATIONS_PORT,
} from '../core/ports';
import {
  ApprovalsExpirePurchaseJob,
  PurchaseApprovalsService,
} from './approvals-purchase.service';
import { PublisherBudgetController } from './budget.controller';
import { BudgetReconcileJob } from './budget-reconcile.job';
import { BudgetService } from './budget.service';
import {
  BudgetLimitInit,
  ChannelsService,
  SiteChannelInit,
} from './channels.service';
import { PublisherDistributionController } from './distribution.controller';
import {
  DistributionActionsReassign,
  DistributionService,
} from './distribution.service';
import { ExpensesService } from './expenses.service';
import { PlacementsService } from './placements.service';
import {
  PublicationsService,
  PublicationsVerifyJob,
} from './publications.service';
import { VenuesService } from './venues.service';

/**
 * AI Publisher — зона P-C (проектный документ §2, §16.5): распространение
 * F09, площадки F10, закупки и бюджет F12.
 *
 * Отдаёт ядру и пакетам: порты `BUDGET_LIMIT_PORT` (сборка строки лимита
 * из параметров) и `BUDGET_READ_PORT` (снимок §9.2); вклады `product-init`
 * (`site-channel`, `budget-limit`), `member-reassign`
 * (`distribution-actions`) и задания кронов `approvals-expire-purchase`,
 * `publications-verify`, `budget-reconcile`.
 */
@Module({
  imports: [PublisherCoreModule],
  controllers: [PublisherDistributionController, PublisherBudgetController],
  providers: [
    BudgetService,
    PurchaseApprovalsService,
    PlacementsService,
    ExpensesService,
    ChannelsService,
    DistributionService,
    PublicationsService,
    VenuesService,
    SiteChannelInit,
    BudgetLimitInit,
    DistributionActionsReassign,
    ApprovalsExpirePurchaseJob,
    PublicationsVerifyJob,
    BudgetReconcileJob,
    { provide: BUDGET_LIMIT_PORT, useExisting: BudgetService },
    { provide: BUDGET_READ_PORT, useExisting: BudgetService },
    { provide: PUBLICATIONS_PORT, useExisting: PublicationsService },
  ],
  // ChannelsService — пакету P-R (канал `community` сообщества Reddit
  // создаётся сервисом P-C в операции P-R, Р-RD-2).
  exports: [
    BUDGET_LIMIT_PORT,
    BUDGET_READ_PORT,
    PUBLICATIONS_PORT,
    ChannelsService,
  ],
})
export class PublisherDistributionModule {}
