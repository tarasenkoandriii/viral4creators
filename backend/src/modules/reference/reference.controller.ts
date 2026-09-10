/**
 * ReferenceController — static reference data for the TMA.
 * doc/PRODUCT-PROJECT-SPEC.md §6.3; Stage 6 of the plan.
 *
 *   GET /reference/countries → CountryOption[]  (253 entries, ~15 KB)
 *
 * The list itself (`common/data/countries.ts`) was built in Stage 3 —
 * ProjectService needed country → currency before any screen existed —
 * so this stage is just the read endpoint over it. Full list, no server-
 * side search: §6.3 asks for a searchable picker, and filtering 253 rows
 * client-side (by `nameRu`/`nameEn`/`code`) is instant and works offline
 * between keystrokes; a `?q=` round-trip per keystroke would only add
 * latency inside a Telegram WebView.
 *
 * Public, no identity guard: nothing user-specific here, and Экран 1
 * needs the list before a project exists. Immutable within a deploy
 * (data ships in the bundle), hence the long Cache-Control.
 */

import { Controller, Get, Header } from '@nestjs/common';
import { COUNTRIES } from '../../common/data/countries';

/** What the picker needs — `language` (SerpApi `hl`) is server-only, not exposed. */
export interface CountryOption {
  /** ISO 3166-1 alpha-2 — send this as `countryCode` to POST /projects. */
  code: string;
  /** ISO 4217 — what the project's prices will be denominated in (spec §7.2). */
  currency: string;
  nameEn: string;
  nameRu: string;
}

const OPTIONS: readonly CountryOption[] = COUNTRIES.map(
  ({ code, currency, nameEn, nameRu }) => ({ code, currency, nameEn, nameRu }),
);

@Controller('reference')
export class ReferenceController {
  @Get('countries')
  @Header(
    'Cache-Control',
    'public, max-age=86400, stale-while-revalidate=604800',
  )
  countries(): readonly CountryOption[] {
    return OPTIONS;
  }
}
