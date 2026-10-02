/**
 * Э-С Ш2: перенос данных входа черновиков обучалки из колонок
 * `credentialsEnc`/`cookiesEnc` в хранилище sites-backend (личная запись
 * пользователя, «как было»). Логика и правила — модуль
 * `src/modules/client-site-tutorial/credentials-move.ts`.
 *
 *   cd backend && DATABASE_URL=... SITE_TUTORIAL_TOKEN_KEY=... \
 *     SITES_BACKEND_URL=... SITES_TUTORIAL_HMAC_SECRET=... \
 *     npx ts-node --transpile-only scripts/move-client-site-credentials.ts          # dry-run
 *   … scripts/move-client-site-credentials.ts --apply                               # перенести
 *
 * Перед `--apply` хранилище должно быть настроено на стороне sites-backend
 * (`SITE_CREDENTIALS_KEYS`) — скрипт спрашивает `status` и без него не пишет.
 * Повторный запуск безопасен. Отчёт — счётчики и id черновиков, без секретов.
 * Порядок на проде — doc/DEPLOYMENT.md, раздел «Э-С Ш2».
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PrismaService } from '../src/prisma/prisma.service';
import { SitesInternalClient } from '../src/modules/sites-internal/sites-internal.client';
import { moveClientSiteCredentials } from '../src/modules/client-site-tutorial/credentials-move';
import { DraftSecretsStore } from '../src/modules/client-site-tutorial/draft-secrets-store';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const databaseUrl = process.env.DATABASE_URL;
  const columnKey = process.env.SITE_TUTORIAL_TOKEN_KEY;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан');
  if (!columnKey) {
    throw new Error(
      'SITE_TUTORIAL_TOKEN_KEY не задан — колонки не расшифровать',
    );
  }
  const sites = new SitesInternalClient();
  if (apply) {
    if (!sites.configured()) {
      throw new Error(
        'SITES_BACKEND_URL / SITES_TUTORIAL_HMAC_SECRET не заданы — переносить некуда',
      );
    }
    const st = await sites.credentialsStatus();
    if (!st.configured) {
      throw new Error(
        'хранилище sites-backend не настроено (SITE_CREDENTIALS_KEYS) — перенос не начат',
      );
    }
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg(databaseUrl),
  }) as unknown as PrismaService;
  try {
    const store = new DraftSecretsStore(prisma, sites, () => columnKey, {
      log: () => undefined,
      warn: (m: string) => console.warn(m),
    });
    const report = await moveClientSiteCredentials({
      prisma,
      store,
      columnKey,
      apply,
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!apply) {
      console.log('dry-run: ничего не записано; для переноса — --apply');
    }
    if (report.failed.length || report.unreadable.length) process.exitCode = 1;
  } finally {
    await (prisma as unknown as PrismaClient).$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
