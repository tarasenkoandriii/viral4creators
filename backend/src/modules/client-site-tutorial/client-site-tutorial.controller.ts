/**
 * Эндпоинты визарда обучалки по сайту заказчика — §5.2 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 111.
 *
 * Под `TelegramIdentityGuard`, как и остальные пользовательские
 * маршруты; владение проектом проверяет сервис (чужой проект отвечает
 * 404, а не 403 — та же конвенция, что у `catalog-batch`).
 *
 * Этап 113 добавил `/undo` и `/finish`; модерация живёт в отдельном
 * админском контроллере (`client-site-tutorial-admin.controller.ts`),
 * как и у штатной обучалки. Этап 114 — живой вход (§7.4): два маршрута
 * вокруг отдельного сервиса-реле, сам видеопоток через backend НЕ
 * идёт.
 *
 * Э-С Ш1: `/access` (режим A/B), `/consent` (подтверждение прав на
 * аккаунт в режиме B, П-Т2), `/verify-site` (завести хост в кабинете
 * сайтов sites-backend).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  ClientSiteTutorialService,
  DraftView,
  LiveLoginStart,
  RoundResult,
} from './client-site-tutorial.service';
import type { SiteAccessView } from './site-access.service';
import { clientIp, rateLimitSubject } from '../../common/rate-limit';
import {
  AccountConsentRequestDto,
  RegisterSiteRequestDto,
  SiteAccessRequestDto,
  CompleteLiveLoginDto,
  ExploreRequestDto,
  FinishRequestDto,
  LoginRequestDto,
  StepRequestDto,
  UndoRequestDto,
} from './dto/client-site-tutorial.dto';

@Controller('projects/:projectId/site-tutorial')
@UseGuards(TelegramIdentityGuard)
export class ClientSiteTutorialController {
  constructor(private readonly service: ClientSiteTutorialService) {}

  @Get()
  getState(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<DraftView | null> {
    return this.service.getState(req.telegramUserId, projectId);
  }

  @Post('explore')
  explore(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: ExploreRequestDto,
  ): Promise<RoundResult> {
    return this.service.explore(req.telegramUserId, projectId, dto.url);
  }

  @Post('step')
  step(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: StepRequestDto,
  ): Promise<RoundResult> {
    return this.service.step(req.telegramUserId, projectId, dto);
  }

  @Post('login')
  login(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: LoginRequestDto,
  ): Promise<RoundResult> {
    return this.service.login(req.telegramUserId, projectId, dto);
  }

  @Post('undo')
  undo(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: UndoRequestDto,
  ): Promise<RoundResult> {
    return this.service.undo(
      req.telegramUserId,
      projectId,
      dto.expectedVersion,
    );
  }

  @Post('finish')
  finish(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: FinishRequestDto,
  ): Promise<DraftView> {
    return this.service.finish(req.telegramUserId, projectId, dto);
  }

  /**
   * Живой вход (§7.4). Старт отдаёт фронтенду всё для ПРЯМОГО
   * соединения с реле: постоянный видеопоток через serverless-функцию
   * не имеет смысла ни по архитектуре, ни по биллингу.
   */
  @Post('live-login/start')
  startLiveLogin(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<LiveLoginStart> {
    return this.service.startLiveLogin(req.telegramUserId, projectId);
  }

  @Post('live-login/complete')
  completeLiveLogin(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: CompleteLiveLoginDto,
  ): Promise<RoundResult> {
    return this.service.completeLiveLogin(req.telegramUserId, projectId, dto);
  }

  /** Свежий снимок текущей страницы — без записи в черновик (§5.2). */
  @Post('refresh')
  refresh(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<RoundResult> {
    return this.service.refresh(req.telegramUserId, projectId);
  }

  @Post('resume')
  resume(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<DraftView> {
    return this.service.resume(req.telegramUserId, projectId);
  }

  /** Э-С Ш1 (П-Т1): режим A/B и состояние подтверждения прав. */
  @Post('access')
  @HttpCode(200)
  access(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: SiteAccessRequestDto,
  ): Promise<SiteAccessView> {
    return this.service.siteAccess(req.telegramUserId, projectId, dto.url);
  }

  /**
   * П-Т2: галочка «аккаунт мой, условия сайта не нарушаю» с версией
   * текста. IP — только HMAC (`rateLimitSubject`), сырой не хранится.
   */
  @Post('consent')
  @HttpCode(200)
  consent(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: AccountConsentRequestDto,
  ): Promise<SiteAccessView> {
    const ip = clientIp(req);
    return this.service.acceptAccountConsent(
      req.telegramUserId,
      projectId,
      { url: dto.url, textVersion: dto.textVersion, locale: dto.locale },
      ip && ip !== 'unknown' ? rateLimitSubject(ip) : null,
    );
  }

  /** Ш1: «Подтвердить сайт» — хост в кабинет сайтов (pending). */
  @Post('verify-site')
  @HttpCode(200)
  verifySite(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: RegisterSiteRequestDto,
  ): Promise<SiteAccessView> {
    return this.service.registerSite(req.telegramUserId, projectId, dto.url);
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    await this.service.remove(req.telegramUserId, projectId);
  }
}
