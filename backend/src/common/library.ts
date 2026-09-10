/**
 * Analysis library — pure helpers (doc/PRODUCT-PROJECT-SPEC.md §21,
 * Stage 24). Two jobs, one table:
 *  - CACHE: the same reference is never analysed twice. The key is the
 *    source itself — `yt:<videoId>` for a link, `sha256:<hex>` for an
 *    uploaded file — so two users who pick the same viral video share one
 *    Gemini call.
 *  - RECOMMENDATIONS: a third way to pick a scenario, next to YouTube
 *    search and a file — ranked by how close the stored analysis is to
 *    THIS product's audience and category.
 *
 * The stored analyses are the service's own intellectual property (see
 * doc/legal/terms-of-use.md §4) — that is what makes a shared library
 * legitimate; this file only computes keys and scores.
 */

import { VideoAnalysis } from './types/analysis.types';
import { AudienceProfile } from './types/audience.types';
import { OriginalVideo, VideoSourceType } from './types/video.types';

/** youtu.be/<id>, /watch?v=<id>, /shorts/<id>, /embed/<id> → the 11-char id. */
export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/** Library key of a YouTube reference; null when the URL is not recognisable. */
export function youtubeSourceKey(url: string): string | null {
  const id = youtubeVideoId(url);
  return id ? `yt:${id}` : null;
}

export function uploadSourceKey(sha256: string): string {
  return `sha256:${sha256}`;
}

/** Key of whatever the session holds, when it can be computed without the bytes. */
export function sourceKeyOf(video: OriginalVideo | undefined): string | null {
  if (!video) return null;
  return video.sourceType === VideoSourceType.YOUTUBE
    ? youtubeSourceKey(video.youtubeUrl)
    : null; // uploads need the file hash — computed at analysis time
}

/** Denormalised columns of a library row, derived from the analysis. */
export interface LibraryFacets {
  category: string | null;
  audienceGender: string | null;
  audienceAgeRange: string | null;
  audienceInterests: string[];
  sceneCount: number;
  characterCount: number;
  title: string | null;
  thumbnailUrl: string | null;
}

export function libraryFacets(analysis: VideoAnalysis): LibraryFacets {
  const scenes = analysis.scenes ?? [];
  return {
    category: analysis.promotedProduct?.category ?? null,
    audienceGender: analysis.audience?.gender ?? null,
    audienceAgeRange: analysis.audience?.ageRange ?? null,
    audienceInterests: analysis.audience?.interests ?? [],
    sceneCount: scenes.length,
    characterCount: (analysis.characters ?? []).length,
    title: scenes[0]?.title ?? null,
    thumbnailUrl: scenes.find((s) => s.previewUrl)?.previewUrl ?? null,
  };
}

// ── Ranking ────────────────────────────────────────────────────────────

export interface RecommendationInput {
  category: string | null;
  audience: AudienceProfile | null | undefined;
}

export interface RankableEntry {
  category: string | null;
  audienceGender: string | null;
  audienceAgeRange: string | null;
  audienceInterests: string[];
  usageCount: number;
}

/**
 * "25-34" → [25, 34]; "45+" → [45, 99]; "18-24 и 25-34" → [18, 34] (the
 * whole span the user wrote); junk → null. Ranges are compared by OVERLAP,
 * not by their first number: "18-24" and "25-34" are adjacent brackets,
 * not a near match.
 */
export function ageBounds(
  range: string | null | undefined,
): [number, number] | null {
  if (!range) return null;
  const nums = (range.match(/\d{1,2}/g) ?? [])
    .map(Number)
    .filter(Number.isFinite);
  if (nums.length === 0) return null;
  const lo = Math.min(...nums);
  const hi = range.includes('+') ? 99 : Math.max(...nums);
  return [lo, Math.max(lo, hi)];
}

/** First number of a range — kept for display/sorting. */
export function ageStart(range: string | null | undefined): number | null {
  return ageBounds(range)?.[0] ?? null;
}

/** Years of overlap between two ranges (negative = the gap between them). */
export function ageOverlap(a: [number, number], b: [number, number]): number {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * 0–100, deliberately simple and explainable (the UI shows `reasons`):
 * category 40, gender 20, age proximity 20, shared interests 15, a small
 * popularity nudge 5. No AI call — this is a shortlist, the relevance
 * check (§18.3) still runs once a reference is chosen.
 */
export function scoreEntry(
  entry: RankableEntry,
  input: RecommendationInput,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const cat = input.category ? norm(input.category) : null;
  const entryCat = entry.category ? norm(entry.category) : null;
  if (cat && entryCat) {
    if (cat === entryCat) {
      score += 40;
      reasons.push(`та же категория — «${entry.category}»`);
    } else if (cat.includes(entryCat) || entryCat.includes(cat)) {
      score += 25;
      reasons.push(`близкая категория — «${entry.category}»`);
    }
  }

  const gender = input.audience?.gender ?? null;
  if (gender && entry.audienceGender) {
    if (gender === entry.audienceGender) {
      score += 20;
      reasons.push('совпадает пол аудитории');
    } else if (gender === 'any' || entry.audienceGender === 'any') {
      score += 10;
      reasons.push('аудитория ролика без привязки к полу');
    }
  }

  const a = ageBounds(input.audience?.ageRange);
  const b = ageBounds(entry.audienceAgeRange);
  if (a && b) {
    const overlap = ageOverlap(a, b);
    const span = Math.min(a[1] - a[0], b[1] - b[0]) || 1;
    if (overlap >= span * 0.6) {
      score += 20;
      reasons.push(`тот же возраст — ${entry.audienceAgeRange}`);
    } else if (overlap > 0) {
      score += 12;
      reasons.push(`близкий возраст — ${entry.audienceAgeRange}`);
    }
  }

  const mine = new Set((input.audience?.interests ?? []).map(norm));
  const shared = entry.audienceInterests.filter((i) => mine.has(norm(i)));
  if (shared.length > 0) {
    score += Math.min(15, shared.length * 8);
    reasons.push(`общие интересы: ${shared.join(', ')}`);
  }

  if (entry.usageCount > 0) {
    score += Math.min(5, entry.usageCount);
    reasons.push(`уже использован ${entry.usageCount} раз(а)`);
  }

  return { score: Math.min(100, score), reasons };
}
