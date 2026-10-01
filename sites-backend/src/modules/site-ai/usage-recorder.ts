/**
 * Запись расходов ИИ в `site_ai_usage` — K2. Стоимость — estimateCost из
 * shared/ai-pricing (ставка gemini-embedding-001 — в ИСТОЧНИКЕ
 * backend/src/common/ai-pricing.ts, копия — sync). Клиент БД — параметр:
 * публичная песочница пишет под ролью assist_public (GRANT INSERT в Э0),
 * кабинетный код — SitesDb.forAccount (extension тенанта подставит и
 * сверит accountId).
 *
 * Неизвестная модель не бесплатна: строка пишется с `unpriced = true` и
 * нулём денег — объём виден, расхождение с прайсом заметно в отчёте.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { estimateCost, rateFor } from '../../shared/ai-pricing';
import type { UsageUnits } from '../../shared/ai-pricing';
import type { SiteAiOperation } from './operations';

export interface UsageEntry {
  accountId: string | null;
  siteId: string | null;
  operation: SiteAiOperation;
  model: string;
  units: UsageUnits;
}

/**
 * Нужен только `siteAiUsage.createMany`: INSERT без RETURNING — у роли
 * assist_public нет SELECT на site_ai_usage. Подходят и PrismaClient, и клиент
 * под ролью assist_public (AssistPublicDb), и SitesDb.forAccount(…) —
 * у последнего типы extension несовместимы с `Pick<PrismaClient, …>`.
 */
export interface UsageDb {
  siteAiUsage: {
    createMany(args: {
      data: Prisma.SiteAiUsageCreateManyInput[];
    }): PromiseLike<unknown>;
  };
}

/** Неотрицательное целое: мусор от провайдера не должен уронить INSERT. */
function count(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : 0;
}

@Injectable()
export class AiUsageRecorder {
  async record(
    db: UsageDb,
    entry: UsageEntry,
  ): Promise<{ costMicroUsd: number; unpriced: boolean }> {
    const est = estimateCost(entry.model, entry.units);
    await db.siteAiUsage.createMany({
      data: [
        {
          accountId: entry.accountId,
          siteId: entry.siteId,
          // Все операции Э1 — помощника (operations.ts); QA добавит свои.
          product: entry.operation.startsWith('qa-') ? 'qa' : 'assist',
          provider: rateFor(entry.model)?.provider ?? 'GEMINI',
          operation: entry.operation,
          model: entry.model,
          inputTokens: count(entry.units.inputTokens),
          cachedInputTokens: count(entry.units.cachedInputTokens),
          outputTokens: count(entry.units.outputTokens),
          seconds: count(entry.units.seconds),
          calls: count(entry.units.calls) || 1,
          characters: count(entry.units.characters),
          costMicroUsd: est.costMicroUsd,
          pricingVersion: est.pricingVersion,
          unpriced: est.unpriced,
        },
      ],
    });
    return { costMicroUsd: est.costMicroUsd, unpriced: est.unpriced };
  }
}
