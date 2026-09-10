/**
 * Post-generation audit — doc/PRODUCT-PROJECT-SPEC.md §11 (Stage 16).
 * Optional check of the generated video by Gemini for typical generation
 * artefacts (extra limbs, wrong finger counts, warped faces, broken
 * physics), producing a brief plus a revised prompt the user can drop
 * into the prompt editor and regenerate with (§11.2). The same shape
 * carries a user-reported problem (§11.3) — only `source` differs.
 */

export type AuditSeverity = 'high' | 'medium' | 'low';

export interface AuditIssue {
  id: string;
  severity: AuditSeverity;
  /** e.g. "anatomy", "face", "physics", "product", "text", "other". */
  category: string;
  description: string;
  /** "0:03" — when Gemini could place it; null otherwise. */
  timecode: string | null;
}

export interface PromptFix {
  /** Full revised prompt text — ready for PromptEditor as-is (§11.2). */
  suggestedText: string;
  /** One or two sentences: what changed and why. */
  rationale: string;
}

export interface VideoAudit {
  auditId: string;
  /** GeneratedVideo.generatedVideoId this audit looked at. */
  generatedVideoId: string;
  /** 'gemini' — automatic video audit; 'user' — §11.3 manual report. */
  source: 'gemini' | 'user';
  requestedAt: Date;
  completedAt: Date | null;
  status: 'complete' | 'failed';
  verdict: 'clean' | 'issues' | 'unknown';
  summary: string;
  issues: AuditIssue[];
  promptFix: PromptFix | null;
  /** The prompt text the audit judged / the fix was derived from. */
  promptText: string;
  error?: string;
}

/** Session.data.videoAudit */
export interface VideoAuditState {
  /** Newest first. */
  history: VideoAudit[];
  /**
   * How many times a fix from an audit was applied to the prompt
   * (§11.1: soft cap AUDIT_AUTO_ITERATIONS_LIMIT — warn, never block).
   */
  appliedFixes: number;
}

/**
 * Звуковой чек (этап 73, `common/sound-check.ts`) — отдельная от
 * `VideoAudit` выше Gemini-проверка: звучит ли голос-озвучка как живой
 * человек или как типовой синтез TTS. `VideoAudit` уже слушает аудио
 * (категория `audio` в `auditPrompt`), но ищет ТЕХНИЧЕСКИЕ дефекты
 * (рассинхрон, обрыв речи, не тот язык) — не звучит ли голос «слишком
 * по-роботски». Прямой повод — формулировка из реальной вакансии
 * AI UGC-студии: «голос не должен звучать как ElevenLabs, а как реальный
 * человек-блогер» (тот же скриншот, что уже был поводом выбрать Resemble,
 * см. `doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md` §1). Работает по ОБОИМ
 * пайплайнам (Veo и пилот аватара) — `subject` различает, чей ролик
 * проверяли; хранится общей историей в `Session.data.soundCheck`.
 */
export interface SoundCheck {
  checkId: string;
  subject: 'veo' | 'avatar';
  requestedAt: Date;
  completedAt: Date | null;
  status: 'complete' | 'failed';
  /**
   * 'human' — синтетических признаков не найдено; 'synthetic' — явно
   * звучит как AI TTS; 'ambiguous' — смешанные/неубедительные признаки;
   * 'unknown' — ответ модели не разобран (тот же смысл, что у
   * `VideoAudit.verdict === 'unknown'`).
   */
  verdict: 'human' | 'synthetic' | 'ambiguous' | 'unknown';
  summary: string;
  /** Короткие, конкретные наблюдения — то, что продавец может использовать (сменить голос, добавить паузы). */
  notes: string[];
  error?: string;
}

/** Session.data.soundCheck */
export interface SoundCheckState {
  /** Newest first. */
  history: SoundCheck[];
}
