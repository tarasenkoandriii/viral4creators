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
import { ProactiveSpeechService } from './proactive-speech.service';
import { StorageModule } from '../storage/storage.module';
import { VoiceBudgetModule } from '../voice-budget/voice-budget.module';
import { VoiceUploadModule } from '../voice-upload/voice-upload.module';

@Module({
  // Голос советника (ТЗ Greeting 2.0 §4А.4, K1): Blob — для аудиокеша,
  // потолок голоса В-14 — отдельным модулем, общим с распознаванием.
  // Синтез (`TtsProviderResolverService`) приходит из глобального
  // `TtsModule`.
  // Учёт транзитных файлов — для личной реплики помощника (сводка перед
  // согласием, K4): крон `voice-uploads-sweep` удаляет её в пределах часа.
  imports: [StorageModule, VoiceBudgetModule, VoiceUploadModule],
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
    // Проактивная речь (K4) — поверх того же аудиокеша и потолков.
    ProactiveSpeechService,
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
