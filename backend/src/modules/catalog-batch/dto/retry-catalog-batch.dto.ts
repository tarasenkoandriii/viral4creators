/**
 * Тело POST /projects/:projectId/catalog-batch/:batchId/retry (пятый
 * аудит, Д-1.3, этап 74). `productItemId` необязателен — не передан,
 * повторяются ВСЕ провалившиеся строки партии; передан — только одна
 * (точечный повтор одной строки, ради которого этот эндпоинт и заведён).
 */

import { IsOptional, IsString } from 'class-validator';

export class RetryCatalogBatchRequestDto {
  @IsOptional()
  @IsString()
  productItemId?: string;
}
