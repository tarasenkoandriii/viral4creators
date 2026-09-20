import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import {
  AdminCreatorProfileController,
  CreatorProfileController,
  PublicCreatorController,
} from './creator-profile.controller';
import { CreatorProfileService } from './creator-profile.service';

/**
 * CreatorProfileModule — Этап 0 / Фаза 1 маркетплейса (ТЗ на маркетплейс
 * §9, §21.8, §20; ТЗ на бэкенд §6). Экспортирует сервис: `portfolio` и
 * `creator-inquiry` оба читают/проверяют CreatorProfile напрямую.
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule],
  controllers: [
    CreatorProfileController,
    PublicCreatorController,
    AdminCreatorProfileController,
  ],
  providers: [CreatorProfileService],
  exports: [CreatorProfileService],
})
export class CreatorProfileModule {}
