import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import {
  EmbeddingShapeError,
  estimateEmbedTokens,
  GeminiEmbedder,
  l2normalize,
  toVectorLiteral,
  type EmbedTransport,
} from './embedder';

const DIMS = KNOWLEDGE_DEFAULTS.embedDimensions;

function transport(
  log: Array<{ n: number; taskType: string; dims: number; model: string }>,
  tokens?: number,
): EmbedTransport {
  return async (req) => {
    log.push({
      n: req.texts.length,
      taskType: req.taskType,
      dims: req.dimensions,
      model: req.model,
    });
    return {
      vectors: req.texts.map((_, i) =>
        Array.from({ length: DIMS }, (_, j) => (j === i % DIMS ? 3 : 0)),
      ),
      inputTokens: tokens,
    };
  };
}

describe('GeminiEmbedder (§4.3)', () => {
  it('батчи по embedBatchSize, 768 измерений, gemini-embedding-001, RETRIEVAL_DOCUMENT', async () => {
    const log: Array<{
      n: number;
      taskType: string;
      dims: number;
      model: string;
    }> = [];
    const e = new GeminiEmbedder(transport(log));
    const texts = Array.from({ length: 250 }, (_, i) => `текст ${i}`);
    const r = await e.embed(texts, 'document');
    expect(log.map((x) => x.n)).toEqual([100, 100, 50]);
    expect(
      log.every((x) => x.taskType === 'RETRIEVAL_DOCUMENT' && x.dims === 768),
    ).toBe(true);
    expect(log[0].model).toBe('gemini-embedding-001');
    expect(r.model).toBe('gemini-embedding-001');
    expect(r.vectors).toHaveLength(250);
    // L2-нормализация: норма 1.
    expect(Math.hypot(...r.vectors[0])).toBeCloseTo(1, 10);
    // Токенов провайдер не дал — оценка по символам.
    expect(r.inputTokens).toBe(
      texts.reduce((s, t) => s + estimateEmbedTokens(t), 0),
    );
  });

  it('вопрос — RETRIEVAL_QUERY; токены провайдера, если он их отдал', async () => {
    const log: Array<{
      n: number;
      taskType: string;
      dims: number;
      model: string;
    }> = [];
    const r = await new GeminiEmbedder(transport(log, 7)).embed(['q'], 'query');
    expect(log[0].taskType).toBe('RETRIEVAL_QUERY');
    expect(r.inputTokens).toBe(7);
  });

  it('не та размерность или число векторов — ошибка, а не порча индекса', async () => {
    const wrongDims = new GeminiEmbedder(async (req) => ({
      vectors: req.texts.map(() => [1, 2, 3]),
    }));
    await expect(wrongDims.embed(['a'], 'document')).rejects.toBeInstanceOf(
      EmbeddingShapeError,
    );
    const wrongCount = new GeminiEmbedder(async () => ({ vectors: [] }));
    await expect(wrongCount.embed(['a'], 'document')).rejects.toBeInstanceOf(
      EmbeddingShapeError,
    );
  });

  it('пустой вход — без вызова провайдера', async () => {
    const log: Array<{
      n: number;
      taskType: string;
      dims: number;
      model: string;
    }> = [];
    const r = await new GeminiEmbedder(transport(log)).embed([], 'document');
    expect(log).toEqual([]);
    expect(r).toEqual({
      vectors: [],
      inputTokens: 0,
      model: 'gemini-embedding-001',
    });
  });

  it('l2normalize / toVectorLiteral отвергают мусор', () => {
    expect(l2normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(() => l2normalize([0, 0])).toThrow(EmbeddingShapeError);
    expect(() => l2normalize([NaN])).toThrow(EmbeddingShapeError);
    expect(toVectorLiteral([0.5, -1, 2e-7])).toBe('[0.5,-1,2e-7]');
    expect(() => toVectorLiteral([])).toThrow(EmbeddingShapeError);
    expect(() => toVectorLiteral([1, Infinity])).toThrow(EmbeddingShapeError);
  });

  it('оценка токенов: кириллица ≈ 2.5 символа, латиница ≈ 4', () => {
    expect(estimateEmbedTokens('a'.repeat(40))).toBe(10);
    expect(estimateEmbedTokens('я'.repeat(25))).toBe(10);
    expect(estimateEmbedTokens('')).toBe(1);
  });
});
