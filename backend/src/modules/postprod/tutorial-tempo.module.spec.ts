/**
 * Граф зависимостей модуля темпа обучалок собирается (06.10.2026):
 * спеки сервиса конструируют его руками и забытого провайдера или
 * импорта не видят — такая ошибка всплыла бы только при старте функции.
 * Глобальные сервисы подменены пустышками, как в `voice.module.spec.ts`.
 */
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { FfmpegApiService } from './ffmpeg-api.service';
import { TutorialTempoModule } from './tutorial-tempo.module';
import { TutorialVideoVersionsService } from './tutorial-video-versions.service';
import { TutorialVideosController } from './tutorial-videos.controller';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AiUsageService, useValue: {} },
    { provide: PlanService, useValue: {} },
    { provide: TtsProviderResolverService, useValue: {} },
    // Глобальный `PostProductionModule` на проде.
    { provide: FfmpegApiService, useValue: {} },
  ],
  exports: [
    PrismaService,
    AiUsageService,
    PlanService,
    TtsProviderResolverService,
    FfmpegApiService,
  ],
})
class GlobalStubsModule {}

describe('TutorialTempoModule', () => {
  it('поднимается целиком: сервис версий и пользовательский контроллер', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, TutorialTempoModule],
    }).compile();
    expect(moduleRef.get(TutorialVideoVersionsService)).toBeDefined();
    expect(moduleRef.get(TutorialVideosController)).toBeDefined();
  });
});
