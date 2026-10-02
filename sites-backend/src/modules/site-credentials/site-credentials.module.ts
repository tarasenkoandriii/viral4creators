/**
 * Тестовые учётные записи сайта и хранилище их секретов (Э-С Ш2) — общее
 * ядро обучалки генератора и QA, как `site-core`.
 *
 * Граф (scripts/check-sites-import-graph.mjs): модуль берёт из модулей
 * только `site-core` и `telegram-auth` (`site-credentials-scope`), а его
 * импортируют только `internal-sites` (канал генератора) и будущие `qa-*`
 * (`credentials-zone`); шифрование (`credential-crypto.ts`) не импортирует
 * никто вне модуля. Помощник и публичный виджет к секретам дороги не имеют
 * ни импортом, ни ролью БД (assist_public прав на эти таблицы не получает).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { CredentialAuditService } from './credential-audit.service';
import { SiteCredentialsRetentionController } from './site-credentials-retention.controller';
import { SiteTestAccountsController } from './site-credentials.controller';
import { SiteCredentialsService } from './site-credentials.service';

@Module({
  imports: [SiteCoreModule],
  controllers: [SiteTestAccountsController, SiteCredentialsRetentionController],
  providers: [SiteCredentialsService, CredentialAuditService],
  exports: [SiteCredentialsService],
})
export class SiteCredentialsModule {}
