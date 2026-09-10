import { Global, Module } from '@nestjs/common';
import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';

/**
 * Режимы сервиса (ТЗ §23). Global — потому что проверку прав зовут из
 * шести модулей, и таскать импорт в каждый из них ради одного сервиса
 * шумнее, чем объявить его глобальным, как SessionService.
 */
@Global()
@Module({
  controllers: [PlanController],
  providers: [PlanService],
  exports: [PlanService],
})
export class PlanModule {}
