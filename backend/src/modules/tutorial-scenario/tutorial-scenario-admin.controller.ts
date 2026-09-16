/**
 * TutorialScenarioAdminController — тот же приём, что
 * `AssistantAdminController` (см. его доккомментарий): собственный
 * контроллер внутри фиче-модуля, не добавка в `AdminPanelController`,
 * `AdminPanelModule` не импортируется в обратную сторону.
 *
 * Список сценариев и одобрение costly=true (§4.11 ТЗ, этап 94) — часть
 * будущей вкладки «Видео-контент»/«Состояние данных» (§4.9 ТЗ, ещё не
 * реализована на фронтенде админки в этой итерации); эндпоинты уже
 * рабочие и покрыты тестами, UI подключается отдельным заходом.
 */
import {
  BadRequestException,
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
import { TutorialScenarioAdminService } from './tutorial-scenario-admin.service';

function parseBool(v?: string): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

@Controller('admin/tutorial-scenarios')
@UseGuards(AdminSessionGuard)
export class TutorialScenarioAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly scenarioAdmin: TutorialScenarioAdminService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('subjectKey') subjectKey?: string,
    @Query('locale') locale?: string,
    @Query('costly') costly?: string,
    @Query('approved') approved?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.scenarioAdmin.list({
      subjectKey: subjectKey?.trim() || undefined,
      locale: locale?.trim() || undefined,
      costly: parseBool(costly),
      approved: parseBool(approved),
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  // PATCH, не POST — тот же выбор, что PATCH /admin/settings/assistant
  // (`AssistantAdminController`): меняет одно поле уже существующей
  // строки, не создаёт новый ресурс.
  @Patch(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    if (!id) throw new BadRequestException('id обязателен');
    return this.scenarioAdmin.approve(id, req.userId);
  }
}
