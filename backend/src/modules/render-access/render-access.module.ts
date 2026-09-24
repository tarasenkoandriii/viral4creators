/**
 * Модуль права на рендер (этап 132).
 *
 * Экспортирует один сервис и импортируется всеми, кто стартует рендер:
 * `GenerationModule`, `GreetingVideoModule`, `CatalogBatchModule`.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlanModule } from '../plan/plan.module';
import { CreditLedgerModule } from '../credit-ledger/credit-ledger.module';
import { RenderAccessService } from './render-access.service';
import { RenderCompletedService } from './render-completed.service';
import { SharedVideoModule } from '../shared-video/shared-video.module';
import { InviteModule } from '../invite/invite.module';

@Module({
  imports: [
    PrismaModule,
    PlanModule,
    CreditLedgerModule,
    // Потребители момента «ролик готов» (этап 134): счётчик конверсии
    // шеринга и засчёт приглашения.
    SharedVideoModule,
    InviteModule,
  ],
  providers: [RenderAccessService, RenderCompletedService],
  exports: [RenderAccessService, RenderCompletedService],
})
export class RenderAccessModule {}
