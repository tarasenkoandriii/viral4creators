/**
 * Тело POST /projects/:projectId/catalog-batch (ТЗ §44, этап 65).
 * `sourceSessionId` — чья уже одобренная сессия (разбор + промпт + готовый
 * ролик) даёт стиль партии; `productItemIds` — какие ещё товары линейки
 * включить (источник в список не входит — сервис сам это проверяет).
 */

import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';

export class StartCatalogBatchRequestDto {
  @IsString()
  sourceSessionId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  productItemIds!: string[];

  /**
   * Доп. запрос владельца продукта: Grok как провайдер для партии (ТЗ
   * VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11/§13, этап 2 плана §14).
   * Без этого поля партия физически не может стать Grok-партией —
   * найдено при аудите: `CatalogBatchRun.provider` в схеме имеет
   * дефолт `'veo'`, и до этого исправления ничто в API его не
   * переопределяло.
   */
  @IsOptional()
  @IsIn(['veo', 'grok'])
  provider?: 'veo' | 'grok';

  @IsOptional()
  @IsIn(['480p', '720p', '1080p'])
  resolution?: '480p' | '720p' | '1080p';
}
