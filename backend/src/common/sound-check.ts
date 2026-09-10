/**
 * Проверка «звучит ли голос как живой человек» — этап 73, по прямому
 * запросу владельца продукта сразу после этапа 72б: «когда Джемини
 * отсматривает она может и делать саундчек отдельным отчётом».
 *
 * Намеренно ОТДЕЛЬНАЯ функция от `modules/video-audit/audit-response.ts`
 * (`auditPrompt`): та проверка ищет ТЕХНИЧЕСКИЕ дефекты генерации
 * (рассинхрон губ, обрыв речи, не тот язык) — вопрос «сломано ли». Этот
 * файл отвечает на другой вопрос — «звучит ли голос по-человечески», ради
 * которого вообще выбирался Resemble вместо ElevenLabs
 * (`doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md` §1: реальная вакансия
 * AI UGC-студии прямо формулирует «не звучать как ElevenLabs, а как
 * реальный человек-блогер»).
 *
 * Файл — в `common/`, а не в `modules/video-audit/`, потому что нужен
 * ОБОИМ пайплайнам: Veo-пути (`VideoAuditService`, обычный пользователь,
 * тарифные гейты) и пилоту аватара (`ActorsService`, admin-only, своего
 * аудита артефактов вообще не существует). Оба сервиса делают свой
 * Gemini-вызов (разная авторизация, разный источник видео) и переиспользуют
 * отсюда только промпт и разбор ответа — тот же приём, что `common/postprod.ts`
 * переиспользуется Veo- и Hedra-путями для похожего, но не идентичного шага.
 */

import { SoundCheck, SoundCheckState } from './types/audit.types';

const MAX_TEXT = 500;
const MAX_NOTE = 200;
const MAX_NOTES = 8;
const MAX_HISTORY = 20;
const VERDICTS: ReadonlySet<string> = new Set([
  'human',
  'synthetic',
  'ambiguous',
]);

const DEFAULT_LANGUAGE = 'Russian';

/**
 * Video-in prompt: только звук, полностью игнорируя картинку — этим и
 * отличается от `auditPrompt`, которая смотрит и слушает вместе.
 */
export function soundCheckPrompt(
  languageName: string = DEFAULT_LANGUAGE,
): string {
  return `You are an audio realism reviewer for AI-generated advertising videos. Your ONLY job is to judge whether the VOICE in the attached video sounds like a real human speaking, or like synthetic text-to-speech (TTS) — completely ignore visual quality, lip-sync accuracy and video artefacts, those are judged elsewhere.

Context: the advertiser specifically needs voices that do NOT sound like a typical AI TTS engine (e.g. ElevenLabs' stock voices are often recognisable as AI) — the bar is "indistinguishable from a real blogger talking".

LISTEN closely to the voice track and look for synthetic tells:
- unnaturally even pitch/rhythm, little natural pitch variation across the sentence;
- pacing that is too mechanically regular, or missing natural pauses/breaths between phrases;
- no audible breathing, lip smacks, or other natural mouth noises;
- overly smooth, "too clean" articulation with no natural imperfections;
- flat or mismatched emotional emphasis relative to the words being said;
- small robotic glitches or artefacts at word boundaries;
- an "announcer" or "voice assistant" cadence instead of casual conversational delivery.

Respond with a valid JSON object only:
{
  "verdict": "human" | "synthetic" | "ambiguous",
  "summary": "one or two plain-language sentences in ${languageName} for a non-technical advertiser",
  "notes": ["specific, actionable observation in ${languageName}", "up to 5 more"]
}
"human" = no synthetic tells, sounds like a real person. "synthetic" = clearly sounds like AI TTS. "ambiguous" = mixed or inconclusive signals. Keep notes short, specific and actionable (e.g. "try a different voice", "the pacing is too even — vary pause length"). Respond with valid JSON only, no other text.`;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
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

/**
 * Фолбэки на случай, когда модель не вернула JSON вовсе — тот же приём и
 * тот же набор языков, что у `audit-response.ts`.
 */
const EMPTY_RESPONSE_FALLBACK: Readonly<Record<string, string>> = {
  ru: 'Пустой ответ модели',
  uk: 'Порожня відповідь моделі',
  en: 'Empty response from the model',
  de: 'Leere Antwort des Modells',
  es: 'Respuesta vacía del modelo',
};

export interface ParsedSoundCheck {
  verdict: SoundCheck['verdict'];
  summary: string;
  notes: string[];
}

/** Unparseable → 'unknown' с сырым текстом как summary, никогда не бросает — тот же контракт, что parseAuditResponse. */
export function parseSoundCheckResponse(
  text: string,
  locale = 'ru',
): ParsedSoundCheck {
  const json = extractJson(text);
  if (!json) {
    return {
      verdict: 'unknown',
      summary:
        text.trim().slice(0, MAX_TEXT) ||
        EMPTY_RESPONSE_FALLBACK[locale] ||
        EMPTY_RESPONSE_FALLBACK.ru,
      notes: [],
    };
  }
  const said = str(json.verdict, 12).toLowerCase();
  const verdict: SoundCheck['verdict'] = VERDICTS.has(said)
    ? (said as SoundCheck['verdict'])
    : 'unknown';
  const notes = Array.isArray(json.notes)
    ? json.notes
        .map((n) => str(n, MAX_NOTE))
        .filter(Boolean)
        .slice(0, MAX_NOTES)
    : [];
  return { verdict, summary: str(json.summary, MAX_TEXT), notes };
}

/** Newest-first, тем же ограничением истории (MAX_HISTORY), что VideoAuditService.append. */
export function appendSoundCheck(
  current: SoundCheckState | undefined,
  check: SoundCheck,
): SoundCheckState {
  return {
    history: [check, ...(current?.history ?? [])].slice(0, MAX_HISTORY),
  };
}
