/**
 * Ротация `ASSIST_SECRETS_KEY` (№60, Р-З10-12): перешифровка строк прежних
 * версий ключа текущим — логика и порядок в `common/secrets-rotation.ts`.
 *
 *   SITES_DIRECT_URL=... ASSIST_SECRETS_KEY=<новый> ASSIST_SECRETS_KEY_VERSION=v2 \
 *     ASSIST_SECRETS_KEYS_OLD='v1:<прежний>' npm run secrets:rotate      # dry-run
 *   … npm run secrets:rotate -- --apply                                  # перешифровать
 *
 * Код выхода 1 — остались строки, которые не открылись (`failed`) или
 * после dry-run есть что перешифровать (удобно для «0 строк старых версий»).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SITES_DB_SCHEMA } from '../../prisma/prisma.service';
import { rotateAssistSecrets, type RotationDb } from '../secrets-rotation';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const raw = process.env.SITES_DIRECT_URL ?? process.env.SITES_DATABASE_URL;
  if (!raw)
    throw new Error('SITES_DIRECT_URL (или SITES_DATABASE_URL) не задан');
  const u = new URL(raw);
  u.searchParams.delete('schema');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(u.toString(), { schema: SITES_DB_SCHEMA }),
  });
  try {
    const report = await rotateAssistSecrets(prisma as unknown as RotationDb, {
      apply,
    });
    console.log(JSON.stringify({ apply, ...report }, null, 2));
    if (!apply)
      console.log('dry-run: ничего не записано; перешифровать — --apply');
    if (report.remaining) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
