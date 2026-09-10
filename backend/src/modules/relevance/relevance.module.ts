import { Module } from '@nestjs/common';
import { RelevanceController } from './relevance.controller';
import { RelevanceService } from './relevance.service';

/** Reference ↔ product audience match (spec §18.3). */
@Module({
  controllers: [RelevanceController],
  providers: [RelevanceService],
  exports: [RelevanceService],
})
export class RelevanceModule {}
