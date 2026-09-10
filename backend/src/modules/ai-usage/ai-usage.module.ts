import { Global, Module } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service';

/**
 * Учёт расходов (ТЗ §26). Global по той же причине, что и PlanModule:
 * записывать расход обязаны все девять мест, где сервис платит деньги, и
 * тащить импорт в каждый модуль ради одного сервиса шумнее, чем объявить
 * его глобальным.
 */
@Global()
@Module({
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}
