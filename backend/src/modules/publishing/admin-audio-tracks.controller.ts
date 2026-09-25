/**
 * AdminAudioTracksController — маршруты экрана передачи звуковых
 * дорожек оператору (этап 139, ТЗ TZ-Multilingual-YouTube.md).
 *
 * Живёт в модуле своей фичи и сам импортирует `AdminPanelModule` ради
 * `assertOperator` — одностороннее правило проекта (см. комментарий в
 * `admin-panel.module.ts` и прецеденты `AdminLibraryController`,
 * `admin-generation-retry.controller.ts`). Обратный импорт замкнул бы
 * цикл: `AdminPanelModule` → `PublishingModule` → …
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
import { IsBoolean, IsOptional } from 'class-validator';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { AdminAudioTracksService } from './admin-audio-tracks.service';

/**
 * Булев флаг, а не отдельный маршрут на снятие: оператор ошибается ровно
 * так же, как отмечает, и обратное действие должно быть таким же
 * дешёвым. Пустое тело означает «залито» — это частый случай.
 */
export class AudioTrackUploadedDto {
  @IsOptional()
  @IsBoolean()
  uploaded?: boolean;
}

@Controller('admin/audio-tracks')
@UseGuards(AdminSessionGuard)
export class AdminAudioTracksController {
  constructor(
    private readonly service: AdminAudioTracksService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  /** Дорожки одного ролика — с готовыми файлами и причинами. */
  @Get(':sessionId')
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.list(sessionId);
  }

  /**
   * Собрать ОДНУ дорожку. По одной за запрос: перевод, синтез и
   * постановка задачи ffmpeg — это десятки секунд, и четыре подряд не
   * укладывались в таймаут функции (находка аудита этапа). Экран идёт
   * по списку `toBuild` сам и показывает прогресс.
   */
  @Post(':sessionId/build/:locale')
  async build(
    @Req() req: AdminAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Param('locale') locale: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.buildOne(sessionId, locale);
  }

  /**
   * Отметка «залито в Studio». Именно отметка: API звуковых дорожек у
   * YouTube нет вовсе, проверить машиной нечем.
   */
  @Post('track/:id/uploaded')
  async setUploaded(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AudioTrackUploadedDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.setUploaded(id, dto.uploaded !== false, req.userId);
  }
}
