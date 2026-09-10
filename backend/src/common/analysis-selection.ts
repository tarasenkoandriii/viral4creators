/**
 * Scenes & extras keep/drop (doc/PRODUCT-PROJECT-SPEC.md §19, Stage 24) —
 * the pure half: what the effective selection is and how it reads in the
 * prompt-writer's brief. Mirrors what reference-plan.ts does for
 * characters, deliberately simpler: a scene or a crowd is either in or out.
 */

import { AnalysisSelection, VideoAnalysis } from './types/analysis.types';

export interface SceneSelectionRow {
  id: string;
  start: number;
  end: number;
  title: string;
  active: boolean;
}

export interface ExtraSelectionRow {
  id: string;
  label: string;
  description: string;
  active: boolean;
}

/** Ids the current analysis actually has — unknown ids in a PUT are a client bug. */
export function selectableIds(analysis: VideoAnalysis | undefined): {
  scenes: Set<string>;
  extras: Set<string>;
} {
  return {
    scenes: new Set((analysis?.scenes ?? []).map((s) => s.id)),
    extras: new Set((analysis?.extras ?? []).map((e) => e.id)),
  };
}

/** Selection resolved against the analysis: every row with its active flag. */
export function resolveSelection(
  analysis: VideoAnalysis | undefined,
  selection: AnalysisSelection | undefined,
): { scenes: SceneSelectionRow[]; extras: ExtraSelectionRow[] } {
  const droppedScenes = new Set(selection?.droppedScenes ?? []);
  const droppedExtras = new Set(selection?.droppedExtras ?? []);
  return {
    scenes: (analysis?.scenes ?? []).map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      title: s.title,
      active: !droppedScenes.has(s.id),
    })),
    extras: (analysis?.extras ?? []).map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      active: !droppedExtras.has(e.id),
    })),
  };
}

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * SCENES section for the GPT brief — only when the user dropped something
 * (an untouched analysis needs no extra words: the breakdown already
 * describes every scene).
 */
export function scenesBriefText(
  analysis: VideoAnalysis | undefined,
  selection: AnalysisSelection | undefined,
): string {
  const { scenes } = resolveSelection(analysis, selection);
  const dropped = scenes.filter((s) => !s.active);
  if (dropped.length === 0) return '';
  const kept = scenes.filter((s) => s.active);
  const lines = [
    'SCENES TO DROP (do not recreate these parts of the reference; redistribute their time across the kept scenes so the video still fills 8 seconds):',
    ...dropped.map((s) => `- ${fmt(s.start)}–${fmt(s.end)} ${s.title}`),
  ];
  if (kept.length > 0) {
    lines.push(
      `SCENES TO KEEP (in this order): ${kept
        .map((s) => `${fmt(s.start)}–${fmt(s.end)} ${s.title}`)
        .join('; ')}.`,
    );
  }
  return lines.join('\n');
}

/** EXTRAS section — kept crowds are described, dropped ones are forbidden. */
export function extrasBriefText(
  analysis: VideoAnalysis | undefined,
  selection: AnalysisSelection | undefined,
): string {
  const { extras } = resolveSelection(analysis, selection);
  if (extras.length === 0) return '';
  const kept = extras.filter((e) => e.active);
  const dropped = extras.filter((e) => !e.active);
  const lines: string[] = ['EXTRAS / BACKGROUND PEOPLE:'];
  for (const e of kept) lines.push(`- keep: ${e.label} — ${e.description}`);
  if (dropped.length > 0) {
    lines.push(
      `- remove (the background must be empty of them): ${dropped
        .map((e) => e.label)
        .join('; ')}.`,
    );
  }
  return lines.join('\n');
}
