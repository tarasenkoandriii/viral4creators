import { Module } from '@nestjs/common';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { LEAD_ENRICH_PORT, RATE_LIMIT_RESET_PORT } from '../core/ports';
import { PublisherLeadContactsController } from './contacts.controller';
import { LeadEnrichJob, LeadEnrichService } from './lead-enrich.job';
import { PublisherLeadsController } from './leads.controller';
import { LeadsMemberReassign, LeadsRateLimitReset } from './leads-ports';
import { LeadsService } from './leads.service';
import {
  ContactOverdueJob,
  NotificationsDeliverJob,
  NotificationsService,
} from './notifications.service';
import { PaymentsService } from './payments.service';
import { ProspectsService } from './prospects.service';
import { QueueChecksService } from './queue-checks.service';
import { FormAfterT72Job, RetentionReviewJob } from './retention.jobs';
import { TrafficPassportService } from './traffic-passport.service';

/**
 * AI Publisher — заявки, проспекты, оплаты клиентов, уведомления,
 * ретенция, паспорт трафика F11 (зона P-D, проектный документ §2, §16.6).
 * Публичный приём — `public/intake-public.module.ts` (роль
 * `publisher_public`); здесь — кабинет и задания под основной ролью.
 *
 * Порты для ядра: `LEAD_ENRICH_PORT` (обогащение вне очереди),
 * `RATE_LIMIT_RESET_PORT` (сброс окна лимита тестового продукта); вклады —
 * задания `lead-enrich`, `notifications-deliver`, `contact-overdue`,
 * `retention-review`, `form-after-t72` и переназначение `leads`.
 */
@Module({
  imports: [PublisherCoreModule],
  controllers: [PublisherLeadsController, PublisherLeadContactsController],
  providers: [
    ProspectsService,
    LeadEnrichService,
    LeadsService,
    PaymentsService,
    NotificationsService,
    QueueChecksService,
    TrafficPassportService,
    LeadsRateLimitReset,
    LeadEnrichJob,
    NotificationsDeliverJob,
    ContactOverdueJob,
    RetentionReviewJob,
    FormAfterT72Job,
    LeadsMemberReassign,
    { provide: LEAD_ENRICH_PORT, useExisting: LeadEnrichService },
    { provide: RATE_LIMIT_RESET_PORT, useExisting: LeadsRateLimitReset },
  ],
  exports: [LeadEnrichService, NotificationsService],
})
export class PublisherLeadsModule {}
