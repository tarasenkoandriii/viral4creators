/**
 *   POST /projects/:projectId/catalog-batch                  запустить партию
 *   GET  /projects/:projectId/catalog-batch/:batchId          статус партии
 *   POST /projects/:projectId/catalog-batch/:batchId/retry    повторить FAILED-строки (Д-1.3, этап 74)
 *
 * За TelegramIdentityGuard, как и весь остальной каталог (ProjectController,
 * ProjectSessionController) — партия принадлежит владельцу проекта.
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
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  CatalogBatchService,
  CatalogBatchStatusView,
  StartCatalogBatchResult,
} from './catalog-batch.service';
import { StartCatalogBatchRequestDto } from './dto/start-catalog-batch.dto';
import { RetryCatalogBatchRequestDto } from './dto/retry-catalog-batch.dto';

@Controller('projects/:projectId/catalog-batch')
@UseGuards(TelegramIdentityGuard)
export class CatalogBatchController {
  constructor(private readonly service: CatalogBatchService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: StartCatalogBatchRequestDto,
  ): Promise<StartCatalogBatchResult> {
    return this.service.create(req.telegramUserId, projectId, dto);
  }

  @Get(':batchId')
  status(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('batchId') batchId: string,
  ): Promise<CatalogBatchStatusView> {
    return this.service.getStatus(req.telegramUserId, projectId, batchId);
  }

  @Post(':batchId/retry')
  retry(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('batchId') batchId: string,
    @Body() dto: RetryCatalogBatchRequestDto,
  ): Promise<{ retried: number; skippedBusy: string[] }> {
    return this.service.retry(
      req.telegramUserId,
      projectId,
      batchId,
      dto.productItemId,
    );
  }
}
