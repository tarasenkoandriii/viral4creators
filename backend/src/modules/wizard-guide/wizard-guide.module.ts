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
import { HintAudioService } from './hint-audio.service';
import { StorageModule } from '../storage/storage.module';
import { VoiceBudgetModule } from '../voice-budget/voice-budget.module';

@Module({
  // Голос советника (ТЗ Greeting 2.0 §4А.4, K1): Blob — для аудиокеша,
  // потолок голоса В-14 — отдельным модулем, общим с распознаванием.
  // Синтез (`TtsProviderResolverService`) приходит из глобального
  // `TtsModule`.
  imports: [StorageModule, VoiceBudgetModule],
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
    HintAudioService,
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
