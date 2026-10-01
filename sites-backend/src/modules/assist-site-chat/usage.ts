/**
 * Учёт расходов виджета в site_ai_usage — W3 (ТЗ §7.3, §6.6: с siteId, без
 * текста). Под ролью assist_public — только INSERT (createMany без RETURNING).
 *
 * Операции Э2: `assist-chat` (ответ посетителю), `assist-classify` (перевод
 * вопроса, §4-тер.10; lite-модели в прайсе пока нет — О-4), эмбеддинг
 * вопроса — `assist-query-embed` (Э1). Все три — в общем списке
 * `SITE_AI_OPERATIONS` (site-ai/operations.ts).
 */
import type { SiteAiOperation } from '../site-ai/operations';
import type { AiUsageRecorder, UsageDb } from '../site-ai/usage-recorder';
import type { UsageUnits } from '../../shared/ai-pricing';

/** Конвейер пишет assist-chat/assist-classify/assist-query-embed; проверка персоны — assist-eval. */
export type SiteChatOperation = SiteAiOperation;

export async function recordSiteChatUsage(
  recorder: AiUsageRecorder,
  db: UsageDb,
  e: {
    accountId: string;
    siteId: string;
    operation: SiteChatOperation;
    model: string;
    units: UsageUnits;
  },
): Promise<number> {
  if (!e.model) return 0;
  const r = await recorder.record(db, e);
  return r.costMicroUsd;
}

/** site_ai_usage под assist_public: только createMany. */
export function insertOnlyUsageDb(db: UsageDb): UsageDb {
  return {
    siteAiUsage: { createMany: (args) => db.siteAiUsage.createMany(args) },
  };
}
