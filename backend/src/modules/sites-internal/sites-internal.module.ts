import { Module } from '@nestjs/common';
import { SitesInternalClient } from './sites-internal.client';

/**
 * Клиент внутреннего API sites-backend (Э-С Ш1, П-С3) — HMAC с меткой
 * времени и id запроса, без DSN и ключей `site_*` в генераторе. Первый
 * потребитель — обучалка по сайту заказчика (режим A/B, регистрация хоста).
 */
@Module({
  providers: [SitesInternalClient],
  exports: [SitesInternalClient],
})
export class SitesInternalModule {}
