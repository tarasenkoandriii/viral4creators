/**
 * Reference ↔ product relevance — doc/PRODUCT-PROJECT-SPEC.md §18.3
 * (Stage 23). A separate Gemini TEXT call (no video, no image) puts the
 * reference's audience / promoted product (VideoAnalysis) next to the
 * product's own profile (ProductInformation) and answers the question the
 * user actually has before spending a Veo call: is this the right video to
 * clone for this product, and if not quite — what to bend in the prompt.
 */

export type RelevanceVerdict = 'use' | 'adapt' | 'skip';

export interface RelevanceReport {
  reportId: string;
  generatedAt: string;
  /** 0–100, the model's overall fit. */
  score: number;
  verdict: RelevanceVerdict;
  /** One paragraph the user reads first. */
  summary: string;
  /** Why the score is what it is — bullet reasoning, "логика выбора". */
  reasoning: string[];
  /** Where the reference and the product agree. */
  matches: string[];
  /** Where they diverge (age, gender, price tier, category, tone…). */
  gaps: string[];
  /** Concrete changes to make the clone land with the PRODUCT's audience. */
  adjustments: string[];
  /**
   * Ready-to-use paragraph for the prompt writer: "make the presenter
   * 35-45, replace the gym with a kitchen, slow the pacing…". Appended to
   * the GPT brief as AUDIENCE FIT when `useInPrompt` is on.
   */
  promptAdvice: string;
  /** What the call looked at — shown so the user can see which side was thin. */
  inputs: {
    productAudience: boolean;
    videoAudience: boolean;
    promotedProduct: boolean;
  };
}

export interface RelevanceState {
  report: RelevanceReport | null;
  /** Feed `promptAdvice` / `adjustments` into the prompt brief (default true). */
  useInPrompt: boolean;
  updatedAt: string;
}
