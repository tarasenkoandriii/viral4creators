/**
 * Разбор результатов пачки xAI Grok (ТЗ §35.1) применительно к переводам
 * статьи блога — чистая функция, отделённая от Prisma нарочно: то, что
 * `GrokBatchService.getBatchResults` возвращает СЫРОЙ текст ответа
 * модели по каждому `batchRequestId`, разбор которого — ответственность
 * вызывающего (см. комментарий в grok-batch.service.ts), и здесь эта
 * ответственность реализована как чистая функция, а не метод сервиса —
 * тот же приём, что `parseBlogAnalysisResponse`/`analysis-response.ts`.
 */
import {
  ArticleTranslationPromptInput,
  buildArticleTranslationPrompt,
} from '../grok/grok-translation-prompt';
import { GrokBatchRequestItem } from '../grok/grok-batch.service';

export interface PendingTranslationRow {
  /** BlogPostTranslation.id — используется как batchRequestId в пачке. */
  id: string;
  locale: string;
  title: string;
  bodyHtml: string;
}

/** Собирает элементы пачки xAI из ожидающих переводов одной статьи. */
export function buildTranslationBatchItems(
  rows: readonly PendingTranslationRow[],
  model: string,
): GrokBatchRequestItem[] {
  return rows.map((row) => {
    const promptInput: ArticleTranslationPromptInput = {
      targetLocale: row.locale,
      title: row.title,
      bodyHtml: row.bodyHtml,
    };
    return {
      batchRequestId: row.id,
      model,
      messages: [
        { role: 'user', content: buildArticleTranslationPrompt(promptInput) },
      ],
      responseFormat: { type: 'json_object' },
    };
  });
}

export interface AppliedTranslationResult {
  translationId: string;
  outcome: 'ready' | 'failed';
  title?: string;
  bodyHtml?: string;
  errorMessage?: string;
}

/** Снять ```-ограждения, взять внешние {...}, распарсить — как analysis-response.ts. */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Раскладывает сырые результаты пачки (`batchRequestId → текст ответа`)
 * по ожидавшим переводам. Перевод, для которого готовый батч не принёс
 * результат (`num_error` у xAI — см. grok-batch.service.ts), получает
 * `outcome: 'failed'`, а не тихо остаётся как есть: следующий прогон
 * крона обязан либо повторить его в новой пачке, либо оператор должен
 * увидеть, что перевод не удался, а не решить, что он просто "ещё не
 * готов".
 */
export function applyTranslationBatchResults(
  pending: readonly PendingTranslationRow[],
  rawResultsByRequestId: Readonly<Record<string, string>>,
): AppliedTranslationResult[] {
  return pending.map((row) => {
    const raw = rawResultsByRequestId[row.id];
    if (!raw) {
      return {
        translationId: row.id,
        outcome: 'failed',
        errorMessage: 'xAI не вернул результат для этого запроса пачки',
      };
    }

    const obj = extractJson(raw);
    const title = typeof obj?.title === 'string' ? obj.title.trim() : '';
    const bodyHtml =
      typeof obj?.bodyHtml === 'string' ? obj.bodyHtml.trim() : '';
    if (!title || !bodyHtml) {
      return {
        translationId: row.id,
        outcome: 'failed',
        errorMessage: `ответ xAI не разобрался как {title, bodyHtml}: ${raw.slice(0, 200)}`,
      };
    }

    return { translationId: row.id, outcome: 'ready', title, bodyHtml };
  });
}
