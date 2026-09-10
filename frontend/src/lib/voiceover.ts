/**
 * Voice-over language (spec §13, minimum pass) — client side of
 * backend/src/common/voiceover.ts. Same priority: user choice > project
 * market language > script of the typed/dictated description > English.
 * The detector here only pre-selects the dropdown; the server re-derives
 * the language on its own when the user leaves the choice empty.
 */

export const DIALOGUE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'uk', label: 'Українська' },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'pl', label: 'Polski' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'kk', label: 'Қазақша' },
  { code: 'ro', label: 'Română' },
  { code: 'cs', label: 'Čeština' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'ar', label: 'العربية' },
  { code: 'he', label: 'עברית' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
];

export function detectLanguage(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (t.length < 3) return null;
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length < 3) return null;
  const cyr = (letters.match(/[Ѐ-ӿ]/g) ?? []).length;
  if (cyr / letters.length > 0.5) {
    if (/[іїєґІЇЄҐ]/.test(t)) return 'uk';
    if (/[ыэъЫЭЪ]/.test(t)) return 'ru';
    if (/[әіңғүұқөһӘІҢҒҮҰҚӨҺ]/.test(t)) return 'kk';
    return 'ru';
  }
  if (/[֐-׿]/.test(letters)) return 'he';
  if (/[؀-ۿ]/.test(letters)) return 'ar';
  if (/[぀-ヿ]/.test(letters)) return 'ja';
  if (/[가-힯]/.test(letters)) return 'ko';
  if (/[一-鿿]/.test(letters)) return 'zh';
  if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(t)) return 'pl';
  if (/[äöüßÄÖÜ]/.test(t) && !/[ãõçÃÕÇ]/.test(t)) return 'de';
  if (/[ğışİĞŞ]/.test(t)) return 'tr';
  return 'en';
}

/** What the dropdown should start with, and why (for the hint under it). */
export function suggestDialogueLanguage(opts: {
  chosen?: string | null;
  countryLanguage?: string | null;
  description?: string | null;
  name?: string | null;
}): { code: string; source: 'user' | 'country' | 'description' | 'default' } {
  if (opts.chosen) return { code: opts.chosen, source: 'user' };
  if (opts.countryLanguage)
    return { code: opts.countryLanguage, source: 'country' };
  const guessed = detectLanguage(opts.description || opts.name);
  if (guessed) return { code: guessed, source: 'description' };
  return { code: 'en', source: 'default' };
}
