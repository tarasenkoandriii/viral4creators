/**
 * Прогон инвариантного поднабора (ворота версии, §4-тер.2) — K2. Чистая
 * оркестровка: поиск по ПРОВЕРЯЕМОЙ версии и ответ (AnswerEngine, K3)
 * приходят параметрами — тест подставляет фейки, ворота — настоящие.
 * Любой провал = версия удерживается (порог «любой провал»).
 */
import type { AnswerRequest, AnswerResult } from '../answer/answer-engine';
import type { SearchHit } from '../types';
import { INVARIANT_CASES, type InvariantCase } from './invariant-cases';

export interface InvariantEvalResult {
  passed: number;
  failed: number;
  failures: Array<{ id: string; reason: string }>;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Почему ответ провалил кейс (null — прошёл). */
export function judgeInvariant(
  c: InvariantCase,
  r: Pick<AnswerResult, 'text' | 'refused'>,
): string | null {
  if (c.expectRefusal && !r.refused) return 'нет честного отказа';
  const text = (r.text ?? '').toLowerCase();
  const bad = c.mustNotSay.find((s) => text.includes(s));
  return bad ? `в ответе запрещённое «${bad}»` : null;
}

export async function runInvariantEval(p: {
  search: (question: string) => Promise<SearchHit[]>;
  answer: (req: AnswerRequest) => Promise<AnswerResult>;
  cases?: readonly InvariantCase[];
}): Promise<InvariantEvalResult> {
  const out: InvariantEvalResult = {
    passed: 0,
    failed: 0,
    failures: [],
    model: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  for (const c of p.cases ?? INVARIANT_CASES) {
    const hits = await p.search(c.question);
    const r = await p.answer({ question: c.question, hits });
    out.model = r.model;
    out.inputTokens += r.inputTokens;
    out.cachedInputTokens += r.cachedInputTokens;
    out.outputTokens += r.outputTokens;
    const reason = judgeInvariant(c, r);
    if (reason) {
      out.failed++;
      out.failures.push({ id: c.id, reason });
    } else {
      out.passed++;
    }
  }
  return out;
}
