import { Module } from '@nestjs/common';
import { GreetingBriefController } from './greeting-brief.controller';
import { GreetingBriefService } from './greeting-brief.service';

/**
 * GreetingBriefModule — GET/PATCH /projects/:id/greeting-brief (ТЗ
 * TZ-Greeting-Video-Project-Type.md §8). PrismaService/PlanService come
 * from the global PrismaModule/PlanModule (app.module.ts), nothing to
 * import here — same convention as ProjectModule.
 */
@Module({
  controllers: [GreetingBriefController],
  providers: [GreetingBriefService],
  exports: [GreetingBriefService],
})
export class GreetingBriefModule {}
