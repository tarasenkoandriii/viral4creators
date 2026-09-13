import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { GenerationService } from './generation.service';
import { GenerateVideoRequestDto } from './dto/generate-video-request.dto';
import { GenerateVideoResponseDto } from './dto/generate-video-response.dto';
import { GetVideoStatusResponseDto } from './dto/get-video-status-response.dto';
import { v4 as uuidv4 } from 'uuid';
import { estimateCost } from '../../common/ai-pricing';
import { VIDEO_DURATION_SECONDS } from '../../common/veo-duration';
import {
  buildExtensionPlan,
  chainCostMicroUsd,
} from '../../common/video-extension-plan';
import { loadConfiguration } from '../../config/configuration';
import { VideoQuality } from '../../common/types/generation.types';

/**
 * GenerationController handles video generation endpoints
 */
@Controller('sessions/:sessionId')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  /**
   * POST /sessions/:sessionId/generate
   * Generate video using Google Veo 3.1 with the approved prompt and
   * product image. Body: { quality?: 'fast' | 'standard', aspectRatio?:
   * 'W:H' } — quality defaults to 'fast', aspectRatio to the reference
   * video's frame (spec §16).
   */
  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  async generateVideo(
    @Param('sessionId') sessionId: string,
    @Body() dto: GenerateVideoRequestDto,
  ): Promise<GenerateVideoResponseDto> {
    const generatedVideo = await this.generationService.generateVideo(
      sessionId,
      dto.quality,
      dto.aspectRatio,
      dto.provider,
      dto.resolution,
      dto.targetDurationSeconds,
      dto.avoidText,
    );

    return {
      success: true,
      data: generatedVideo,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: `req_${uuidv4()}`,
      },
    };
  }

  /**
   * GET /sessions/:sessionId/generate
   * Get video generation status and download URL when complete
   */
  @Get('generate')
  async getVideoStatus(
    @Param('sessionId') sessionId: string,
  ): Promise<GetVideoStatusResponseDto> {
    const generatedVideo =
      await this.generationService.getVideoStatus(sessionId);

    return {
      success: true,
      data: generatedVideo,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: `req_${uuidv4()}`,
      },
    };
  }

  /**
   * GET /sessions/:sessionId/generate/estimate
   * Доп. запрос владельца продукта: расчёт цены заранее, при выборе
   * провайдера/качества/разрешения — до кнопки «Сгенерировать», не
   * после (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §11.3). Чистый расчёт
   * по `common/ai-pricing.ts`, сессия не нужна и не трогается — маршрут
   * вложен в `/sessions/:sessionId` только для единообразия с
   * остальными маршрутами генерации, не из-за зависимости от сессии.
   */
  @Get('generate/estimate')
  async getCostEstimate(
    @Param('sessionId') sessionId: string,
    @Query('provider') provider?: 'veo' | 'grok',
    @Query('quality') quality?: VideoQuality,
    @Query('resolution') resolution?: '480p' | '720p' | '1080p',
    @Query('targetDurationSeconds') targetDurationSeconds?: string,
  ): Promise<{
    costUsd: number;
    unpriced: boolean;
    pricingVersion: string;
    segments: number;
    targetDurationSeconds: number;
    wasCapped: boolean;
  }> {
    // §15 ТЗ: reference-to-video (сессии с персонажами бренда)
    // ограничен 720p у Grok — если пользователь выбрал 1080p, реальная
    // генерация тихо понизит его сама (`GrokVideoService`), и
    // дисклеймер должен показать ту же, реальную цену, а не 1080p.
    const effectiveResolution =
      provider === 'grok' &&
      resolution === '1080p' &&
      (await this.generationService.isReferenceMode(sessionId))
        ? '720p'
        : resolution;
    const model =
      provider === 'grok'
        ? `${loadConfiguration().grok.videoModel}:${effectiveResolution ?? '480p'}`
        : await this.generationService.pickVeoModelForSession(
            sessionId,
            quality ?? 'fast',
          );
    const perCallEstimate = estimateCost(model, {
      seconds: VIDEO_DURATION_SECONDS,
    });

    // Доп. запрос владельца продукта (ТЗ §9.4, этап 4 плана §14) —
    // ролик длиннее 8 секунд: дисклеймер должен показать цену ВСЕЙ
    // цепочки, не одного вызова, тем же расчётом, что и реальная
    // проверка бюджета в `generateVideo()` — одна формула, не две.
    const requested = targetDurationSeconds
      ? parseInt(targetDurationSeconds, 10)
      : undefined;
    if (requested && requested > VIDEO_DURATION_SECONDS) {
      const referenceDurationSeconds = (
        await this.generationService.getReferenceDurationSeconds(sessionId)
      ).referenceDurationSeconds;
      const plan = buildExtensionPlan(
        provider ?? 'veo',
        requested,
        referenceDurationSeconds,
      );
      return {
        costUsd:
          chainCostMicroUsd(plan, perCallEstimate.costMicroUsd) / 1_000_000,
        unpriced: perCallEstimate.unpriced,
        pricingVersion: perCallEstimate.pricingVersion,
        segments: plan.totalCalls,
        targetDurationSeconds: plan.targetDurationSeconds,
        wasCapped: plan.wasCapped,
      };
    }

    return {
      costUsd: perCallEstimate.costMicroUsd / 1_000_000,
      unpriced: perCallEstimate.unpriced,
      pricingVersion: perCallEstimate.pricingVersion,
      segments: 1,
      targetDurationSeconds: VIDEO_DURATION_SECONDS,
      wasCapped: false,
    };
  }
}
