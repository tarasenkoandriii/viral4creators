/**
 *   POST /projects/:projectId/ab-test          запустить сборку A/B-вариантов
 *   GET  /projects/:projectId/ab-test/:runId    статус запуска
 *
 * За TelegramIdentityGuard, как и весь остальной каталог (тот же приём,
 * что у CatalogBatchController, этап 65) — запуск принадлежит владельцу
 * проекта.
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
  AbTestService,
  AbTestStatusView,
  StartAbTestResult,
} from './ab-test.service';
import { StartAbTestRequestDto } from './dto/start-ab-test.dto';

@Controller('projects/:projectId/ab-test')
@UseGuards(TelegramIdentityGuard)
export class AbTestController {
  constructor(private readonly service: AbTestService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: StartAbTestRequestDto,
  ): Promise<StartAbTestResult> {
    return this.service.create(req.telegramUserId, projectId, dto);
  }

  @Get(':runId')
  status(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ): Promise<AbTestStatusView> {
    return this.service.getStatus(req.telegramUserId, projectId, runId);
  }
}
