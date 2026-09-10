/**
 * Voice-over language for the generated ad (spec §13, "минимум" pass).
 *
 * Nothing here synthesises speech — Veo does that itself
 * (`generateAudio: true`). What this module decides is the LANGUAGE the
 * spoken lines and on-screen text must be in, and how the brief tells the
 * prompt-writer to build those lines from the product description the
 * user typed or dictated. Priority:
 *   1. explicit user choice on the product step (`dialogueLanguage`);
 *   2. the project's market language (snapshot `languageCode`, CLDR);
 *   3. the script of the description text itself (dictated Ukrainian text
 *      should not end up voiced in English);
 *   4. English.
 */

import { ProductInformation } from './types/product.types';

/** ISO 639-1 → name the prompt-writer understands. Unknown codes pass through. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  tr: 'Turkish',
  kk: 'Kazakh',
  ro: 'Romanian',
  cs: 'Czech',
  nl: 'Dutch',
  sv: 'Swedish',
  ar: 'Arabic',
  he: 'Hebrew',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  vi: 'Vietnamese',
  id: 'Indonesian',
  th: 'Thai',
  ka: 'Georgian',
  az: 'Azerbaijani',
  uz: 'Uzbek',
  bg: 'Bulgarian',
  el: 'Greek',
  hu: 'Hungarian',
};

export function languageName(code: string): string {
  const c = code.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[c] ?? code;
}

export function isKnownLanguage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    LANGUAGE_NAMES,
    code.trim().toLowerCase().split(/[-_]/)[0],
  );
}

/**
 * Cheap script-based guess from the text the user typed/dictated. Only
 * distinguishes what matters for this product's markets: Ukrainian vs
 * Russian by their exclusive letters, a few other scripts, else Latin →
 * English. Returns null when there is not enough text to say.
 */
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
    // Cyrillic without markers — Ukrainian and Russian both possible; the
    // project country decides upstream, here we lean Russian only because
    // "ы/э" absence in short Ukrainian text is common — caller prefers
    // country language when available.
    return 'ru';
  }
  if (/[֐-׿]/.test(letters)) return 'he';
  if (/[؀-ۿ]/.test(letters)) return 'ar';
  if (/[Ⴀ-ჿ]/.test(letters)) return 'ka';
  if (/[぀-ヿ]/.test(letters)) return 'ja';
  if (/[가-힯]/.test(letters)) return 'ko';
  if (/[一-鿿]/.test(letters)) return 'zh';
  if (/[฀-๿]/.test(letters)) return 'th';
  if (/[Ͱ-Ͽ]/.test(letters)) return 'el';
  if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(t)) return 'pl';
  if (/[äöüßÄÖÜ]/.test(t) && !/[ãõçÃÕÇ]/.test(t)) return 'de';
  if (/[ğışİĞŞ]/.test(t)) return 'tr';
  return 'en';
}

export interface VoiceoverPlan {
  /** ISO 639-1 the dialogue must be in. */
  language: string;
  languageName: string;
  source: 'user' | 'country' | 'description' | 'default';
}

export function resolveVoiceoverLanguage(
  product: ProductInformation | undefined,
): VoiceoverPlan {
  const user = product?.dialogueLanguage?.trim();
  if (user)
    return { language: user, languageName: languageName(user), source: 'user' };
  const country = product?.languageCode?.trim();
  if (country) {
    return {
      language: country,
      languageName: languageName(country),
      source: 'country',
    };
  }
  const guessed = detectLanguage(
    product?.productDescription || product?.productName,
  );
  if (guessed) {
    return {
      language: guessed,
      languageName: languageName(guessed),
      source: 'description',
    };
  }
  return { language: 'en', languageName: 'English', source: 'default' };
}

/**
 * Brief section for the prompt-writer: language + "build the spoken lines
 * from the description the user gave" (typed or dictated on Экран 4) +
 * the brand's voice notes (§12), if any.
 */
export function voiceoverBriefText(
  product: ProductInformation | undefined,
  voiceNotes: string | null | undefined,
): string {
  if (!product) return '';
  const plan = resolveVoiceoverLanguage(product);
  const lines = [
    `VOICE-OVER & DIALOGUE (language: ${plan.languageName} — every spoken line, voice-over and on-screen text must be in ${plan.languageName}; keep brand/product names as given):`,
    `- Build the spoken lines from the product description below — it is what the seller actually wants said (they typed or dictated it). Keep its claims and wording where natural, do not invent features that are not in it, adapt the reference video's rhythm and energy to this text.`,
    `- Product description: """${product.productDescription.trim()}"""`,
  ];
  if (voiceNotes?.trim()) {
    lines.push(`- Brand voice: ${voiceNotes.trim()}`);
  }
  lines.push(
    `- Write the dialogue lines out verbatim in the prompt (Veo voices them as written); one sentence per beat, fit ~8 seconds total.`,
  );
  return lines.join('\n');
}
