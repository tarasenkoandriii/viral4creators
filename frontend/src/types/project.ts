/**
 * Project / ProductItem / Brand Manifest API shapes — hand-mirrored from
 * backend/src/common/types/project.types.ts and brand-manifest.types.ts
 * (no shared package in this repo). Keep field-for-field in sync.
 */

import type { AudienceProfile } from './index';

import type {
  CameraMove,
  VoiceMode,
  SubtitlesMode,
  SubtitleTheme,
} from './index';

export type ProjectType = 'SINGLE' | 'LINE';
export type ProductPriceSource = 'MANUAL' | 'ANALOG';

export interface ProductAnalogView {
  id: string;
  title: string;
  sourceUrl: string;
  price: number | null;
  /** Currency of the SOURCE listing — may differ from the project's. */
  currency: string | null;
  thumbnailUrl: string | null;
  relevanceRank: number;
}

export interface ProductItemView {
  id: string;
  projectId: string;
  title: string | null;
  photoUrl: string | null;
  description: string | null;
  /** Auto-detected from the photo; never user-entered. */
  category: string | null;
  /** Who buys it (spec §18) — Gemini's read of the photo, editable. */
  audience: AudienceProfile | null;
  price: number | null;
  priceSource: ProductPriceSource;
  /** price AND description present (spec §7.4). */
  isComplete: boolean;
  analogs: ProductAnalogView[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectView {
  id: string;
  type: ProjectType;
  title: string;
  countryCode: string;
  currency: string;
  brandManifestId: string | null;
  items: ProductItemView[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummaryView {
  id: string;
  type: ProjectType;
  title: string;
  countryCode: string;
  currency: string;
  brandManifestId: string | null;
  itemCount: number;
  completeItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CountryOption {
  code: string;
  currency: string;
  nameEn: string;
  nameRu: string;
}

export interface BrandManifestSummaryView {
  id: string;
  title: string;
  characterCount: number;
  sceneCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

/** POST .../photo/process response. */
export interface ProcessPhotoResult {
  item: ProductItemView;
  analogsSource: 'serpapi' | 'cache' | 'none';
  analogsReason?: string;
  recognitionReason?: string;
}

/** POST .../voice/transcribe response. */
export interface TranscribeResult {
  text: string | null;
  applied: boolean;
  reason?: string;
}

// ── Brand Manifest (spec §12) — mirror of backend brand-manifest.types.ts ──

export type JsonObject = Record<string, unknown>;

export interface BrandCharacterView {
  id: string;
  brandManifestId: string;
  label: string;
  photoUrl: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Permanent brand scene / location (spec §17.1) — same shape as a character. */
export type BrandSceneView = BrandCharacterView;

export interface BrandManifestView {
  id: string;
  title: string;
  styleNotes: string | null;
  /** Voice & tone of the brand's voice-over (spec §13). */
  voiceNotes: string | null;
  /** Озвучка (§15.1, этап 35): режим, голос и модель провайдера. */
  voiceMode: VoiceMode;
  ttsVoiceId: string | null;
  ttsModel: string | null;
  /**
   * Провайдер, выпустивший ttsVoiceId ('elevenlabs' | 'resemble' | ...,
   * doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2) — проставляется сервером,
   * не выбирается на фронтенде.
   */
  ttsProvider: string | null;
  /** Движение камеры (§29, этап 46). */
  cameraMove: CameraMove;
  /** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67). */
  subtitlesMode: SubtitlesMode;
  subtitleTheme: SubtitleTheme;
  filters: JsonObject | null;
  effects: JsonObject | null;
  characters: BrandCharacterView[];
  scenes: BrandSceneView[];
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}
