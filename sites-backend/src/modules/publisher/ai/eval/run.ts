/**
 * AI Publisher — CLI прогона контрольного набора 30 задач (P-B2, проектный
 * документ §12.6; `npm run eval:publisher`, скрипт добавил P-A0):
 *
 *   cd sites-backend
 *   # CI/механика (без ключа, допустима отдельная база):
 *   SITES_DATABASE_URL=… npm run eval:publisher -- --mode=fake --product=<evalProductId> --seed
 *   # живой прогон — ОТДЕЛЬНО владельцем, рабочая база, eval-продукт:
 *   GEMINI_API_KEY=… SITES_DATABASE_URL=… npm run eval:publisher -- --mode=live \
 *     --product=<evalProductId> --max-usd=2 [--config=<configHash>] [--model=<id>] \
 *     [--only=AI-01,AI-05] [--run=<runId> — повторы в тот же прогон] \
 *     [--out=protocol.md] [--json=protocol.json] \
 *     [--allow-unpriced — модель без ставки: потолок по наибольшим ставкам]
 *
 * Прогон пишет `pub_ai_eval_runs/results` и `pub_ai_calls` (операция
 * `pub-eval`) под eval-продуктом; первый ответ сохраняется. Оценку
 * (`criticalPass/usefulnessPass`) и разбор флагов ставит человек в кабинете
 * eval-продукта; конфигурация `passed` — решение владельца по ЖИВОМУ
 * прогону (fake не может, триггер). Код выхода 0 — прогон записан
 * (прохождение порога решает человек), 1 — ошибка.
 *
 * Флаг `evalRun` существует только здесь (через `CliEvalGateway`), HTTP
 * его не получает.
 */
/* eslint-disable no-console */
import { writeFileSync } from 'fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  PrismaService,
  SITES_DB_SCHEMA,
} from '../../../../prisma/prisma.service';
import { SitesDb } from '../../../../prisma/sites-db.service';
import { GEMINI_MODEL } from '../../../../shared/gemini-model';
import { GeminiText } from '../../../site-ai/text-model';
import { AiUsageRecorder } from '../../../site-ai/usage-recorder';
import { AuditService } from '../../core/audit';
import { AI_PROVIDER } from '../gateway-core';
import {
  CliEvalGateway,
  FAKE_MODEL,
  FAKE_PROVIDER,
  FakeEvalModel,
} from './cli-gateway';
import { protocolMarkdown } from './protocol';
import { seedEvalFixtures } from './testing/synthetic-seed';

export interface CliArgs {
  mode: 'fake' | 'live';
  product: string;
  config?: string;
  only?: string[];
  maxUsd?: number;
  model?: string;
  run?: string;
  seed: boolean;
  allowUnpriced: boolean;
  out?: string;
  json?: string;
}

/** Разбор аргументов (`--key=value`, `--seed`). */
export function parseArgs(argv: readonly string[]): CliArgs {
  const get = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const mode = get('mode');
  if (mode !== 'fake' && mode !== 'live') {
    throw new Error('--mode=fake|live обязателен');
  }
  const product = get('product');
  if (!product) throw new Error('--product=<id eval-продукта> обязателен');
  const maxRaw = get('max-usd');
  const maxUsd = maxRaw === undefined ? undefined : Number(maxRaw);
  if (maxUsd !== undefined && !(Number.isFinite(maxUsd) && maxUsd > 0)) {
    throw new Error('--max-usd — положительное число');
  }
  if (mode === 'live' && maxUsd === undefined) {
    throw new Error(
      'Живой прогон — только с лимитом стоимости --max-usd (§12.6)',
    );
  }
  const only = get('only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    mode,
    product,
    config: get('config'),
    only,
    maxUsd,
    model: get('model'),
    run: get('run'),
    seed: argv.includes('--seed'),
    allowUnpriced: argv.includes('--allow-unpriced'),
    out: get('out'),
    json: get('json'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SITES_DATABASE_URL ?? process.env.SITES_DIRECT_URL;
  if (!url) throw new Error('Нужна SITES_DATABASE_URL (или SITES_DIRECT_URL)');
  if (
    args.mode === 'live' &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_GEMINI_API_KEY
  ) {
    throw new Error('Живой прогон — нужен GEMINI_API_KEY');
  }
  const u = new URL(url);
  u.searchParams.delete('schema');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(u.toString(), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
  try {
    const db = new SitesDb(prisma);
    const fake = args.mode === 'fake';
    const gw = new CliEvalGateway(db, {
      usage: new AiUsageRecorder(),
      audit: new AuditService(),
      model: fake ? new FakeEvalModel() : new GeminiText(),
      provider: fake ? FAKE_PROVIDER : AI_PROVIDER,
      modelName: fake ? FAKE_MODEL : (args.model ?? GEMINI_MODEL),
      fake,
    });
    const product = await gw.evalProduct(args.product);
    if (args.seed) {
      const r = await seedEvalFixtures(db, product);
      console.error(`Синтетика S1–S7: создано ${r.created}`);
    }
    const cfg = await gw.ensureConfig(product);
    if (args.config && args.config !== cfg.configHash) {
      throw new Error(
        `Код соответствует конфигурации ${cfg.configHash}, а не ${args.config}: модель или версии инструкций отличаются`,
      );
    }
    const protocol = await gw.run(product, args.mode, {
      only: args.only,
      maxUsd: args.maxUsd,
      runId: args.run,
      allowUnpriced: args.allowUnpriced,
    });
    const md = protocolMarkdown(protocol);
    if (args.out) writeFileSync(args.out, md);
    else console.log(md);
    if (args.json) writeFileSync(args.json, JSON.stringify(protocol, null, 2));
    console.error(
      `Прогон ${protocol.run.id} (${args.mode}): задач ${protocol.totals.tasks}, жёстких провалов ${protocol.totals.hardFailed}, флагов ${protocol.totals.flagged}; оценка человека — в кабинете eval-продукта`,
    );
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
