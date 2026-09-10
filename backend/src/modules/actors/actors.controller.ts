/**
 * ActorsController — ручной запуск пилота говорящего AI-аватара
 * (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §5.3, этап 72).
 *
 * Admin-only, не `/sessions/:sessionId/avatar` — по прямому тексту §5.3
 * документа («доступным только оператору... до результатов нескольких
 * тестовых роликов») и §4.1 («`avatarLipsync` по умолчанию false до
 * конца пилота на всех тарифах»): публичный, плано-гейтед маршрут при
 * признаке, выключенном везде, был бы структурно недостижим через
 * обычные HTTP-вызовы. Решение — тот же приём, что уже применён для
 * настоящего Vercel Cron против admin-запуска: `AdminSessionGuard` +
 * `assertOperator`, вызов сервиса напрямую, минуя `PlanService`
 * (`admin-cron.controller.ts`, этап 69).
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { ActorsService } from './actors.service';
import { GenerateAvatarRequestDto } from './dto/generate-avatar-request.dto';

@Controller('admin/actors')
@UseGuards(AdminSessionGuard)
export class ActorsController {
  constructor(
    private readonly actors: ActorsService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Post(':sessionId/generate')
  @UseGuards(RateLimitGuard)
  // Тот же лимит, что у ручного запуска кронов (admin-cron.controller.ts):
  // самый дорогой платный вызов сервиса, спам-клики не должны
  // превращаться в спам-расход Hedra/Resemble.
  @RateLimit({ name: 'admin-actors-generate', limit: 5, windowSec: 15 })
  async generate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Body() dto: GenerateAvatarRequestDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.actors.generateAvatarVideo(
      sessionId,
      dto.characterIndex,
      dto.prompt,
      dto.aspectRatio,
      dto.resolution,
      dto.subtitles ?? false,
    );
  }

  @Get(':sessionId/status')
  async status(
    @Req() req: AdminAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.actors.getAvatarVideoStatus(sessionId);
  }

  @Get(':sessionId/sound-check')
  async soundCheckState(
    @Req() req: AdminAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.actors.getSoundCheckState(sessionId);
  }

  @Post(':sessionId/sound-check')
  @UseGuards(RateLimitGuard)
  // Платный вызов Gemini (дешевле Hedra/Resemble, но не бесплатный) —
  // тот же приём, что у 'admin-actors-generate' выше.
  @RateLimit({ name: 'admin-actors-sound-check', limit: 5, windowSec: 15 })
  async soundCheck(
    @Req() req: AdminAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.actors.runSoundCheck(sessionId);
  }
}
