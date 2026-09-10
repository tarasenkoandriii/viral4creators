/**
 * Тело POST /projects/:projectId/ab-test (TODO §III.6, этап 66).
 * `sourceSessionId` — чья уже одобренная сессия (разбор + промпт + готовый
 * ролик) становится образцом для 3 A/B-вариантов. Число вариантов не
 * передаётся — решение владельца продукта: всегда фиксировано 3.
 */

import { IsString } from 'class-validator';

export class StartAbTestRequestDto {
  @IsString()
  sourceSessionId!: string;
}
