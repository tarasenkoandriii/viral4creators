import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Проверка живости — PrismaService приходит из глобального PrismaModule. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
