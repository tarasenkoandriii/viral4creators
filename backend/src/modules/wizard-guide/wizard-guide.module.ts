import { Module } from '@nestjs/common';
import { WizardGuideController } from './wizard-guide.controller';
import { WizardGuideService } from './wizard-guide.service';
import { AdminWizardGuideService } from './admin-wizard-guide.service';
import { WizardHintService } from './wizard-hint.service';
import { WizardTelemetryService } from './wizard-telemetry.service';
import { ExperienceService } from './experience.service';
import { AdminExperienceService } from './admin-experience.service';
import { SiblingsService } from './siblings.service';
import { TranslationService } from './translation.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';

@Module({
  controllers: [WizardGuideController],
  providers: [
    WizardGuideService,
    WizardHintService,
    WizardTelemetryService,
    ExperienceService,
    AdminExperienceService,
    SiblingsService,
    TranslationService,
    AdminWizardGuideService,
    PlatformSettingsService,
  ],
  exports: [
    WizardGuideService,
    AdminWizardGuideService,
    WizardTelemetryService,
    ExperienceService,
    AdminExperienceService,
    SiblingsService,
  ],
})
export class WizardGuideModule {}
