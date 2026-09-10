import {
  Controller,
  Post,
  Get,
  Patch,
  Put,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { UpdateAnalysisRequestDto } from './dto/update-analysis-request.dto';
import { TriggerAnalysisResponseDto } from './dto/trigger-analysis-response.dto';
import { GetAnalysisResponseDto } from './dto/get-analysis-response.dto';
import {
  PreviewConfirmRequestDto,
  PreviewUploadUrlsRequestDto,
} from './dto/analysis-previews.dto';
import {
  AnalysisPreviewsService,
  PreviewUploadTarget,
} from './analysis-previews.service';
import { VideoAnalysis } from '../../common/types/analysis.types';
import {
  AnalysisSelectionService,
  AnalysisSelectionView,
} from './analysis-selection.service';
import { PutAnalysisSelectionRequestDto } from './dto/analysis-selection.dto';
import { v4 as uuidv4 } from 'uuid';

/**
 * AnalysisController
 *
 * Handles HTTP endpoints for video analysis operations
 */
@Controller()
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly previews: AnalysisPreviewsService,
    private readonly selection: AnalysisSelectionService,
  ) {}

  /**
   * POST /sessions/:sessionId/analysis
   * Runs video analysis using Gemini to completion before responding
   * (see AnalysisService.analyzeVideo doc comment for why this is
   * `await`ed rather than fired in the background) — so this returns
   * 200 with the finished result, not 202 for a job still in progress.
   */
  @Post('sessions/:sessionId/analysis')
  @HttpCode(HttpStatus.OK)
  async triggerAnalysis(
    @Param('sessionId') sessionId: string,
  ): Promise<TriggerAnalysisResponseDto> {
    console.log(
      '[AnalysisController] Triggering analysis for session:',
      sessionId,
    );
    const result = await this.analysisService.analyzeVideo(sessionId);
    console.log('[AnalysisController] Analysis triggered, result:', result);

    return {
      success: true,
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
      },
    };
  }

  /**
   * GET /sessions/:sessionId/analysis
   * Retrieve analysis results (for polling)
   */
  @Get('sessions/:sessionId/analysis')
  @HttpCode(HttpStatus.OK)
  async getAnalysis(
    @Param('sessionId') sessionId: string,
  ): Promise<GetAnalysisResponseDto> {
    const analysis = await this.analysisService.getAnalysisStatus(sessionId);

    return {
      success: true,
      data: analysis,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
      },
    };
  }

  /**
   * PATCH /sessions/:sessionId/analysis
   * Update analysis with user edits
   */
  @Patch('sessions/:sessionId/analysis')
  @HttpCode(HttpStatus.OK)
  async updateAnalysis(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateAnalysisRequestDto,
  ): Promise<GetAnalysisResponseDto> {
    const analysis = await this.analysisService.updateAnalysis(
      sessionId,
      dto.editedText,
    );

    return {
      success: true,
      data: analysis,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
      },
    };
  }

  /**
   * POST /sessions/:sessionId/analysis/previews/upload-url — presigned PUTs
   * for the browser-captured preview frames (§18.1). Returned raw: the
   * global ResponseInterceptor wraps it.
   */
  @Post('sessions/:sessionId/analysis/previews/upload-url')
  @HttpCode(HttpStatus.OK)
  previewUploadUrls(
    @Param('sessionId') sessionId: string,
    @Body() dto: PreviewUploadUrlsRequestDto,
  ): Promise<PreviewUploadTarget[]> {
    return this.previews.createUploadUrls(sessionId, dto.keys);
  }

  /** POST /sessions/:sessionId/analysis/previews/confirm → analysis with previewUrl set. */
  @Post('sessions/:sessionId/analysis/previews/confirm')
  @HttpCode(HttpStatus.OK)
  previewConfirm(
    @Param('sessionId') sessionId: string,
    @Body() dto: PreviewConfirmRequestDto,
  ): Promise<VideoAnalysis> {
    return this.previews.confirm(sessionId, dto.items);
  }

  /** GET /sessions/:sessionId/analysis/selection — scenes & extras with keep/drop flags (§19). */
  @Get('sessions/:sessionId/analysis/selection')
  getSelection(
    @Param('sessionId') sessionId: string,
  ): Promise<AnalysisSelectionView> {
    return this.selection.get(sessionId);
  }

  /** PUT /sessions/:sessionId/analysis/selection { droppedScenes, droppedExtras } */
  @Put('sessions/:sessionId/analysis/selection')
  putSelection(
    @Param('sessionId') sessionId: string,
    @Body() dto: PutAnalysisSelectionRequestDto,
  ): Promise<AnalysisSelectionView> {
    return this.selection.put(sessionId, dto);
  }
}
