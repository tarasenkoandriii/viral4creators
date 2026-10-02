/**
 * Ротация ключа хранилища учётных данных (Э-С Ш2): перешифровка строк
 * `site_credentials` и `user_site_secrets` старых версий ключа текущей.
 *
 *   SITES_DIRECT_URL=... SITE_CREDENTIALS_KEYS='v1:…,v2:…' \
 *     SITE_CREDENTIALS_KEY_CURRENT=v2 npm run credentials:rotate            # dry-run: сколько строк каких версий
 *   … npm run credentials:rotate -- --apply                                 # перешифровать
 *
 * Порядок: дописать новый ключ в SITE_CREDENTIALS_KEYS и переключить
 * SITE_CREDENTIALS_KEY_CURRENT (в env Vercel и здесь) → задеплоить → этот
 * скрипт с --apply → повторный dry-run показывает 0 строк старых версий →
 * убрать старый ключ из SITE_CREDENTIALS_KEYS. Строки, которые не
 * расшифровываются (`failed`), — повреждены или зашифрованы ключом, которого
 * уже нет: их данные входа придётся ввести заново (удалить учётку/запись).
 * Повторный запуск безопасен; в отчёте только счётчики, без секретов.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SITES_DB_SCHEMA } from '../../../prisma/prisma.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AccountService } from '../../site-core/account/account.service';
import { HostAccessService } from '../../site-core/ownership/host-access.service';
import { CredentialAuditService } from '../credential-audit.service';
import { SiteCredentialsService } from '../site-credentials.service';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const raw = process.env.SITES_DIRECT_URL ?? process.env.SITES_DATABASE_URL;
  if (!raw)
    throw new Error('SITES_DIRECT_URL (или SITES_DATABASE_URL) не задан');
  const u = new URL(raw);
  u.searchParams.delete('schema');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(u.toString(), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
  try {
    const db = new SitesDb(prisma);
    const svc = new SiteCredentialsService(
      db,
      new AccountService(db),
      new HostAccessService(db),
      new CredentialAuditService(db),
    );
    const report = await svc.rotateKeys({ apply });
    console.log(JSON.stringify({ apply, ...report }, null, 2));
    if (!apply)
      console.log('dry-run: ничего не записано; перешифровать — --apply');
    if (report.failed) process.exitCode = 1;
  } finally {
    await (prisma as unknown as PrismaClient).$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
