import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import {
  UserVoicesController,
  UserVoicesWebhookController,
} from './user-voices.controller';
import { UserVoicesService } from './user-voices.service';

/**
 * UserVoicesModule — клонирование голоса пользователем (этап 73, TODO
 * п.32). `PrismaService`/`PlanService`/`ResembleService` доступны без
 * явного импорта — `PrismaModule`/`PlanModule`/`TtsModule` все
 * `@Global()`; `StorageModule`/`AiUsageModule` — за `BlobService`/
 * `AiUsageService`, тем же приёмом, что `ActorsModule`.
 */
@Module({
  imports: [StorageModule, AiUsageModule],
  controllers: [UserVoicesController, UserVoicesWebhookController],
  providers: [UserVoicesService],
})
export class UserVoicesModule {}
