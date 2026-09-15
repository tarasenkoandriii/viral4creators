/**
 * AssistantAdminController — вкладка «ИИ-консультант» в админке
 * (ТЗ §9/§10). Собственный контроллер внутри `AssistantModule`, не
 * добавка в `AdminPanelController` — тот же приём, что
 * `AdminGenerationRetryController`/`AdminCronController` (см. их
 * доккомментарии): фиче-модуль импортирует `AdminPanelModule` сам,
 * оставляя направление зависимостей однонаправленным.
 */
import {
  Body,
  Controller,
  Get,
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
import { AssistantAdminService } from './assistant-admin.service';
import { SetAssistantSettingsDto } from './dto/set-assistant-settings.dto';

@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AssistantAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly assistantAdmin: AssistantAdminService,
  ) {}

  @Get('settings/assistant')
  async getSettings(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.assistantAdmin.getSettings();
  }

  // PATCH, не PUT — тот же метод, что уже приняли в проекте для
  // редактируемых настроек admin/settings (voiceover-provider,
  // grok-transport, см. их эндпоинты в этом же контроллере семейства):
  // все поля DTO необязательны, частичное обновление, а не замена
  // ресурса целиком.
  @Patch('settings/assistant')
  async setSettings(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetAssistantSettingsDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.assistantAdmin.setSettings(
      {
        enabled: dto.enabled,
        proactiveEnabled: dto.proactiveEnabled,
        dailyBudgetMicroUsd:
          dto.dailyBudgetUsd !== undefined
            ? Math.round(dto.dailyBudgetUsd * 1_000_000)
            : undefined,
        model: dto.model,
      },
      req.userId,
    );
  }

  @Get('assistant')
  async feed(
    @Req() req: AdminAuthenticatedRequest,
    @Query('flagged') flagged?: string,
    @Query('locale') locale?: string,
    @Query('stepId') stepId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('days') days?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    const [feed, aggregates7, aggregates30] = await Promise.all([
      this.assistantAdmin.feed({
        flagged:
          flagged === 'true' ? true : flagged === 'false' ? false : undefined,
        locale: locale?.trim() || undefined,
        stepId: stepId ? parseInt(stepId, 10) || undefined : undefined,
        search: search?.trim() || undefined,
        page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
        pageSize: Math.min(
          Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
          100,
        ),
      }),
      this.assistantAdmin.aggregates(7),
      days === '30'
        ? this.assistantAdmin.aggregates(30)
        : Promise.resolve(null),
    ]);
    return { feed, aggregates7, aggregates30 };
  }
}
