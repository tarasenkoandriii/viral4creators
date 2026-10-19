/**
 * AI Publisher — eval-продукт в ОДНОРАЗОВОЙ базе (workflow
 * `.github/workflows/publisher-ai-eval.yml`, Р-IA-FXB-3): кабинет, сайт и
 * продукт `kind=eval` построителями TD (`publisher/testing`), затем
 * синтетика S1–S7 (`seedEvalFixtures`). Печатает id продукта в stdout.
 *
 *   SITES_DATABASE_URL=postgresql://…@localhost:5432/sites \
 *     npx ts-node src/modules/publisher/ai/eval/testing/ci-eval-product.ts
 *
 * Только локальная база (хост localhost/127.0.0.1/::1): построители TD
 * создают кабинет и участника — рабочей базе они не нужны; живой прогон
 * в рабочей базе — по-прежнему владельцем через CLI (§12.6).
 */
/* eslint-disable no-console */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  PrismaService,
  SITES_DB_SCHEMA,
} from '../../../../../prisma/prisma.service';
import { SitesDb } from '../../../../../prisma/sites-db.service';
import { seedAccount, seedProduct } from '../../../testing/fixtures.testing';
import { seedEvalFixtures } from './synthetic-seed';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Отказ для нелокальной базы (защита от запуска против рабочей). */
export function assertDisposableDb(url: string): void {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `ci-eval-product: только локальная одноразовая база (хост ${host} не localhost)`,
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.SITES_DATABASE_URL ?? process.env.SITES_DIRECT_URL;
  if (!url) throw new Error('Нужна SITES_DATABASE_URL');
  assertDisposableDb(url);
  const u = new URL(url);
  u.searchParams.delete('schema');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(u.toString(), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
  try {
    const acc = await seedAccount(prisma);
    const p = await seedProduct(prisma, {
      accountId: acc.accountId,
      kind: 'eval',
      name: 'Eval-продукт CI (набір AI)',
    });
    const r = await seedEvalFixtures(new SitesDb(prisma), p);
    console.error(`eval-продукт ${p.id}: синтетика создано ${r.created}`);
    console.log(p.id);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error((e as Error)?.message ?? e);
    process.exit(1);
  });
}
