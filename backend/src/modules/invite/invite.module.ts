/**
 * Кабинет «Пригласить» (этап 133) и всё, чем открывается стена.
 *
 * Этапом 134 сюда приедут приглашения, этапом 136 — подтверждение через
 * YouTube; модуль заведён сразу под всё это, чтобы кабинет не пришлось
 * собирать из трёх мест.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CreditLedgerModule } from '../credit-ledger/credit-ledger.module';
import { WizardGuideModule } from '../wizard-guide/wizard-guide.module';
import { InviteController } from './invite.controller';
import { ReferralPublicController } from './referral-public.controller';
import { InviteService } from './invite.service';
import { TelegramMembershipService } from './telegram-membership.service';
import { ReferralService } from './referral.service';
import { LiteUnlockService } from './lite-unlock.service';

@Module({
  // WizardGuideModule — ради `WizardTelemetryService`: своей таблицы
  // телеметрии у кабинета нет намеренно (§12.2 ТЗ говорит «тем же
  // механизмом, что телеметрия мастера»), а вторая таблица без
  // идентификаторов отличалась бы от той только именем.
  imports: [PrismaModule, CreditLedgerModule, WizardGuideModule],
  controllers: [InviteController, ReferralPublicController],
  providers: [
    InviteService,
    TelegramMembershipService,
    ReferralService,
    LiteUnlockService,
  ],
  exports: [InviteService, ReferralService, LiteUnlockService],
})
export class InviteModule {}
