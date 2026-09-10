import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import {
  AdminPublicationController,
  PublicationController,
} from './publication.controller';
import { PublicationService } from './publication.service';

/**
 * PublicationModule — moderation queue for publishing (spec §8/§11,
 * Stage 18 without channel integrations). AdminPanelService is provided
 * here too only for `assertOperator` — it is stateless over Prisma.
 */
@Module({
  imports: [AdminAuthModule, StorageModule],
  controllers: [PublicationController, AdminPublicationController],
  providers: [PublicationService, AdminPanelService],
  exports: [PublicationService],
})
export class PublicationModule {}
