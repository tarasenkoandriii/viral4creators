/**
 *   POST /projects/:projectId/feed-imports              запустить импорт
 *   GET  /projects/:projectId/feed-imports               список запусков
 *   GET  /projects/:projectId/feed-imports/:runId         статус запуска
 *
 * Этап 68, §47. За TelegramIdentityGuard, как и весь остальной каталог
 * (ProjectController, CatalogBatchController) — импорт принадлежит
 * владельцу проекта.
 */

import {
  Controller,
  Get,
  Param,
  Body,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  ProductFeedImportService,
  StartFeedImportResult,
  FeedImportStatusView,
  FeedImportRunSummary,
} from './product-feed-import.service';
import { StartFeedImportRequestDto } from './dto/start-feed-import.dto';

@Controller('projects/:projectId/feed-imports')
@UseGuards(TelegramIdentityGuard)
export class ProductFeedImportController {
  constructor(private readonly service: ProductFeedImportService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: StartFeedImportRequestDto,
  ): Promise<StartFeedImportResult> {
    return this.service.create(req.telegramUserId, projectId, dto);
  }

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<FeedImportRunSummary[]> {
    return this.service.list(req.telegramUserId, projectId);
  }

  @Get(':runId')
  status(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ): Promise<FeedImportStatusView> {
    return this.service.getStatus(req.telegramUserId, projectId, runId);
  }
}
