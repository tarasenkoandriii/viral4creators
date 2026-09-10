/**
 * Audience profile — doc/PRODUCT-PROJECT-SPEC.md §18 (Stage 23).
 *
 * The SAME shape is produced by two different Gemini calls and then
 * compared by a third one:
 *  - from the PRODUCT photo (ProductRecognitionService → ProductItem.audience,
 *    editable by the user on the item screen);
 *  - from the REFERENCE video (AnalysisService → VideoAnalysis.audience);
 *  - RelevanceService puts both side by side and says whether this
 *    reference is worth cloning for this product.
 *
 * Free text on purpose (same rule as the product category, §9.4): an ad
 * generator sells anything, a fixed taxonomy would only get in the way.
 * `gender` is the one enum, because the UI renders it as a pill.
 */

export type AudienceGender = 'women' | 'men' | 'any';

export interface AudienceProfile {
  /** "25-34", "18-24 и 25-34", "45+" — as the model or the user wrote it. */
  ageRange: string | null;
  gender: AudienceGender | null;
  /** Short tags: "бег", "ЗОЖ", "молодые мамы"… ≤ 8. */
  interests: string[];
  /** One or two sentences: who buys / who watches and why. */
  summary: string | null;
  /** Where the profile came from — the UI shows "по фото" / "вручную". */
  source: 'gemini' | 'user';
}

/**
 * What the reference video is selling — lets the relevance call compare
 * categories, not just people (a shoe ad cloned for a kettle is a stretch
 * even when the audiences overlap).
 */
export interface PromotedProduct {
  /** Free-text category of the product/service promoted in the video, or null when it is not an ad. */
  category: string | null;
  description: string | null;
  /** "budget" / "mid" / "premium" / null — the model's read of the price tier. */
  priceTier: string | null;
}
