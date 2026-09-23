import { Module } from '@nestjs/common';
import { WizardGuideController } from './wizard-guide.controller';
import { WizardGuideService } from './wizard-guide.service';
import { AdminWizardGuideService } from './admin-wizard-guide.service';
import { WizardHintService } from './wizard-hint.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';

@Module({
  controllers: [WizardGuideController],
  providers: [
    WizardGuideService,
    WizardHintService,
    AdminWizardGuideService,
    PlatformSettingsService,
  ],
  exports: [WizardGuideService, AdminWizardGuideService],
})
export class WizardGuideModule {}
