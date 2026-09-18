/**
 * User-supplied scene images and the explicit choice of which images fill
 * Veo's three referenceImage slots (doc/PRODUCT-PROJECT-SPEC.md §17).
 *
 * Candidates for a slot: active characters with a photo (§10), uploaded
 * scenes (this file), permanent brand scenes copied into the session's
 * manifest snapshot (§17.1, Stage 22), the product photo (§10.4). At most
 * 3 ride as images; everything not chosen is described in the prompt text.
 */

import { SketchRef } from './sketch.types';

/** A location / set / background the user wants the ad shot in. */
export interface SceneAsset {
  id: string;
  label: string;
  /** Words for the prompt when the image is not in a slot (or in addition). */
  description: string | null;
  photoUrl: string;
  photoPathname: string;
  createdAt: string;
  /** ИИ-скетч вместо фото сцены (doc/AI-SKETCH-SPEC.md §6.1). */
  sketch?: SketchRef | null;
  originalDeleted?: boolean;
}

/** Stable ids of slot candidates: "character:c1", "scene:<id>", "brand-scene:<id>", "product". */
export type ReferenceCandidateId = string;

export interface ReferenceSelection {
  /** Ordered, ≤3. Order = reference image index 1..3. */
  slots: ReferenceCandidateId[];
  updatedAt: string;
}

export type ReferenceCandidateKind =
  | 'character'
  | 'scene'
  | 'product'
  | 'text-card';

/** What the UI shows in the chooser. */
export interface ReferenceCandidateView {
  /** `sketch` — вместо оригинала применён ИИ-скетч (§3.4 ТЗ скетча). */
  variant?: 'original' | 'sketch';
  id: ReferenceCandidateId;
  kind: ReferenceCandidateKind;
  label: string;
  thumbnailUrl: string | null;
  /**
   * Исходное фото, когда активен скетч — левая половина сравнения
   * «до/после» в окне скетча (аудит A-15). У оригинала поля нет.
   */
  originalThumbnailUrl?: string | null;
  /** The text that will go into the prompt if this candidate is NOT in a slot. */
  textFallback: string;
  /**
   * Where the image lives: 'session' — uploaded in this session (a scene
   * can be deleted right in the chooser); 'brand' — comes from the Brand
   * Manifest snapshot (edit it in the «Бренд» section, not here).
   */
  origin: 'session' | 'brand';
}

export interface ReferenceSlotsView {
  candidates: ReferenceCandidateView[];
  /** Current effective slots (explicit selection or the default rule). */
  slots: ReferenceCandidateId[];
  max: number;
  /** True when `slots` came from the default rule, not from the user. */
  isDefault: boolean;
}
