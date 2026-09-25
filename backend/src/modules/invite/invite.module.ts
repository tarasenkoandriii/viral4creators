/**
 * Кабинет «Пригласить» (этап 133) и всё, чем открывается стена.
 *
 * Этапом 134 сюда приехали приглашения, этапом 140 — подтверждение
 * через YouTube; модуль заведён сразу под всё это, чтобы кабинет не
 * пришлось собирать из трёх мест.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CreditLedgerModule } from '../credit-ledger/credit-ledger.module';
import { WizardGuideModule } from '../wizard-guide/wizard-guide.module';
import {
  InviteController,
  PublicYoutubeUnlockController,
} from './invite.controller';
import { ReferralPublicController } from './referral-public.controller';
import { InviteService } from './invite.service';
import { TelegramMembershipService } from './telegram-membership.service';
import { ReferralService } from './referral.service';
import { LiteUnlockService } from './lite-unlock.service';
import { YoutubeUnlockService } from './youtube-unlock.service';
import { PublishingChannelModule } from '../publishing-channel/publishing-channel.module';

@Module({
  // WizardGuideModule — ради `WizardTelemetryService`: своей таблицы
  // телеметрии у кабинета нет намеренно (§12.2 ТЗ говорит «тем же
  // механизмом, что телеметрия мастера»), а вторая таблица без
  // идентификаторов отличалась бы от той только именем.
  //
  // PublishingChannelModule (этап 140) — ради двух вещей сразу:
  // `GoogleOAuthService` (ссылка согласия только на чтение) и
  // `PublishingChannelService.ensureFreshToken` (у кого канал уже
  // подключён, у того нужное право есть, и второй экран согласия ему
  // показывать незачем). Цикла нет: тот модуль про кабинет не знает.
  imports: [
    PrismaModule,
    CreditLedgerModule,
    WizardGuideModule,
    PublishingChannelModule,
  ],
  controllers: [
    InviteController,
    ReferralPublicController,
    PublicYoutubeUnlockController,
  ],
  providers: [
    InviteService,
    TelegramMembershipService,
    ReferralService,
    LiteUnlockService,
    YoutubeUnlockService,
  ],
  exports: [
    InviteService,
    ReferralService,
    LiteUnlockService,
    YoutubeUnlockService,
  ],
})
export class InviteModule {}
