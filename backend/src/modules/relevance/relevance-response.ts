/**
 * Prompt + parser of the relevance call (spec §18.3) — pure, tested.
 */

import {
  AudienceProfile,
  PromotedProduct,
} from '../../common/types/audience.types';
import { ProductInformation } from '../../common/types/product.types';
import { VideoAnalysis } from '../../common/types/analysis.types';
import {
  RelevanceReport,
  RelevanceVerdict,
} from '../../common/types/relevance.types';

const MAX_LIST = 8;
const MAX_LINE = 300;
const MAX_TEXT = 1200;

function audienceText(a: AudienceProfile | null | undefined): string {
  if (!a) return 'unknown';
  const parts = [
    a.ageRange ? `age ${a.ageRange}` : null,
    a.gender ? `gender: ${a.gender}` : null,
    a.interests.length ? `interests: ${a.interests.join(', ')}` : null,
    a.summary,
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : 'unknown';
}

function promotedText(p: PromotedProduct | undefined): string {
  if (!p) return 'unknown';
  return [
    p.category ? `category: ${p.category}` : 'category: not an ad / unclear',
    p.description,
    p.priceTier ? `price tier: ${p.priceTier}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

/** The text-only prompt. Exported for tests and for the spec appendix. */
export function relevancePrompt(
  product: ProductInformation,
  analysis: VideoAnalysis,
  /**
   * Явное имя языка (этап 59, ТЗ §35.5) — этот отчёт читает ПРОДАВЕЦ, а
   * не покупатель товара (в отличие от `promptAdvice`, которое ЗАТЕМ
   * попадает в бриф Veo-промпта через relevanceBriefText() — намеренно
   * локализованная копия: современные текстовые модели свободно понимают
   * инструкцию на любом языке и всё равно пишут финальный Veo-промпт по-
   * английски, см. doc/PRODUCT-PROJECT-SPEC.md §39). Раньше — "язык
   * описания товара, а если неясно — русский"; тот фолбэк был осмыслен
   * только до появления реального сигнала о языке пользователя. Дефолт
   * ('Russian') сохраняет старое поведение для вызовов без явной локали
   * (существующие тесты этого файла).
   */
  languageName: string = 'Russian',
): string {
  const scenes = (analysis.scenes ?? [])
    .map((s) => `- ${s.start}-${s.end}s: ${s.title}`)
    .join('\n');
  const breakdown = (analysis.userEdits || analysis.sceneBreakdown || '')
    .slice(0, 3000)
    .trim();
  return `You are a performance-marketing strategist. A seller wants to CLONE a viral reference video (same structure, pacing and visual identity) to advertise THEIR product with an AI video model. Judge whether this reference fits the product's audience, and what to bend in the new video's prompt so it lands with the PRODUCT's buyers.

PRODUCT
Name: ${product.productName || 'unknown'}
Category: ${product.category || 'unknown'}
Description: ${(product.productDescription || '').slice(0, 1500) || 'unknown'}
Price: ${product.price != null ? `${product.price} ${product.currency ?? ''}`.trim() : 'unknown'}
Market: ${product.countryCode || 'unknown'}${product.languageCode ? ` (${product.languageCode})` : ''}
Target audience of the product: ${audienceText(product.audience)}

REFERENCE VIDEO
Audience the reference speaks to: ${audienceText(analysis.audience)}
What the reference sells: ${promotedText(analysis.promotedProduct)}
${scenes ? `Scenes:\n${scenes}\n` : ''}Scene breakdown (excerpt):
${breakdown || 'n/a'}

Respond with STRICT JSON only:
{
  "score": 0-100 (100 = perfect fit: same buyers, same category logic, same tone),
  "verdict": "use" | "adapt" | "skip"  — "use" ≥ 70 and no blocking gap, "skip" when the audiences or the category logic are incompatible (≤ 35), otherwise "adapt",
  "summary": "2-3 sentences the seller reads first: the decision and the single biggest reason",
  "reasoning": ["3-6 short bullets explaining HOW you weighed age, gender, interests, price tier, category, tone and format"],
  "matches": ["where reference and product agree — 1-5 bullets"],
  "gaps": ["where they diverge — 1-6 bullets, most important first; empty if none"],
  "adjustments": ["3-6 concrete changes for the cloned video: presenter age/gender/style, setting, props, pacing, wording, price framing — each one actionable"],
  "promptAdvice": "one paragraph, imperative, ready to paste into a video-generation brief: exactly what to change versus the reference so the ad speaks to the product's buyers. Keep what already fits."
}
Write summary, reasoning, matches, gaps, adjustments and promptAdvice in ${languageName}. No markdown, no text outside the JSON.`;
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m[0]);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function list(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim().slice(0, MAX_LINE) : ''))
    .filter(Boolean)
    .slice(0, MAX_LIST);
}

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Score → verdict when the model's own verdict is missing or contradicts the score. */
export function verdictFor(score: number, raw: unknown): RelevanceVerdict {
  const v = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (v === 'use' && score >= 60) return 'use';
  if (v === 'skip' && score <= 45) return 'skip';
  if (v === 'adapt') return 'adapt';
  if (score >= 70) return 'use';
  if (score <= 35) return 'skip';
  return 'adapt';
}

/**
 * Фолбэк, когда модель вернула JSON, но без summary (этап 59) — крайне
 * редкий путь (обычный отказ — не-JSON вовсе, это отдельный throw ниже),
 * но раз уж он локале-зависим, честно на пяти языках, а не только
 * по-русски независимо от того, кто читает.
 */
const NO_SUMMARY_FALLBACK: Readonly<Record<string, string>> = {
  ru: 'Модель не дала резюме.',
  uk: 'Модель не надала резюме.',
  en: 'The model returned no summary.',
  de: 'Das Modell hat keine Zusammenfassung geliefert.',
  es: 'El modelo no devolvió un resumen.',
};

export function parseRelevanceResponse(
  responseText: string,
  meta: { reportId: string; now: Date; inputs: RelevanceReport['inputs'] },
  locale = 'ru',
): RelevanceReport {
  const json = extractJson(responseText);
  if (!json) {
    throw new Error(
      `Relevance model returned non-JSON: ${responseText.slice(0, 120)}`,
    );
  }
  const rawScore = Number(json.score);
  const score = Number.isFinite(rawScore)
    ? Math.min(100, Math.max(0, Math.round(rawScore)))
    : 50;
  return {
    reportId: meta.reportId,
    generatedAt: meta.now.toISOString(),
    score,
    verdict: verdictFor(score, json.verdict),
    summary:
      text(json.summary) ||
      NO_SUMMARY_FALLBACK[locale] ||
      NO_SUMMARY_FALLBACK.ru,
    reasoning: list(json.reasoning),
    matches: list(json.matches),
    gaps: list(json.gaps),
    adjustments: list(json.adjustments),
    promptAdvice: text(json.promptAdvice),
    inputs: meta.inputs,
  };
}

/** AUDIENCE FIT section for the prompt writer (PromptService). */
export function relevanceBriefText(
  state: { report: RelevanceReport | null; useInPrompt: boolean } | undefined,
): string {
  if (!state?.report || !state.useInPrompt) return '';
  const r = state.report;
  if (!r.promptAdvice && r.adjustments.length === 0) return '';
  const lines = [
    `AUDIENCE FIT (the reference was made for a different audience than this product's buyers — fit score ${r.score}/100; keep the reference's structure but apply these changes):`,
  ];
  if (r.promptAdvice) lines.push(r.promptAdvice);
  for (const a of r.adjustments) lines.push(`- ${a}`);
  return lines.join('\n');
}
