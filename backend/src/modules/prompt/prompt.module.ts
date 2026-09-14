/**
 * Prompt Module
 *
 * Handles text-to-video prompt generation, editing, and approval.
 */

import { Module } from '@nestjs/common';
import { PromptController } from './prompt.controller';
import { PromptService } from './prompt.service';
import { TextCardController } from './text-card.controller';
import { TextCardService } from './text-card.service';
import { StorageModule } from '../storage/storage.module';

/**
 * PromptModule provides prompt generation and management functionality
 */
@Module({
  imports: [StorageModule],
  controllers: [PromptController, TextCardController],
  providers: [PromptService, TextCardService],
  exports: [PromptService],
})
export class PromptModule {}
