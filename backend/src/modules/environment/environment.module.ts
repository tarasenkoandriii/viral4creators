import { Module } from '@nestjs/common';
import { EnvironmentController } from './environment.controller';
import { EnvironmentService } from './environment.service';

/**
 * Окружение тестировщика (этап 156). `PrismaService` — global-модуль,
 * явный импорт не требуется.
 */
@Module({
  controllers: [EnvironmentController],
  providers: [EnvironmentService],
  exports: [EnvironmentService],
})
export class EnvironmentModule {}
