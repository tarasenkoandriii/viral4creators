/**
 * Эмбеддинги Gemini — K2 (ТЗ помощника §4.3): `gemini-embedding-001`,
 * 768 измерений (MRL, `outputDimensionality`), taskType RETRIEVAL_DOCUMENT
 * для фрагментов и RETRIEVAL_QUERY для вопроса; батчами по
 * KNOWLEDGE_DEFAULTS.embedBatchSize; ключ — shared/gemini-client
 * (GEMINI_API_KEY | GOOGLE_GEMINI_API_KEY). Векторы 768 нормализуются
 * (L2) — у укороченных MRL-векторов норма не 1, а косинусная мера HNSW и
 * точный перебор должны видеть одну и ту же геометрию.
 *
 * Деньги: вызывающий сам решает, из какого бюджета (обучения или
 * песочницы) и пишет AiUsageRecorder. Токены: Gemini API (не Vertex)
 * в ответе эмбеддинга их НЕ отдаёт (`statistics.tokenCount` — только
 * Vertex), поэтому — оценка `estimateEmbedTokens` (символы / 4, с
 * поправкой на кириллицу). Это ОЦЕНКА: при сверке со счётом Google
 * расхождение в пределах десятков процентов ожидаемо.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import { createGeminiClient } from '../../shared/gemini-client';

export type EmbedTask = 'document' | 'query';

export interface EmbedResult {
  vectors: number[][];
  inputTokens: number;
  model: string;
}

/**
 * Транспорт до провайдера — один батч (≤ embedBatchSize текстов). Тесты и
 * песочница без ключа подменяют его провайдером `EMBED_TRANSPORT`; из env
 * не выбирается никогда.
 */
export type EmbedTransport = (req: {
  model: string;
  texts: string[];
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  dimensions: number;
}) => Promise<{ vectors: number[][]; inputTokens?: number }>;

export const EMBED_TRANSPORT = Symbol('EMBED_TRANSPORT');

/** Провайдер не дал вектор нужной формы — ошибка, а не тихая порча индекса. */
export class EmbeddingShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingShapeError';
  }
}

/**
 * Оценка токенов эмбеддинга без вызова провайдера: латиница ≈ 4 символа
 * на токен, кириллица — ≈ 2.5 (токенизатор Gemini режет её мельче).
 */
export function estimateEmbedTokens(text: string): number {
  let cyr = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0400 && c <= 0x04ff) cyr++;
  }
  const other = text.length - cyr;
  return Math.max(1, Math.ceil(other / 4 + cyr / 2.5));
}

/** L2-нормализация; нулевой вектор — ошибка (косинус от него не определён). */
export function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) {
      throw new EmbeddingShapeError('Вектор с нечисловым значением');
    }
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new EmbeddingShapeError('Нулевой вектор эмбеддинга');
  return v.map((x) => x / norm);
}

/** Настоящий транспорт: @google/genai, batchEmbedContents под капотом. */
export function geminiEmbedTransport(): EmbedTransport {
  let client: ReturnType<typeof createGeminiClient> | null = null;
  return async ({ model, texts, taskType, dimensions }) => {
    client ??= createGeminiClient();
    // Массив строк SDK превращает в ОТДЕЛЬНЫЕ contents (по одному на
    // текст) — проверено по tContentsForEmbed в @google/genai 1.52.
    const res = await client.models.embedContent({
      model,
      contents: texts,
      config: { taskType, outputDimensionality: dimensions },
    });
    const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    const tokens = (res.embeddings ?? []).reduce(
      (s, e) => s + (e.statistics?.tokenCount ?? 0),
      0,
    );
    return { vectors, inputTokens: tokens > 0 ? tokens : undefined };
  };
}

@Injectable()
export class GeminiEmbedder {
  private readonly transport: EmbedTransport;

  constructor(@Optional() @Inject(EMBED_TRANSPORT) transport?: EmbedTransport) {
    this.transport = transport ?? geminiEmbedTransport();
  }

  async embed(texts: string[], task: EmbedTask): Promise<EmbedResult> {
    const model = KNOWLEDGE_DEFAULTS.embedModel;
    const dims = KNOWLEDGE_DEFAULTS.embedDimensions;
    const batch = KNOWLEDGE_DEFAULTS.embedBatchSize;
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (let i = 0; i < texts.length; i += batch) {
      const part = texts.slice(i, i + batch);
      const res = await this.transport({
        model,
        texts: part,
        taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        dimensions: dims,
      });
      if (res.vectors.length !== part.length) {
        throw new EmbeddingShapeError(
          `Провайдер вернул ${res.vectors.length} векторов на ${part.length} текстов`,
        );
      }
      for (const v of res.vectors) {
        if (v.length !== dims) {
          throw new EmbeddingShapeError(
            `Размерность вектора ${v.length}, ожидалась ${dims}`,
          );
        }
        vectors.push(l2normalize(v));
      }
      inputTokens +=
        res.inputTokens ?? part.reduce((s, t) => s + estimateEmbedTokens(t), 0);
    }
    return { vectors, inputTokens, model };
  }
}

/** pgvector-литерал `[0.1,0.2,…]` для сырого SQL (`$1::"extensions"."vector"`). */
export function toVectorLiteral(v: number[]): string {
  if (!Array.isArray(v) || v.length === 0) {
    throw new EmbeddingShapeError('Пустой вектор');
  }
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new EmbeddingShapeError('Вектор с нечисловым значением');
    }
  }
  return `[${v.join(',')}]`;
}
