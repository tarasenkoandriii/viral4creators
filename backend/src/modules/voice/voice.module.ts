import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { VoiceTranscriptionService } from './voice-transcription.service';
import { GreetingVoiceController } from './greeting-voice.controller';
import { GreetingVoiceService } from './greeting-voice.service';
import { SonioxSttClient } from './soniox-stt.client';
import { GreetingVoiceUnderstandService } from './greeting-voice-understand.service';
import { ProjectGreetingVoiceController } from './project-greeting-voice.controller';
import { VoiceBudgetModule } from '../voice-budget/voice-budget.module';
import { GreetingVoiceModule } from '../greeting-voice/greeting-voice.module';
import { GreetingMusicModule } from '../greeting-music/greeting-music.module';
import { GreetingCardsModule } from '../greeting-cards/greeting-cards.module';
import { GreetingStickerModule } from '../greeting-sticker/greeting-sticker.module';
import { GreetingScenesModule } from '../greeting-scenes/greeting-scenes.module';
import { WizardGuideService } from '../wizard-guide/wizard-guide.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';

/**
 * VoiceModule — spoken product description → text via Gemini audio
 * (doc/PRODUCT-PROJECT-SPEC.md §6.2; Stage 5). Reuses GEMINI_API_KEY and
 * the Blob presigned-upload flow; no new secret, no new dependency.
 *
 * С этапа K2 ТЗ Greeting 2.0 — и голосовая реплика в мастере
 * поздравления (`GreetingVoiceController`). Провайдер распознавания —
 * настройка админки: Gemini (звук внутри запроса, `inlineData`) или
 * Soniox (`SonioxSttClient`: файл у провайдера удаляется сразу после
 * расшифровки). Правило для записи одно на оба пути — Условия, пункт 3.4.
 *
 * С этапа K3 — разбор реплики в поля брифа и команды
 * (`GreetingVoiceUnderstandService`): сессионный маршрут и маршрут брифа
 * до сессии (`ProjectGreetingVoiceController`). Суточный потолок голоса
 * (В-14) — `VoiceBudgetModule`, общий с голосом советника.
 */
@Module({
  // С этапа K5 — модули карточек сессии: голос проверяет значения против
  // ТЕХ ЖЕ представлений, что они отдают экрану.
  imports: [
    StorageModule,
    VoiceBudgetModule,
    GreetingVoiceModule,
    GreetingMusicModule,
    GreetingCardsModule,
    GreetingStickerModule,
    GreetingScenesModule,
  ],
  controllers: [
    VoiceController,
    GreetingVoiceController,
    ProjectGreetingVoiceController,
  ],
  providers: [
    VoiceService,
    VoiceTranscriptionService,
    GreetingVoiceService,
    GreetingVoiceUnderstandService,
    SonioxSttClient,
    // Выключатель советника (аудит волны K, B2) — тот же
    // `WizardGuideService.available()`, что у подсказок и их озвучки.
    // Провайдером, а не импортом `WizardGuideModule`: нужен один читающий
    // метод, а модуль советника тянет контроллер и синтез.
    WizardGuideService,
    PlatformSettingsService,
  ],
  exports: [SonioxSttClient],
})
export class VoiceModule {}
