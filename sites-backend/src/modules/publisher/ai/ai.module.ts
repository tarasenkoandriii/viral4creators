import { Module } from '@nestjs/common';
import { SiteAiModule } from '../../site-ai/site-ai.module';
import { AI_GATEWAY, AI_TASKS_PORT } from '../core/ports';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { AiCallsReapJob } from './ai-calls-reap.job';
import { AiCallsRunJob } from './ai-calls-run.job';
import { PublisherAiController } from './ai.controller';
import { AiGatewayService } from './ai-gateway.service';
import { AiMonthOpenJob } from './ai-month.job';
import { AiTasksService } from './ai-tasks.service';
import { AiConfigsService } from './configs.service';
import { EvalReviewService } from './eval/eval-review.service';

/**
 * AI Publisher — зона P-B2 (проектный документ §2, §12, §16.4): AI-шлюз
 * (порт `AI_GATEWAY`), девять генераторов (четыре допущены в P0), журнал
 * `pub_ai_calls`, задачи и третья генерация, потолок AI месяца, конфигурации
 * и привязки, разбор набора 30 задач в кабинете eval-продукта; задания
 * `ai-calls-run` (minute, очередь вызовов), `ai-calls-reap` (tick) и
 * `ai-month-open` (tick).
 *
 * `CliEvalGateway` (режим прогона набора `evalRun`) здесь НЕ
 * регистрируется: он есть только у CLI `ai/eval/run.ts` (§12.1, аудит
 * P3-12; тест `ai-eval-fake.spec`).
 */
@Module({
  imports: [PublisherCoreModule, SiteAiModule],
  controllers: [PublisherAiController],
  providers: [
    AiGatewayService,
    { provide: AI_GATEWAY, useExisting: AiGatewayService },
    AiTasksService,
    { provide: AI_TASKS_PORT, useExisting: AiTasksService },
    AiConfigsService,
    EvalReviewService,
    AiCallsRunJob,
    AiCallsReapJob,
    AiMonthOpenJob,
  ],
  exports: [AiGatewayService, AI_GATEWAY, AI_TASKS_PORT],
})
export class PublisherAiModule {}
