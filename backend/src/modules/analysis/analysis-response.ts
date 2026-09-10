/**
 * Parsing of Gemini's analysis answer — pulled out of AnalysisService so
 * the fragile part (a model's "JSON" that may come wrapped in markdown,
 * with a string OR an array for sceneBreakdown, with or without the
 * characters key) is a pure function with tests.
 *
 * Spec §10: the prompt now asks for a second key, `characters`. Anything
 * malformed there degrades to "no characters" while sceneBreakdown keeps
 * exactly the behaviour it had before this field existed.
 */

import {
  AnalysisCharacter,
  AnalysisExtra,
  AnalysisScene,
  CharacterProminence,
} from '../../common/types/analysis.types';
import {
  AudienceProfile,
  PromotedProduct,
} from '../../common/types/audience.types';
import { normaliseAspectRatio } from '../../common/aspect-ratio';

export const MAX_CHARACTERS = 10;
export const MAX_SCENES = 12;
export const MAX_EXTRAS = 6;
const MAX_LABEL = 80;
const MAX_TEXT = 600;
const MAX_INTERESTS = 8;

const PROMINENCE: ReadonlySet<string> = new Set([
  'main',
  'secondary',
  'background',
]);

export interface ParsedAnalysis {
  sceneBreakdown: string;
  /** undefined when the answer carried no usable `characters` key at all. */
  characters: AnalysisCharacter[] | undefined;
  /** Normalised "W:H" of the source picture (spec §16), null when absent/garbage. */
  frame: string | null;
  /** Structured scene list (Stage 23); undefined when absent/malformed. */
  scenes: AnalysisScene[] | undefined;
  /** Background crowd (§19); undefined when absent/malformed. */
  extras: AnalysisExtra[] | undefined;
  /** Audience of the reference (§18.2); undefined when absent. */
  audience: AudienceProfile | undefined;
  promotedProduct: PromotedProduct | undefined;
}

/** Strip ``` fences and grab the outermost {...} — same tolerance as before. */
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

/**
 * Coerce whatever the model put under `characters` into clean rows.
 * Returns undefined when the key is absent or not an array — callers keep
 * the distinction "no people seen" (empty array) vs "no data".
 */
export function parseCharacters(raw: unknown): AnalysisCharacter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AnalysisCharacter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const appearance = str(o.appearance ?? o.description, MAX_TEXT);
    if (!appearance) continue; // a character we cannot describe is useless to the prompt
    const label =
      str(o.label ?? o.name, MAX_LABEL) || `Персонаж ${out.length + 1}`;
    const roleText = str(o.role, MAX_LABEL);
    const prom = str(o.prominence, 20).toLowerCase();
    out.push({
      id: `c${out.length + 1}`,
      label,
      role: roleText || null,
      appearance,
      prominence: PROMINENCE.has(prom)
        ? (prom as CharacterProminence)
        : 'secondary',
      previewAt: seconds(o.previewAt),
      previewUrl: null,
    });
    if (out.length >= MAX_CHARACTERS) break;
  }
  return out;
}

/** Non-negative finite seconds, or null. Accepts "0:07"-style strings too. */
export function seconds(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    const mmss = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
    const n = Number(t.replace(/s$/, ''));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
  }
  return null;
}

/** Structured scene rows (Stage 23): start/end/title, previewAt defaults to the middle. */
export function parseScenes(raw: unknown): AnalysisScene[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AnalysisScene[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const start = seconds(o.start ?? o.from);
    const end = seconds(o.end ?? o.to);
    if (start === null || end === null || end < start) continue;
    const title =
      str(o.title ?? o.purpose ?? o.summary, MAX_LABEL * 2) ||
      `Сцена ${out.length + 1}`;
    const preview = seconds(o.previewAt);
    out.push({
      id: `s${out.length + 1}`,
      start,
      end,
      title,
      previewAt:
        preview !== null && preview >= start && preview <= end
          ? preview
          : Math.round(((start + end) / 2) * 10) / 10,
      previewUrl: null,
    });
    if (out.length >= MAX_SCENES) break;
  }
  return out;
}

/** Background crowd rows (§19): label + description, previewAt optional. */
export function parseExtras(raw: unknown): AnalysisExtra[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AnalysisExtra[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const description = str(o.description ?? o.appearance, MAX_TEXT);
    const label = str(o.label ?? o.name, MAX_LABEL);
    if (!description && !label) continue;
    out.push({
      id: `e${out.length + 1}`,
      label: label || `Массовка ${out.length + 1}`,
      description: description || label,
      previewAt: seconds(o.previewAt),
      previewUrl: null,
    });
    if (out.length >= MAX_EXTRAS) break;
  }
  return out;
}

const GENDERS: ReadonlySet<string> = new Set(['women', 'men', 'any']);

/** Audience block → AudienceProfile; undefined when there is nothing usable. */
export function parseAudience(raw: unknown): AudienceProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const ageRange = str(o.ageRange ?? o.age, MAX_LABEL) || null;
  const g = str(o.gender, 20).toLowerCase();
  const gender = GENDERS.has(g)
    ? (g as AudienceProfile['gender'])
    : g === 'female' || g === 'woman'
      ? 'women'
      : g === 'male' || g === 'man'
        ? 'men'
        : g === 'all' || g === 'mixed' || g === 'both'
          ? 'any'
          : null;
  const interests = Array.isArray(o.interests)
    ? o.interests
        .map((x) => str(x, 40))
        .filter(Boolean)
        .slice(0, MAX_INTERESTS)
    : [];
  const summary = str(o.summary ?? o.description, MAX_TEXT) || null;
  if (!ageRange && !gender && interests.length === 0 && !summary) {
    return undefined;
  }
  return { ageRange, gender, interests, summary, source: 'gemini' };
}

export function parsePromotedProduct(
  raw: unknown,
): PromotedProduct | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const category = str(o.category, MAX_LABEL) || null;
  const description = str(o.description, MAX_TEXT) || null;
  const priceTier = str(o.priceTier, 20).toLowerCase() || null;
  if (!category && !description) return undefined;
  return { category, description, priceTier };
}

/** `frame` → normalised ratio; orientation alone is enough for a default. */
export function parseFrame(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ratio = normaliseAspectRatio(
    typeof o.aspectRatio === 'string' ? o.aspectRatio : null,
  );
  if (ratio) return ratio;
  const orientation = str(o.orientation, 20).toLowerCase();
  if (orientation === 'vertical' || orientation === 'portrait') return '9:16';
  if (orientation === 'horizontal' || orientation === 'landscape')
    return '16:9';
  if (orientation === 'square') return '1:1';
  return null;
}

export function parseAnalysisResponse(responseText: string): ParsedAnalysis {
  const json = extractJson(responseText);
  if (!json) {
    // Not JSON at all — the whole text is the breakdown, as before.
    return {
      sceneBreakdown: responseText,
      characters: undefined,
      frame: null,
      scenes: undefined,
      extras: undefined,
      audience: undefined,
      promotedProduct: undefined,
    };
  }
  let sceneBreakdown: string;
  if (Array.isArray(json.sceneBreakdown)) {
    sceneBreakdown = JSON.stringify(json.sceneBreakdown, null, 2);
  } else if (typeof json.sceneBreakdown === 'string') {
    sceneBreakdown = json.sceneBreakdown;
  } else {
    // Unknown shape — keep the cleaned JSON text so nothing is lost.
    sceneBreakdown = responseText.replace(/```json\n?|```\n?/g, '').trim();
  }
  return {
    sceneBreakdown,
    characters: parseCharacters(json.characters),
    frame: parseFrame(json.frame),
    scenes: parseScenes(json.scenes),
    extras: parseExtras(json.extras),
    audience: parseAudience(json.audience),
    promotedProduct: parsePromotedProduct(json.promotedProduct),
  };
}
