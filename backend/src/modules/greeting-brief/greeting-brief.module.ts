import { Module } from '@nestjs/common';
import { GreetingBriefController } from './greeting-brief.controller';
import { GreetingBriefService } from './greeting-brief.service';
import { GreetingPolicyController } from './greeting-policy.controller';
import { GreetingRegisterClassifier } from './greeting-register-classifier.service';

/**
 * GreetingBriefModule — GET/PATCH /projects/:id/greeting-brief (ТЗ
 * TZ-Greeting-Video-Project-Type.md §8). PrismaService/PlanService come
 * from the global PrismaModule/PlanModule (app.module.ts), nothing to
 * import here — same convention as ProjectModule.
 */
@Module({
  controllers: [GreetingBriefController, GreetingPolicyController],
  providers: [GreetingBriefService, GreetingRegisterClassifier],
  // Классификатор нужен и созданию проекта (`ProjectService`), и правке
  // брифа — одна реализация на оба пути.
  exports: [GreetingBriefService, GreetingRegisterClassifier],
})
export class GreetingBriefModule {}
