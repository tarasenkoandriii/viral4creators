/**
 * Тело POST /projects/:projectId/catalog-batch (ТЗ §44, этап 65).
 * `sourceSessionId` — чья уже одобренная сессия (разбор + промпт + готовый
 * ролик) даёт стиль партии; `productItemIds` — какие ещё товары линейки
 * включить (источник в список не входит — сервис сам это проверяет).
 */

import { ArrayNotEmpty, ArrayUnique, IsArray, IsString } from 'class-validator';

export class StartCatalogBatchRequestDto {
  @IsString()
  sourceSessionId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  productItemIds!: string[];
}
