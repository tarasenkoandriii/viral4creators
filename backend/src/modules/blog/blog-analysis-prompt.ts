/**
 * Промпт и разбор ответа Gemini для черновика блога (doc/TODO.md §II.3:
 * "автоматический разбор Gemini — чем ролик цепляет"; §II.4: критерии
 * оценки — "крючок в первые секунды, темп, ясность оффера, качество
 * съёмки", те же, что уже применяет сервис для релевантности референсов).
 *
 * Разбор ответа — терпимый разбор в духе `analysis-response.ts`
 * (`extractJson`: снять ```-ограждения, взять внешние {...} скобки,
 * распарсить) — модель Gemini иногда добавляет преамбулу вокруг JSON
 * даже в режиме `responseMimeType: 'application/json'`.
 */

export interface BlogAnalysisPromptInput {
  title: string;
  channelTitle: string;
  category: string;
}

export function buildBlogAnalysisPrompt(
  input: BlogAnalysisPromptInput,
): string {
  return [
    'You are a video-advertising analyst writing for a blog read by people who make short ad/UGC videos.',
    `A trending video was found: title "${input.title}", channel "${input.channelTitle}", niche "${input.category}".`,
    'Score how effective this video is as an ad from 0 (weak) to 100 (excellent) using these criteria: the hook in the first seconds, pacing, clarity of the offer, and production quality.',
    'Then write a short blog post about it in Russian, aimed at someone learning to make similar ads.',
    'Respond with a single JSON object of the exact shape: {"score": number, "scoreReasoning": string, "title": string, "bodyHtml": string}. No other text.',
    '"scoreReasoning" — 1-2 sentences in Russian explaining the score against the four criteria above.',
    '"title" — a catchy Russian blog headline about this video and why it works.',
    '"bodyHtml" — 2-4 short HTML paragraphs (<p> tags only, no outer <html>/<body>) in Russian analyzing what makes the ad effective.',
  ].join('\n');
}

export interface BlogAnalysisResult {
  /** 0–100, зажато в диапазон при разборе — модель иногда выходит за границы. */
  score: number;
  scoreReasoning: string;
  title: string;
  bodyHtml: string;
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
 * Терпимый разбор ответа Gemini. `null` — заголовка/тела нет вообще
 * (модель ответила не по формату) — вызывающий (BlogGenerationService)
 * пропускает кандидата, не заводя пустой/битый черновик.
 */
export function parseBlogAnalysisResponse(
  raw: string,
): BlogAnalysisResult | null {
  const obj = extractJson(raw);
  if (!obj) return null;

  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const bodyHtml = typeof obj.bodyHtml === 'string' ? obj.bodyHtml.trim() : '';
  if (!title || !bodyHtml) return null;

  const rawScore = typeof obj.score === 'number' ? obj.score : 0;
  const score = Math.max(0, Math.min(100, rawScore));
  const scoreReasoning =
    typeof obj.scoreReasoning === 'string' ? obj.scoreReasoning.trim() : '';

  return { score, scoreReasoning, title, bodyHtml };
}
