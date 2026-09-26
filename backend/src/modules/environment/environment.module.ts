import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EnvironmentController } from './environment.controller';
import { EnvironmentService } from './environment.service';
import { TestTicketIntakeController } from './test-ticket-intake.controller';
import { TestTicketIntakeService } from './test-ticket-intake.service';
import { TestingBriefService } from './testing-brief.service';

/**
 * Окружение тестировщика (этап 156) и находки из мини-аппа (этап 160) —
 * один модуль: и то и другое живёт под `me/`, снимается одним и тем же
 * экраном и упирается в одну проверку тестового доступа.
 *
 * `PrismaService` — global-модуль, явный импорт не требуется;
 * `StorageModule` (`BlobService`) — нет, отсюда явный импорт.
 */
@Module({
  imports: [StorageModule],
  controllers: [EnvironmentController, TestTicketIntakeController],
  providers: [EnvironmentService, TestTicketIntakeService, TestingBriefService],
  exports: [EnvironmentService],
})
export class EnvironmentModule {}
