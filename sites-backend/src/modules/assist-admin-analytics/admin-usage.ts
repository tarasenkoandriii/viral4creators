/**
 * Учёт расходов аналитики «Админки» в `site_ai_usage` (заход 10, №57): та же
 * строка, что пишет `AiUsageRecorder` (site-ai), но с операциями «Админки»
 * `assist-admin-label` / `assist-admin-insight` — признак режима в имени
 * операции, без текста (§5-тер.13, §6.6). Их считает суточный потолок
 * «Админки» (`ADMIN_DAILY_USAGE_OPERATIONS`).
 */
import type { SitesDb } from '../../prisma/sites-db.service';
import { estimateCost, rateFor } from '../../shared/ai-pricing';
import type { TextModelSpent } from '../site-ai/text-model';
import type {
  ADMIN_INSIGHT_OPERATION,
  ADMIN_LABEL_OPERATION,
} from './admin-analytics-env';

const n = (v: number | undefined) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

/** Записать расход вызова; возвращает стоимость (мкр$). */
export async function recordAdminUsage(
  sitesDb: SitesDb,
  env: NodeJS.ProcessEnv,
  p: {
    accountId: string;
    siteId: string;
    operation: typeof ADMIN_LABEL_OPERATION | typeof ADMIN_INSIGHT_OPERATION;
    spent: TextModelSpent;
  },
): Promise<number> {
  const est = estimateCost(
    p.spent.model,
    {
      inputTokens: p.spent.inputTokens,
      cachedInputTokens: p.spent.cachedInputTokens,
      outputTokens: p.spent.outputTokens,
    },
    env,
  );
  await sitesDb.forAccount(p.accountId).siteAiUsage.createMany({
    data: [
      {
        accountId: p.accountId,
        siteId: p.siteId,
        product: 'assist',
        provider: rateFor(p.spent.model, env)?.provider ?? 'GEMINI',
        operation: p.operation,
        model: p.spent.model,
        inputTokens: n(p.spent.inputTokens),
        cachedInputTokens: n(p.spent.cachedInputTokens),
        outputTokens: n(p.spent.outputTokens),
        calls: 1,
        costMicroUsd: est.costMicroUsd,
        pricingVersion: est.pricingVersion,
        unpriced: est.unpriced,
      },
    ],
  });
  return est.costMicroUsd;
}
