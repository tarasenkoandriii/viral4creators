/**
 * Граф зависимостей модуля проверки качества демо собирается: спеки
 * сервиса конструируют его руками и забытого провайдера или импорта не
 * видят — такая ошибка всплыла бы только при старте функции. Глобальные
 * сервисы подменены пустышками, как в `tutorial-tempo.module.spec.ts`.
 */
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { DemoQualityAdminController } from './demo-quality-admin.controller';
import {
  DemoQualityGemini,
  GoogleDemoQualityGemini,
} from './demo-quality-gemini';
import { TutorialDemoQualityService } from './demo-quality.service';
import { TutorialQualityModule } from './tutorial-quality.module';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AiUsageService, useValue: {} },
  ],
  exports: [PrismaService, AiUsageService],
})
class GlobalStubsModule {}

/** Модуль админки тянет за собой полпроекта; модулю качества от него
 *  нужен только `AdminPanelService.assertOperator`. */
@Module({
  providers: [{ provide: AdminPanelService, useValue: {} }],
  exports: [AdminPanelService],
})
class AdminPanelStubModule {}

describe('TutorialQualityModule', () => {
  const key = process.env.GEMINI_API_KEY;
  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });
  afterAll(() => {
    if (key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = key;
  });

  it('поднимается целиком: сервис, контроллер, настоящий шлюз Gemini', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, TutorialQualityModule],
    })
      .overrideModule(AdminPanelModule)
      .useModule(AdminPanelStubModule)
      .compile();
    expect(moduleRef.get(TutorialDemoQualityService)).toBeDefined();
    expect(moduleRef.get(DemoQualityAdminController)).toBeDefined();
    expect(moduleRef.get(DemoQualityGemini)).toBeInstanceOf(
      GoogleDemoQualityGemini,
    );
  });
});
