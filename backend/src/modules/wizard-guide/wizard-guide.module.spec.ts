/**
 * Граф зависимостей модуля собирается — «Тонкая красная линия», аудит
 * волны C.
 *
 * Обычные спеки конструируют сервисы руками и поэтому НЕ видят, что
 * провайдер забыт в модуле или что новому параметру конструктора неоткуда
 * взяться: такая ошибка всплывает только при старте приложения, то есть
 * на проде. Волна C добавила в модуль пять сервисов и две зависимости
 * между ними — цена одной забытой строки здесь равна упавшему деплою.
 *
 * Глобальные сервисы (`PrismaService`, учёт расхода, режимы) подменены
 * пустышками: поднимать базу ради проверки графа незачем, а сам граф от
 * подмены не меняется.
 */

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { WizardGuideModule } from './wizard-guide.module';
import { WizardGuideService } from './wizard-guide.service';
import { WizardHintService } from './wizard-hint.service';
import { WizardTelemetryService } from './wizard-telemetry.service';
import { ExperienceService } from './experience.service';
import { AdminExperienceService } from './admin-experience.service';
import { AdminWizardGuideService } from './admin-wizard-guide.service';
import { SiblingsService } from './siblings.service';
import { TranslationService } from './translation.service';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: AiUsageService, useValue: {} },
    { provide: PlanService, useValue: {} },
  ],
  exports: [PrismaService, AiUsageService, PlanService],
})
class GlobalStubsModule {}

describe('WizardGuideModule', () => {
  it('поднимается целиком и отдаёт все свои сервисы', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, WizardGuideModule],
    }).compile();

    for (const token of [
      WizardGuideService,
      WizardHintService,
      WizardTelemetryService,
      ExperienceService,
      AdminExperienceService,
      AdminWizardGuideService,
      SiblingsService,
      TranslationService,
    ]) {
      expect(moduleRef.get(token, { strict: false })).toBeDefined();
    }
    await moduleRef.close();
  });
});
