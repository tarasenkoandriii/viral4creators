/**
 * Очередь модерации обучалок по сайту заказчика — §5.2 (админские
 * эндпоинты) ТЗ, этап 113.
 *
 * Собственный контроллер внутри фиче-модуля, а не добавка в
 * `AdminPanelController` — тот же приём, что у
 * `TutorialScenarioAdminController` рядом: `AdminPanelModule` в
 * обратную сторону не импортируется.
 *
 * `PATCH`, а не `POST`, у одобрения и отклонения — меняется одно поле
 * уже существующей строки, новый ресурс не создаётся (тот же выбор, что
 * у `PATCH /admin/tutorial-scenarios/:id/approve`).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { ClientSiteTutorialAdminService } from './client-site-tutorial-admin.service';
import { DraftStatus } from './draft-rounds';
import { RejectDraftDto } from './dto/client-site-tutorial.dto';

const STATUSES: readonly DraftStatus[] = [
  'DRAFTING',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
];

function parseStatus(raw?: string): DraftStatus | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!STATUSES.includes(value as DraftStatus)) {
    throw new BadRequestException(
      `неизвестный статус «${value}» — ожидался один из: ${STATUSES.join(', ')}`,
    );
  }
  return value as DraftStatus;
}

@Controller('admin/site-tutorial-drafts')
@UseGuards(AdminSessionGuard)
export class ClientSiteTutorialAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly drafts: ClientSiteTutorialAdminService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.drafts.list({
      status: parseStatus(status),
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Get(':id')
  async details(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.drafts.details(id);
  }

  @Patch(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.drafts.approve(id, req.userId);
  }

  @Patch(':id/reject')
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectDraftDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.drafts.reject(id, dto.reason);
  }
}
