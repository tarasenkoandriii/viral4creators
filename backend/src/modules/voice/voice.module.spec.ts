/**
 * Граф зависимостей модуля голоса собирается (этап K3). Спеки сервисов
 * конструируют их руками и не видят забытого провайдера или импорта
 * модуля — такая ошибка всплыла бы только при старте приложения. K3
 * добавил сервис разбора, второй контроллер и зависимость от
 * `VoiceBudgetModule`; этот спек держит их вместе.
 *
 * Глобальные сервисы подменены пустышками, как в `wizard-guide.module.spec.ts`.
 */

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { SessionService } from '../../common/session.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { VoiceModule } from './voice.module';
import { GreetingVoiceService } from './greeting-voice.service';
import { GreetingVoiceUnderstandService } from './greeting-voice-understand.service';
import { VoiceBudgetService } from '../voice-budget/voice-budget.service';
import { WizardGuideService } from '../wizard-guide/wizard-guide.service';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AiUsageService, useValue: {} },
    { provide: PlanService, useValue: {} },
    { provide: SessionService, useValue: {} },
    // Глобальный `TtsModule` на проде.
    { provide: PlatformSettingsService, useValue: {} },
    // S2: каталог Soniox для карточки голоса — тоже из глобального TtsModule.
    { provide: TtsProviderResolverService, useValue: {} },
  ],
  exports: [
    PrismaService,
    AiUsageService,
    PlanService,
    SessionService,
    PlatformSettingsService,
    TtsProviderResolverService,
  ],
})
class GlobalStubsModule {}

describe('VoiceModule', () => {
  it('поднимается целиком: распознавание, разбор реплики и потолок голоса', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, VoiceModule],
    }).compile();
    for (const token of [
      GreetingVoiceService,
      GreetingVoiceUnderstandService,
      VoiceBudgetService,
      // Выключатель советника (аудит волны K, B2).
      WizardGuideService,
    ]) {
      expect(moduleRef.get(token, { strict: false })).toBeDefined();
    }
    await moduleRef.close();
  });
});
