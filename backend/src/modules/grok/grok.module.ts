import { Module } from '@nestjs/common';
import { GrokBatchService } from './grok-batch.service';

/**
 * GrokModule — клиент xAI Batch API (ТЗ §35.1). Потребитель —
 * `BlogTranslationService` (модуль `blog`, этап 57), который импортирует
 * `GrokModule` за экспортированным `GrokBatchService`.
 */
@Module({
  providers: [GrokBatchService],
  exports: [GrokBatchService],
})
export class GrokModule {}
