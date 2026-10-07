/**
 * Отметка «младше 18» режима «Я в кадре» глазами оператора (В-4 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`: отказ при
 * `ageMin < 18`, апелляция — через поддержку, без загрузки документов).
 *
 * До этого контроллера снять ошибочную отметку можно было только правкой
 * строки в базе. Защита — та же, что у соседних `/api/admin/*`:
 * `AdminSessionGuard` (нет admin-cookie — 401) и `assertOperator` (не
 * оператор — 403) ДО обращения к сервису.
 *
 * Снятие не включает режим: человек заново даёт согласие и проходит
 * автопроверку, и всё это — под рубильником `PERSONA_ENABLED`
 * (`PersonaService.clearAgeMark`).
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import {
  PersonaAgeStateView,
  PersonaService,
  PERSONA_AGE_CLEAR_REASON_MAX,
  PERSONA_AGE_CLEAR_REASON_MIN,
} from './persona.service';

/** Причина обязательна: она — журнал снятия (кто, когда, почему). */
export class ClearPersonaAgeDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(PERSONA_AGE_CLEAR_REASON_MIN)
  @MaxLength(PERSONA_AGE_CLEAR_REASON_MAX)
  reason!: string;
}

@Controller('admin/users/:id/persona-age')
@UseGuards(AdminSessionGuard)
export class PersonaAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly personas: PersonaService,
  ) {}

  /** Стоит ли отметка, когда и почему поставлена, журнал снятий. */
  @Get()
  @Header('Cache-Control', 'no-store')
  async state(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') userId: string,
  ): Promise<PersonaAgeStateView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.personas.ageMarkState(userId);
  }

  /** Снять отметку (с обязательной причиной) — в ответе новое состояние. */
  @Post('clear')
  async clear(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') userId: string,
    @Body() dto: ClearPersonaAgeDto,
  ): Promise<PersonaAgeStateView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.personas.clearAgeMark(userId, req.userId, dto.reason);
  }
}
