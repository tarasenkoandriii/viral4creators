/**
 * Привязка черновика обучалки к сайту ИИ-помощника (Э6 помощника, ТЗ
 * §4.11): deep-link из экрана «Видео» TMA помощника открывает визард с
 * `siteId`, визард после первого раунда зовёт `PUT`.
 *
 *   GET  /projects/:projectId/site-tutorial/assist-link  → AssistLinkState (W7)
 *   POST /projects/:projectId/site-tutorial/assist-link  { siteId | null } → AssistLinkState (W7)
 *   PUT  /projects/:projectId/site-tutorial/assist-link  { siteId | null } → { clientSiteId, siteName }
 *
 * W7: `GET`/`POST` — плашка «привязано к помощнику» и привязка
 * существующего черновика из визарда (`assist-link.service.ts`: только свои
 * сайты с подтверждённым хостом черновика, иначе 409
 * `ASSIST_LINK_UNAVAILABLE`). `PUT` — прежний путь deep-link'а.
 *
 * Под `TelegramIdentityGuard`; владение проектом проверяет сервис (чужой —
 * 404). Отдельный контроллер (не client-site-tutorial.controller.ts): своя
 * зона, без правок раунда.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Matches, ValidateIf } from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { AssistLinkService, type AssistLinkState } from './assist-link.service';
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

/** W7: `siteId` обязателен ключом — строка-id или `null` (отвязать). */
export class AssistLinkPostDto {
  @ValidateIf((o: AssistLinkPostDto) => o.siteId !== null)
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  siteId!: string | null;
}

@Controller('projects/:projectId/site-tutorial/assist-link')
@UseGuards(TelegramIdentityGuard)
export class ClientSiteMediaController {
  constructor(
    private readonly media: ClientSiteMediaService,
    private readonly link: AssistLinkService,
  ) {}

  @Get()
  get(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<AssistLinkState> {
    return this.link.get(req.telegramUserId, projectId);
  }

  @Post()
  @HttpCode(200)
  post(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: AssistLinkPostDto,
  ): Promise<AssistLinkState> {
    return this.link.set(req.telegramUserId, projectId, dto.siteId ?? null);
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
