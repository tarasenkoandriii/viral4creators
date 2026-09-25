import { Module } from '@nestjs/common';
import { LegalModule } from '../legal/legal.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { GeminiFilesService } from './gemini-files.service';
import { AnalysisPreviewsService } from './analysis-previews.service';
import { AnalysisSelectionService } from './analysis-selection.service';
import { SceneTemplateService } from './scene-template.service';
import { StorageModule } from '../storage/storage.module';
import { LibraryModule } from '../library/library.module';

/**
 * AnalysisModule
 *
 * Handles video analysis operations using Google Gemini AI.
 * Provides endpoints for triggering analysis, checking status,
 * and updating user-edited analysis results.
 */
@Module({
  imports: [StorageModule, LibraryModule, LegalModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    GeminiFilesService,
    AnalysisPreviewsService,
    AnalysisSelectionService,
    SceneTemplateService,
  ],
  exports: [AnalysisService],
})
export class AnalysisModule {}
