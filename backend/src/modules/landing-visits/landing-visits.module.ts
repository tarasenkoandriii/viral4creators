import { Module } from '@nestjs/common';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { LandingVisitsService } from './landing-visits.service';
import {
  LandingVisitsController,
  AdminLandingVisitsController,
} from './landing-visits.controller';
@Module({
  imports: [AdminPanelModule, AdminAuthModule],
  controllers: [LandingVisitsController, AdminLandingVisitsController],
  providers: [LandingVisitsService],
})
export class LandingVisitsModule {}
