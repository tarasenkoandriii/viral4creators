/**
 * Модуль ядра `site-core` — общий с QA (ТЗ помощника §4.2, QA-ТЗ §1.5):
 * кабинет, участники и роли, сайты, хосты, подтверждение владения
 * (DNS/файл/мета, 90 дней, отзыв), перепроверка кроном, opt-out.
 *
 * Экспортирует то, что нужно продуктовым модулям:
 *  - `HostAccessService.assertHostVerified(hostId, purpose)` — уровни L0–L1;
 *  - `SiteAccountGuard` + `@RequireAccountRoles`/`@RequireProductRoles`/
 *    `@Membership()` — кабинет и права в их контроллерах;
 *  - `AccountService` — кабинет по telegramId;
 *  - `SitesService` — сайты и хосты кабинета (Э-С Ш1: внутренний API
 *    обучалки генератора регистрирует хост тем же кодом, что экран TMA).
 *
 * Э-С Ш4: общая карта интерфейса — `ui-map/` (модель, приём снимков,
 * сводка; функции берут клиент базы параметром) и крон её обслуживания.
 *
 * `SitesDb` приходит из глобального PrismaModule; идентичность запроса —
 * из глобального `TelegramIdentityGuard` (telegram-auth).
 */

import { Module } from '@nestjs/common';
import { AccountService } from './account/account.service';
import { InvitePreviewController } from './account/invite-preview.controller';
import { SiteAccountGuard } from './account/site-account.guard';
import { SiteOwnershipRecheckController } from './cron/site-ownership-recheck.controller';
import { SiteUiMapMaintenanceController } from './cron/site-ui-map-maintenance.controller';
import { HostAccessService } from './ownership/host-access.service';
import { OwnershipChecker } from './ownership/ownership-checker';
import { OwnershipRecheckService } from './ownership/ownership-recheck.service';
import { OwnershipService } from './ownership/ownership.service';
import { SiteAccountController, SitesController } from './site-core.controller';
import { SitesService } from './sites/sites.service';
import { UiMapMaintenanceService } from './ui-map/ui-map-maintenance.service';

@Module({
  controllers: [
    SiteAccountController,
    // Аудит Н-1: превью приглашения до принятия.
    InvitePreviewController,
    SitesController,
    SiteOwnershipRecheckController,
    // Э-С Ш4: ретенция и достройка общей карты интерфейса.
    SiteUiMapMaintenanceController,
  ],
  providers: [
    // Без аргументов — настоящие DoH-резолверы и SSRF-ворота; тесты
    // подменяют провайдер целиком.
    { provide: OwnershipChecker, useFactory: () => new OwnershipChecker() },
    AccountService,
    SiteAccountGuard,
    SitesService,
    OwnershipService,
    OwnershipRecheckService,
    HostAccessService,
    UiMapMaintenanceService,
  ],
  exports: [AccountService, SiteAccountGuard, HostAccessService, SitesService],
})
export class SiteCoreModule {}
