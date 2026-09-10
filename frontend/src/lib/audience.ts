/**
 * Audience helpers (spec §18) — pure, shared by AudienceCard,
 * AnalysisInsights and RelevancePanel; unit-tested in scripts/audience.test.ts.
 */

import type { AudienceGender, AudienceProfile } from '../types';

/**
 * Подпись пола аудитории — этап 56: раньше была захардкожена по-русски
 * константой, теперь берётся из словаря вызывающего компонента
 * (dict.audience.genderLabels), эта функция только индексирует по ключу.
 */
export function genderLabel(
  gender: AudienceGender,
  t: Record<AudienceGender, string>
): string {
  return t[gender];
}

export function audienceIsEmpty(
  a: AudienceProfile | null | undefined
): boolean {
  return (
    !a || (!a.ageRange && !a.gender && a.interests.length === 0 && !a.summary)
  );
}

/** "0:07" for the timecode badges. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Score band → Tailwind background for the relevance meter. */
export function scoreColor(score: number): string {
  if (score >= 70) return 'bg-emerald-500';
  if (score > 35) return 'bg-amber-500';
  return 'bg-rose-500';
}

/** "бег, ЗОЖ; стиль" → ["бег","ЗОЖ","стиль"], ≤8, trimmed, deduped. */
export function parseInterests(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}
