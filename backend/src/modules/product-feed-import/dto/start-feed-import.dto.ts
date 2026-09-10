/**
 * Тело POST /projects/:projectId/feed-imports (этап 68, §47).
 * `sourceUrl` — ссылка на YML- или CSV-фид продавца; формат сервис сам
 * определяет по содержимому (см. `common/product-feed.ts`). `http` тоже
 * разрешён (не только `https`) — в отличие от, например, фото манифеста
 * бренда (`update-brand-snapshot.dto.ts`), это не наша инфраструктура, и
 * у части небольших магазинов фид отдаётся без TLS; реальная защита от
 * небезопасного адреса — не схема, а SSRF-guard
 * (`common/external-url-guard.ts`), который проверяется отдельно в
 * сервисе.
 */

import { IsUrl } from 'class-validator';

export class StartFeedImportRequestDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  sourceUrl!: string;
}
