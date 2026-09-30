import { Module } from '@nestjs/common';
import { VoiceBudgetService } from './voice-budget.service';

@Module({
  providers: [VoiceBudgetService],
  exports: [VoiceBudgetService],
})
export class VoiceBudgetModule {}
