/**
 * Product Types
 *
 * Defines product information structures for the new advertisement.
 */

import type { AudienceProfile } from './audience.types';

/**
 * ProductInformation represents user's product details for the advertisement
 */
export interface ProductInformation {
  /** Product name (3-100 characters) */
  productName: string;

  /** Product description (max 250 characters) */
  productDescription: string;

  /** Vercel Blob pathname for uploaded product image (optional) */
  productImagePathname?: string;

  /** MIME type of product image (optional) */
  productImageMimeType?: string;

  /** Timestamp when product info was added */
  addedAt: Date;

  // ── Present only when the Session was created from a ProductItem
  //    (POST /projects/:id/items/:itemId/sessions, spec §7.8 snapshot).
  //    All optional so the hand-typed anonymous flow is untouched. ──

  /** Public Blob URL of the item photo (same object as productImagePathname). */
  productImageUrl?: string;
  /** Auto-detected category (§9.4) — later used to tag the published video. */
  category?: string | null;
  /** Price in the project's currency, frozen at snapshot time. */
  price?: number | null;
  currency?: string | null;
  /** Project market (ISO 3166-1 alpha-2) + its main language — scope for YouTube search (§9.1). */
  countryCode?: string | null;
  languageCode?: string | null;
  /**
   * Language the ad's voice-over/dialogue must be in (ISO 639-1), chosen by
   * the user on the product step. Absent → derived from languageCode /
   * the description's script — see common/voiceover.ts.
   */
  dialogueLanguage?: string | null;
  /** ProductItem the snapshot was taken from — for display/navigation only. */
  sourceProductItemId?: string;
  /** Target audience of the product (spec §18) — copied from the item, compared with the reference's. */
  audience?: AudienceProfile | null;
}
