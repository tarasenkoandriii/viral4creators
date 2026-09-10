/**
 * Analysis Types
 *
 * Defines AI-generated video analysis structures using Google Gemini.
 */

import { AudienceProfile, PromotedProduct } from './audience.types';

/**
 * Analysis processing status
 */
export enum AnalysisStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

/**
 * Scene purpose in video narrative
 */
export enum ScenePurpose {
  HOOK = 'hook',
  PROBLEM = 'problem',
  SOLUTION = 'solution',
  CTA = 'cta',
}

/**
 * Individual scene analysis
 */
export interface Scene {
  /** Original timestamp (e.g., "0:00-0:02") */
  timestamp: string;

  /** Duration in seconds */
  duration: number;

  /** Scene purpose in narrative */
  purpose: ScenePurpose;

  /** Visual details */
  visualDetails: {
    cameraAngle?: string;
    movement?: string;
    lighting?: string;
    colorPalette?: string;
    onScreenElements?: string;
  };

  /** Cinematic details */
  cinematicDetails: {
    shotType?: string;
    pacing?: string;
    style?: string;
  };

  /** Audio details */
  audioDetails: {
    dialogue?: string;
    soundDesign?: string;
    timing?: string;
  };
}

/**
 * How much of the video a character carries — lets the UI order the
 * character chips (spec §10) without timecodes (§10.1, decided: none).
 */
export type CharacterProminence = 'main' | 'secondary' | 'background';

/**
 * A person (or mascot / animal presenter) Gemini saw in the reference
 * video — spec §10 "Расширение ответа Gemini". Appearance is the text that
 * goes into the generation prompt when the user keeps this character as
 * is; a photo replacement rides separately as a Veo referenceImage (§10.2).
 */
export interface AnalysisCharacter {
  /** Stable within one analysis ("c1", "c2"…) — the UI's selection key. */
  id: string;
  /** Short handle, e.g. "Woman in red jacket". */
  label: string;
  /** What they do in the video: presenter, customer, passer-by… */
  role: string | null;
  /** Clothing, approximate age, gender, distinctive features — free text. */
  appearance: string;
  prominence: CharacterProminence;
  /**
   * Seconds into the reference where this character is best visible —
   * where the browser grabs the preview frame (§18.1, Stage 23). Null when
   * the model gave none.
   */
  previewAt?: number | null;
  /** Blob URL of the grabbed frame; null until captured (YouTube links never get one). */
  previewUrl?: string | null;
}

/**
 * One scene of the reference as a compact, structured row (Stage 23) —
 * the detailed narrative stays in `sceneBreakdown`; this list exists for
 * the thumbnail strip and for the relevance call.
 */
export interface AnalysisScene {
  /** "s1", "s2"… — key for the preview upload. */
  id: string;
  /** Seconds. */
  start: number;
  end: number;
  /** "Hook: unboxing on the kitchen table". */
  title: string;
  previewAt: number | null;
  previewUrl?: string | null;
}

/**
 * Incidental background people — the crowd, passers-by, a barista in the
 * far background (spec §19, Stage 24). Kept apart from `characters`: they
 * carry no casting (no replacement, no reference image), only a keep/drop
 * switch so the clone can be shot in an empty street or a full one.
 */
export interface AnalysisExtra {
  /** "e1", "e2"… */
  id: string;
  /** "Прохожие на заднем плане", "Очередь у кассы". */
  label: string;
  description: string;
  previewAt?: number | null;
  previewUrl?: string | null;
}

/**
 * The user's keep/drop choice over scenes and extras (spec §19) — the
 * scene/extras counterpart of CharacterCasting. Everything is kept by
 * default; only the dropped ids are stored.
 */
export interface AnalysisSelection {
  droppedScenes: string[];
  droppedExtras: string[];
  updatedAt: string;
}

/**
 * Structured analysis data parsed from AI response
 */
export interface AnalysisStructuredData {
  /** Scene-by-scene breakdown */
  scenes: Scene[];

  /** Overall aesthetic description */
  overallAesthetic?: string;

  /** Dominant colors identified */
  dominantColors?: string[];

  /** Pacing description */
  pacing?: string;

  /** Audio style description */
  audioStyle?: string;
}

/**
 * Analysis error details
 */
export interface AnalysisError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Error timestamp */
  timestamp: Date;
}

/**
 * VideoAnalysis represents AI-generated insights from the original video
 */
export interface VideoAnalysis {
  /** Unique identifier (UUID) */
  analysisId: string;

  /** Analysis timestamp */
  analyzedAt: Date;

  /** Processing status */
  status: AnalysisStatus;

  /** Raw scene-by-scene breakdown (can be edited by user) */
  sceneBreakdown: string;

  /** Parsed structured insights (optional) */
  structuredData?: AnalysisStructuredData;

  /**
   * Characters seen in the video (spec §10). Top-level rather than inside
   * `structuredData`: that object is never populated today (its `scenes`
   * stay empty), so nesting the one field that IS parsed under it would
   * read as "half-broken data". Empty array = Gemini answered and saw no
   * people; undefined = analysis predates this field or parsing failed.
   */
  characters?: AnalysisCharacter[];

  /** Structured scene list with timecodes (Stage 23) — for previews and relevance. */
  scenes?: AnalysisScene[];

  /** Background crowd / passers-by (Stage 24, §19); [] = none seen. */
  extras?: AnalysisExtra[];

  /** Picture format as Gemini read it (§16) — carried into library entries. */
  frame?: import('./video.types').VideoFrame;

  /** Who the reference video speaks to (§18.2) — Gemini's estimate. */
  audience?: AudienceProfile;

  /** What the reference video sells (§18.2). */
  promotedProduct?: PromotedProduct;

  /** True when this analysis was copied from the library instead of a fresh Gemini call (§21). */
  fromLibrary?: boolean;

  /** User's edited version of scene breakdown (optional) */
  userEdits?: string;

  /** Error details if analysis failed (optional) */
  error?: AnalysisError;
}
