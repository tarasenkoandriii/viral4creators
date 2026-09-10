/**
 * Prompts and tolerant parsing for the post-generation audit (spec §11).
 * Pure — no Nest, no network — so the fragile part (a model's JSON) is
 * unit-tested and the service stays thin.
 */

import {
  AuditIssue,
  AuditSeverity,
  PromptFix,
} from '../../common/types/audit.types';

export const MAX_ISSUES = 12;
const MAX_TEXT = 500;
const MAX_PROMPT = 6000;

const SEVERITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/**
 * Явное имя языка (этап 59, ТЗ §35.5) — этот отчёт читает СЕЛЛЕР, чинящий
 * свой ролик, а не аудитория рекламы, поэтому язык — UI-локаль
 * пользователя, а не язык диалога/рынка ролика; `promptFix.suggestedText`
 * ниже — единственное поле, которое остаётся НЕТРОНУТЫМ (тот же язык и
 * формат, что у исходного промпта) именно потому, что оно идёт обратно в
 * Veo, а не читается человеком. Раньше язык был жёстко "Russian" —
 * дефолт сохраняет это поведение для вызовов без явной локали.
 */
const DEFAULT_LANGUAGE = 'Russian';

/** Video-in prompt: find generation artefacts and rewrite the prompt. */
export function auditPrompt(
  currentPrompt: string,
  languageName: string = DEFAULT_LANGUAGE,
): string {
  return `You are a quality inspector for AI-generated short advertising videos (Google Veo output).
Watch the attached ~8-second video carefully, frame by frame where needed, and look ONLY for generation artefacts and defects, for example:
- anatomy: extra or missing limbs, hands with the wrong number of fingers, a "third hand", two left feet, limbs bending impossibly, bodies merging;
- faces: warped, melting or asymmetric faces, eyes looking in different directions, teeth artefacts, identity changing between shots;
- physics/continuity: objects passing through each other, floating, sudden teleports, clothing or product changing shape/colour mid-shot;
- product: the product deformed, duplicated, unreadable or missing where the prompt wanted it;
- text: garbled on-screen text or logos;
- audio: speech that is garbled or unintelligible, a line cut off mid-word, lips clearly out of sync with the voice, speech in the WRONG language for the target market (the prompt states the required language), a voice that changes identity between shots, music drowning the voice-over.
LISTEN to the audio track as carefully as you watch the frames.
Do NOT judge taste, pacing or marketing quality — only defects a viewer would notice as "AI glitches".

The video was generated from this text prompt:
"""
${currentPrompt}
"""

Respond with a valid JSON object only:
{
  "verdict": "clean" | "issues",
  "summary": "one or two sentences in ${languageName} for the user",
  "issues": [
    { "severity": "high" | "medium" | "low", "category": "anatomy" | "face" | "physics" | "product" | "text" | "audio" | "other", "description": "what exactly is wrong, in ${languageName}", "timecode": "0:03" or null }
  ],
  "promptFix": {
    "suggestedText": "the FULL revised prompt in the same language and format as the original, with precise constraints added to prevent the found defects (e.g. 'exactly two hands with five fingers each, hands never overlap the product')",
    "rationale": "one or two sentences in ${languageName}: what was changed and why"
  } or null when verdict is "clean"
}
If you find no defects: verdict "clean", empty issues, promptFix null.`;
}

/** Text-only prompt for a user-reported problem (§11.3): just write the fix. */
export function manualFixPrompt(
  currentPrompt: string,
  issue: string,
  languageName: string = DEFAULT_LANGUAGE,
): string {
  return `You are a prompt engineer for Google Veo 3.1. A user generated a short advertising video from the prompt below and reports this problem with the result:
"""
${issue}
"""

Current prompt:
"""
${currentPrompt}
"""

Rewrite the prompt so the problem is prevented — add precise, concrete constraints where they belong; keep everything else (structure, language, length, dialogue, CTA) unchanged.

Respond with a valid JSON object only:
{
  "summary": "one sentence in ${languageName} restating the problem you addressed",
  "promptFix": {
    "suggestedText": "the FULL revised prompt",
    "rationale": "one or two sentences in ${languageName}: what was changed and why"
  }
}`;
}

export interface ParsedAudit {
  verdict: 'clean' | 'issues' | 'unknown';
  summary: string;
  issues: AuditIssue[];
  promptFix: PromptFix | null;
}

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

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function parseIssues(raw: unknown): AuditIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: AuditIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const description = str(o.description ?? o.issue, MAX_TEXT);
    if (!description) continue;
    const sev = str(o.severity, 10).toLowerCase();
    const timecode = str(o.timecode ?? o.time, 20) || null;
    out.push({
      id: `a${out.length + 1}`,
      severity: SEVERITIES.has(sev) ? (sev as AuditSeverity) : 'medium',
      category: str(o.category, 40).toLowerCase() || 'other',
      description,
      timecode,
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

export function parsePromptFix(raw: unknown): PromptFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const suggestedText = str(o.suggestedText ?? o.prompt ?? o.text, MAX_PROMPT);
  if (!suggestedText) return null;
  return { suggestedText, rationale: str(o.rationale ?? o.reason, MAX_TEXT) };
}

/**
 * Фолбэки на случай, когда модель не вернула JSON вовсе или JSON без
 * summary (этап 59) — редкий путь, но раз локале-зависим, честно на пяти
 * языках, а не по-русски независимо от того, кто читает.
 */
const EMPTY_RESPONSE_FALLBACK: Readonly<Record<string, string>> = {
  ru: 'Пустой ответ модели',
  uk: 'Порожня відповідь моделі',
  en: 'Empty response from the model',
  de: 'Leere Antwort des Modells',
  es: 'Respuesta vacía del modelo',
};
const CLEAN_FALLBACK: Readonly<Record<string, string>> = {
  ru: 'Артефактов не обнаружено',
  uk: 'Артефактів не виявлено',
  en: 'No artefacts found',
  de: 'Keine Artefakte gefunden',
  es: 'No se encontraron artefactos',
};
const ISSUES_FOUND_FALLBACK: Readonly<Record<string, (n: number) => string>> = {
  ru: (n) => `Найдено проблем: ${n}`,
  uk: (n) => `Знайдено проблем: ${n}`,
  en: (n) => `Issues found: ${n}`,
  de: (n) => `Gefundene Probleme: ${n}`,
  es: (n) => `Problemas encontrados: ${n}`,
};

/**
 * Full audit answer. Verdict is derived from the issues when the model's
 * own verdict is missing or contradicts them (issues present → "issues").
 * Unparseable → 'unknown' with the raw text as summary, never a throw.
 * `locale` — только для фолбэков выше; сам текст модели уже пришёл на
 * нужном языке благодаря `languageName` в auditPrompt/manualFixPrompt.
 */
export function parseAuditResponse(text: string, locale = 'ru'): ParsedAudit {
  const json = extractJson(text);
  if (!json) {
    return {
      verdict: 'unknown',
      summary:
        text.trim().slice(0, MAX_TEXT) ||
        EMPTY_RESPONSE_FALLBACK[locale] ||
        EMPTY_RESPONSE_FALLBACK.ru,
      issues: [],
      promptFix: null,
    };
  }
  const issues = parseIssues(json.issues);
  const promptFix = parsePromptFix(json.promptFix);
  const said = str(json.verdict, 10).toLowerCase();
  const verdict: ParsedAudit['verdict'] =
    issues.length > 0
      ? 'issues'
      : said === 'clean'
        ? 'clean'
        : said === 'issues'
          ? 'issues'
          : 'clean';
  const issuesFound = ISSUES_FOUND_FALLBACK[locale] ?? ISSUES_FOUND_FALLBACK.ru;
  return {
    verdict,
    summary:
      str(json.summary, MAX_TEXT) ||
      (verdict === 'clean'
        ? CLEAN_FALLBACK[locale] || CLEAN_FALLBACK.ru
        : issuesFound(issues.length)),
    issues,
    promptFix: verdict === 'clean' ? null : promptFix,
  };
}

/** Answer to manualFixPrompt (§11.3): no verdict logic — the user already judged. */
export function parseManualFixResponse(text: string): {
  summary: string;
  promptFix: PromptFix | null;
} {
  const json = extractJson(text);
  if (!json) return { summary: '', promptFix: null };
  return {
    summary: str(json.summary, MAX_TEXT),
    promptFix: parsePromptFix(json.promptFix),
  };
}
