/**
 * Session Types
 *
 * Defines session state structure and status enum for workflow tracking.
 */

import { OriginalVideo } from './video.types';
import { AnalysisSelection, VideoAnalysis } from './analysis.types';
import { ProductInformation } from './product.types';
import { GenerationPrompt } from './prompt.types';
import { GeneratedVideo } from './generation.types';
import { BrandManifestSnapshot } from './brand-manifest.types';
import { CharacterCasting } from './casting.types';
import { SoundCheckState, VideoAuditState } from './audit.types';
import { ReferenceSelection, SceneAsset } from './reference.types';
import { RelevanceState } from './relevance.types';
import { AvatarVideo } from './actors.types';

/**
 * Session status enum representing workflow progression
 */
export enum SessionStatus {
  CREATED = 'created',
  VIDEO_UPLOADED = 'video_uploaded',
  ANALYZING = 'analyzing',
  ANALYSIS_COMPLETE = 'analysis_complete',
  PRODUCT_INFO_ADDED = 'product_info_added',
  PROMPT_GENERATED = 'prompt_generated',
  GENERATING_VIDEO = 'generating_video',
  VIDEO_COMPLETE = 'video_complete',
  ERROR = 'error',
}

/**
 * Session represents a complete workflow instance
 * Stored in-memory on the backend
 */
export interface Session {
  /**
   * Ключ записи библиотеки, к которой относится разбор этой сессии
   * (§21, этап 39). Нужен, чтобы досохранить кадры-превью после того,
   * как браузер их снял и подтвердил: сам разбор к тому моменту давно
   * записан, а обложки у него ещё нет.
   */
  librarySourceKey?: string | null;

  /**
   * Id страницы шеринга (SharedVideoPage), по ссылке которой создана эта
   * сессия (этап 60, ТЗ §40) — «Сделать такой же» на публичной странице
   * ролика. Проставляется один раз при создании (POST
   * /shared-video/:id/fork) и читается в GenerationService при первом
   * завершении рендера, чтобы бампнуть счётчик конверсии
   * `firstGenerationCount` у страницы-источника. Отсутствует у всех
   * сессий, начатых обычным путём.
   */
  sharedFromPageId?: string | null;

  /** Unique identifier (UUID) */
  sessionId: string;

  /** Session creation timestamp */
  createdAt: Date;

  /** Last interaction timestamp (for cleanup) */
  lastActivityAt: Date;

  /** Overall workflow status */
  status: SessionStatus;

  /**
   * Who created the session (Telegram identity), null for the anonymous
   * browser path. Read-only here: set once at creation. Needed since
   * Stage 25 so a private library entry can be shown back to its author
   * (spec §21.3) and so provenance on a library row is real.
   */
  userId?: string | null;

  /** Uploaded source video (optional until uploaded) */
  originalVideo?: OriginalVideo;

  /** AI analysis results (optional until analyzed) */
  videoAnalysis?: VideoAnalysis;

  /** User's product details (optional until submitted) */
  productInformation?: ProductInformation;

  /** Text-to-video prompt (optional until generated) */
  generationPrompt?: GenerationPrompt;

  /** Final output video (optional until generated) */
  generatedVideo?: GeneratedVideo;

  /**
   * Пилот говорящего AI-аватара (Hedra Character-3 + Resemble),
   * doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md — отдельная ветка от
   * `generatedVideo`, ручной запуск оператора (§5.3 документа, этап 72).
   */
  avatarVideo?: AvatarVideo;

  /**
   * Brand Manifest values copied at creation when the source project had
   * one (spec §12) — editable for this session only. Undefined for
   * sessions made without a project or from a project without a manifest.
   */
  brandManifestSnapshot?: BrandManifestSnapshot;

  /** Which analysed characters stay and how they are replaced (spec §10). */
  characterCasting?: CharacterCasting;

  /** Post-generation audits + applied-fix counter (spec §11). */
  videoAudit?: VideoAuditState;

  /**
   * Голосовые чек-звуки (этап 73, `common/sound-check.ts`) — общая
   * история для обоих пайплайнов (`SoundCheck.subject` различает, чей
   * ролик проверяли).
   */
  soundCheck?: SoundCheckState;

  /** User-uploaded scene / set images (spec §17). */
  scenes?: SceneAsset[];
  /** Explicit choice of the ≤3 Veo referenceImage slots (spec §17). */
  referenceSelection?: ReferenceSelection;

  /** Reference ↔ product audience match (spec §18.3, Stage 23). */
  relevance?: RelevanceState;

  /** Keep/drop choice over scenes and extras (spec §19, Stage 24). */
  analysisSelection?: AnalysisSelection;

  /**
   * Where this session was started from (spec §7.8, Project 1—* Session).
   * Real columns, not JSON; SetNull on project deletion, so both may be
   * null on a session that was once project-bound. Undefined/null for the
   * anonymous quick flow.
   */
  projectId?: string | null;
  productItemId?: string | null;

  /**
   * UI-локаль, выбранная пользователем на фронтенде (ТЗ §35.5, этап 59:
   * "по явному выбору пользователя мультиязычность не ограничивается
   * интерфейсом и блогом" — разбор референса, распознавание фото,
   * релевантность и аудит ролика тоже должны отвечать на этом языке).
   * Устанавливается один раз при создании сессии (frontend передаёт
   * текущую локаль из lib/i18n.ts), не меняется на лету. Отсутствует у
   * сессий, созданных до этого этапа, и у клиентов, которые ещё не
   * обновились, — `normalizeLocale()` (common/locale.ts) трактует это как
   * DEFAULT_LOCALE ('ru'), а не как ошибку.
   */
  locale?: string;
}
