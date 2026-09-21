import { Module } from '@nestjs/common';
import { GreetingPromptController } from './greeting-prompt.controller';
import { GreetingPromptService } from './greeting-prompt.service';
import { PromptModule } from '../prompt/prompt.module';

/**
 * GreetingPromptModule — POST /sessions/:id/greeting-prompt (ТЗ
 * TZ-Greeting-Video-Project-Type.md §5.1/§5.2). SessionService,
 * AiUsageService and PlanService are global providers, nothing to import.
 *
 * `PromptModule` — добавлен при аудите пайплайна GREETING_VIDEO (находка
 * №2): `GreetingPromptService` реиспользует `PromptService.moderateText()`
 * вместо того чтобы вообще не модерировать текст или дублировать
 * ключевые слова/паттерны в отдельном месте.
 */
@Module({
  imports: [PromptModule],
  controllers: [GreetingPromptController],
  providers: [GreetingPromptService],
  exports: [GreetingPromptService],
})
export class GreetingPromptModule {}
