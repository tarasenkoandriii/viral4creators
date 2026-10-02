/**
 * Привязка черновика обучалки к сайту ИИ-помощника (Э6 помощника, ТЗ
 * §4.11): deep-link из экрана «Видео» TMA помощника открывает визард с
 * `siteId`, визард после первого раунда зовёт `PUT`.
 *
 *   GET /projects/:projectId/site-tutorial/assist-link       → { clientSiteId }
 *   PUT /projects/:projectId/site-tutorial/assist-link       { siteId | null }
 *
 * Под `TelegramIdentityGuard`; владение проектом проверяет сервис (чужой —
 * 404). Отдельный контроллер (не client-site-tutorial.controller.ts): своя
 * зона, без правок раунда.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  ClientSiteMediaService,
  type AssistLinkView,
} from './client-site-media.service';

export class AssistLinkDto {
  /** `null` — отвязать. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  siteId!: string | null;
}

@Controller('projects/:projectId/site-tutorial/assist-link')
@UseGuards(TelegramIdentityGuard)
export class ClientSiteMediaController {
  constructor(private readonly media: ClientSiteMediaService) {}

  @Get()
  get(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<AssistLinkView> {
    return this.media.getLink(req.telegramUserId, projectId);
  }

  @Put()
  set(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: AssistLinkDto,
  ): Promise<AssistLinkView> {
    return this.media.setLink(
      req.telegramUserId,
      projectId,
      dto.siteId ?? null,
    );
  }
}
