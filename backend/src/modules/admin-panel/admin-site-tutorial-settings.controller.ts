/**
 * «Обучалка по сайту: выключатель и суточные потолки» (П-Т9, заход 7) —
 * свой контроллер, а не ещё один метод `AdminPanelController`: тот
 * собирается в тестах позиционно, и новая зависимость сдвинула бы всё.
 * Защита — та же, что у соседних `/api/admin/settings/*`:
 * `AdminSessionGuard` (нет admin-cookie — 401) и `assertOperator` (не
 * оператор — 403) ДО обращения к настройке.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from './admin-panel.service';
import {
  AdminSiteTutorialSettingsService,
  SetSiteTutorialSettingsInput,
  SITE_TUTORIAL_CAP_MAX,
} from './admin-site-tutorial-settings.service';

/** Не присланное не трогается; `null` у потолка — вернуть умолчание. */
export class SetSiteTutorialSettingsDto {
  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(SITE_TUTORIAL_CAP_MAX)
  roundsPerDay?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(SITE_TUTORIAL_CAP_MAX)
  liveSessionsPerDay?: number | null;
}

@Controller('admin/settings/site-tutorial')
@UseGuards(AdminSessionGuard)
export class AdminSiteTutorialSettingsController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly siteTutorial: AdminSiteTutorialSettingsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.siteTutorial.view();
  }

  @Patch()
  async set(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetSiteTutorialSettingsDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    // Только присланные поля: экземпляр DTO может нести объявленные, но
    // не присланные поля как undefined — их не трогаем.
    const input: SetSiteTutorialSettingsInput = {};
    if (dto.paused !== undefined) input.paused = dto.paused;
    if (dto.roundsPerDay !== undefined) input.roundsPerDay = dto.roundsPerDay;
    if (dto.liveSessionsPerDay !== undefined) {
      input.liveSessionsPerDay = dto.liveSessionsPerDay;
    }
    return this.siteTutorial.set(input, req.userId);
  }
}
