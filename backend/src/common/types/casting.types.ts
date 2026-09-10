/**
 * Character casting — spec §10 "Экран — фильтры/группы персонажей" +
 * "Форма подгрузки нового персонажа". What the user decided about each
 * character Gemini found in the reference video (VideoAnalysis.characters):
 * keep it in the generated video or not, and — if kept — whether to show
 * it as Gemini described it or swap in their own (photo / text / a brand
 * character from the manifest snapshot).
 *
 * Lives in Session.data.characterCasting. Consumed by Stage 15:
 * `active` characters go into the prompt; those with a photo ride as Veo
 * referenceImages, the first three by `order` (§10.3).
 */

export type CastReplacementKind = 'none' | 'photo' | 'text' | 'brand';

export interface CastReplacement {
  kind: CastReplacementKind;
  /** photo / brand: public Blob URL that becomes a Veo referenceImage (§10.2). */
  photoUrl: string | null;
  /** Blob pathname of a photo uploaded for THIS session (deleted with it); null for brand photos. */
  photoPathname: string | null;
  /** text / brand (and optionally photo): appearance in words for the prompt. */
  description: string | null;
  /** brand: which manifest character it came from (BrandCharacter.id, informational). */
  brandCharacterId: string | null;
  /** brand: its label, so the UI can show "Аня" without re-fetching the manifest. */
  label: string | null;
}

export interface CharacterCast {
  /** AnalysisCharacter.id ("c1", "c2"…). */
  characterId: string;
  /** Stays in the generated video. */
  active: boolean;
  /**
   * Activation order, 1-based — decides which photo-characters get the
   * three referenceImage slots (§10.3). 0 when inactive.
   */
  order: number;
  replacement: CastReplacement;
}

export interface CharacterCasting {
  casts: CharacterCast[];
  updatedAt: string;
}

export const NO_REPLACEMENT: CastReplacement = {
  kind: 'none',
  photoUrl: null,
  photoPathname: null,
  description: null,
  brandCharacterId: null,
  label: null,
};
