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

/** `CLIENT_SITE` — обучалка по сайту заказчика (§4.1
 * doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 115). У такого проекта нет
 * товаров вообще: «товар» здесь — чужой сайт, а всё специфичное живёт
 * в отдельном черновике, не в полях `Project`. */
/** `GREETING_VIDEO` — ролик-поздравление (ТЗ TZ-Greeting-Video-Project-Type.md),
 * четвёртый тип проекта: доступен на всех тарифах, различаются только
 * presenterProvider/resolution внутри (см. `GreetingBriefView`). */
export type ProjectType = 'SINGLE' | 'LINE' | 'CLIENT_SITE' | 'GREETING_VIDEO';
export type ProductPriceSource = 'MANUAL' | 'ANALOG';

// ── GREETING_VIDEO (mirrors backend common/types/greeting.types.ts) ────

export type GreetingOccasion =
  | 'BIRTHDAY'
  | 'WEDDING'
  | 'ANNIVERSARY'
  | 'NEW_YEAR'
  | 'CHRISTMAS'
  | 'GRADUATION'
  | 'VALENTINES_DAY'
  | 'WOMENS_DAY'
  | 'MOTHERS_DAY'
  | 'FATHERS_DAY'
  | 'DEFENDERS_DAY'
  | 'TEACHERS_DAY'
  | 'FIRST_SCHOOL_DAY'
  | 'NEW_BABY'
  | 'BAPTISM'
  | 'HOUSEWARMING'
  | 'PROMOTION'
  | 'RETIREMENT'
  | 'FAREWELL_COLLEAGUE'
  | 'CORPORATE'
  | 'APOLOGY'
  | 'GET_WELL'
  | 'CONDOLENCE'
  | 'OTHER';

export const GREETING_OCCASIONS: readonly GreetingOccasion[] = [
  'BIRTHDAY',
  'WEDDING',
  'ANNIVERSARY',
  'NEW_YEAR',
  'CHRISTMAS',
  'GRADUATION',
  'VALENTINES_DAY',
  'WOMENS_DAY',
  'MOTHERS_DAY',
  'FATHERS_DAY',
  'DEFENDERS_DAY',
  'TEACHERS_DAY',
  'FIRST_SCHOOL_DAY',
  'NEW_BABY',
  'BAPTISM',
  'HOUSEWARMING',
  'PROMOTION',
  'RETIREMENT',
  'FAREWELL_COLLEAGUE',
  'CORPORATE',
  'APOLOGY',
  'GET_WELL',
  'CONDOLENCE',
  'OTHER',
];

export type GreetingTone =
  | 'WARM'
  | 'FUNNY'
  | 'FORMAL'
  | 'SUPPORTIVE'
  | 'RESPECTFUL';

export const GREETING_TONES: readonly GreetingTone[] = [
  'WARM',
  'FUNNY',
  'FORMAL',
  'SUPPORTIVE',
  'RESPECTFUL',
];

const EVERYDAY_TONES: readonly GreetingTone[] = ['WARM', 'FUNNY', 'FORMAL'];

/**
 * Какие тоны показывать для повода — зеркало
 * `backend/src/common/greeting-occasions.ts`.
 *
 * Это ПОДСКАЗКА интерфейсу, а не защита: настоящая проверка живёт на
 * сервере и отвечает 400 (§3 компаньон-ТЗ — «валидироваться серверно,
 * не просто скрываться в UI»). Здесь копия нужна затем, чтобы человек
 * не выбирал шутливый тон для соболезнования и не получал отказ уже
 * после заполнения всей формы. Перечислены только поводы, у которых
 * набор отличается от обычного, — так расхождение с сервером заметнее,
 * чем в полной таблице из 24 строк.
 */
const GREETING_TONE_OVERRIDES: Partial<
  Record<GreetingOccasion, readonly GreetingTone[]>
> = {
  DEFENDERS_DAY: ['WARM', 'FORMAL', 'RESPECTFUL'],
  BAPTISM: ['WARM', 'FORMAL', 'RESPECTFUL'],
  APOLOGY: ['WARM', 'RESPECTFUL'],
  GET_WELL: ['WARM', 'SUPPORTIVE'],
  CONDOLENCE: ['RESPECTFUL', 'SUPPORTIVE'],
};

export function allowedTonesFor(
  occasion: GreetingOccasion
): readonly GreetingTone[] {
  return GREETING_TONE_OVERRIDES[occasion] ?? EVERYDAY_TONES;
}

export function defaultToneFor(occasion: GreetingOccasion): GreetingTone {
  return allowedTonesFor(occasion)[0];
}

/** 'grok' — референс(ы) + видео без лип-синка, голос закадровый;
 * 'hedra' — говорящий аватар, только PREMIUM (§7 ТЗ) — и сегодня
 * недоступен по факту, см. аудит (пилот открыт только оператору). */
export type GreetingPresenterProvider = 'grok' | 'hedra';

export const GREETING_PRESENTER_PROVIDERS: readonly GreetingPresenterProvider[] =
  ['grok', 'hedra'];

export type GreetingResolution = '480p' | '720p' | '1080p';

export const GREETING_RESOLUTIONS: readonly GreetingResolution[] = [
  '480p',
  '720p',
  '1080p',
];

/** GET/PATCH /projects/:id/greeting-brief (§8 ТЗ). */
export interface GreetingBriefView {
  id: string;
  projectId: string;
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: GreetingPresenterProvider;
  resolution: GreetingResolution;
  brandManifestId: string | null;
  occasionDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Тело для создания брифа вместе с проектом (`createProject`). */
export interface CreateGreetingBriefInput {
  occasion: GreetingOccasion;
  customOccasionText?: string;
  recipientName: string;
  senderName?: string;
  tone?: GreetingTone;
  personalMessage?: string;
  presenterProvider?: GreetingPresenterProvider;
  resolution?: GreetingResolution;
  brandManifestId?: string;
  occasionDate?: string;
}

/** PATCH /projects/:id/greeting-brief — partial, and nullable fields can
 * be explicitly cleared with `null` (mirrors backend UpdateGreetingBriefDto). */
export interface UpdateGreetingBriefInput {
  occasion?: GreetingOccasion;
  customOccasionText?: string | null;
  recipientName?: string;
  senderName?: string | null;
  tone?: GreetingTone;
  personalMessage?: string | null;
  presenterProvider?: GreetingPresenterProvider;
  resolution?: GreetingResolution;
  brandManifestId?: string | null;
  occasionDate?: string | null;
}

/**
 * Референс-изображение Grok reference-to-video (доп. запрос к ТЗ: «до 7
 * изображений, скетч как у остальных изображений проекта») — GET
 * /sessions/:id/greeting-references. Активное изображение уже разрешено
 * сервером (оригинал/скетч), см. backend `GreetingReferenceService.toView`.
 */
export interface GreetingReferenceImageView {
  id: string;
  label: string;
  description: string | null;
  photoUrl: string;
  variant: 'original' | 'sketch';
  originalPhotoUrl: string | null;
  originalDeleted: boolean;
  createdAt: string;
}

/**
 * Голос отправителя, выбранный для поздравления (фича №34) —
 * GET/PATCH /sessions/:id/greeting-voice. Зеркалит backend
 * `GreetingSenderVoice`: `resembleVoiceId` нужен для сверки с
 * собственным списком клонов, `label` — чтобы показать выбор.
 */
export interface GreetingSenderVoice {
  userVoiceId: string;
  resembleVoiceId: string;
  label: string;
}

/**
 * Весь выбор голоса поздравления разом. Занято может быть только одно
 * из двух: либо реплику произносит модель в кадре (`presetVoiceId`,
 * настоящий липсинк), либо мы кладём поверх свою дорожку
 * (`senderVoice`). Сервер сам гасит противоположное поле.
 */
export interface GreetingVoiceView {
  senderVoice: GreetingSenderVoice | null;
  presetVoiceId: string | null;
}

/**
 * Музыкальная подложка (фича №4). Каталог ведёт владелец продукта
 * настройкой платформы, поэтому пустой список — рабочее состояние:
 * секция просто не показывается.
 */
export interface GreetingMusicTheme {
  id: string;
  title: string;
  url: string;
  occasions: string[] | null;
}

export interface GreetingMusicSelection {
  id: string;
  title: string;
  url: string;
  /** `catalog` — тема платформы, `upload` — свой файл. Старые записи
   * поля не имеют и читаются как каталожные. */
  source?: 'catalog' | 'upload';
  pathname?: string;
  rightsConfirmedAt?: string;
}

export interface GreetingMusicView {
  themes: GreetingMusicTheme[];
  selected: GreetingMusicSelection | null;
}

/** Пресетный голос xAI из роестра `GET /v1/tts/voices`. */
export interface GrokPresetVoice {
  voiceId: string;
  name: string;
  language: string | null;
}

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
  /** Чем сейчас является `photoUrl` — оригиналом или ИИ-скетчем (§6.3). */
  photoVariant?: 'original' | 'sketch';
  /** Исходное фото: левая половина сравнения «до/после». */
  originalPhotoUrl?: string | null;
  /** Оригинал удалён (§4 п.10) — «Вернуть оригинал» больше не предлагаем. */
  originalDeleted?: boolean;
  /** Id применённого скетча — начальное состояние меню без доп. запроса. */
  activeSketchId?: string | null;
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

/**
 * «Умный» алерт удаления (этап 89) — точные счётчики того, что реально
 * каскадом уйдёт из БД при `DELETE`, а не общая фраза «это необратимо».
 * Само удаление — софт-delete (см. backend `common/soft-delete.ts`),
 * но пользователю это не показывается: интерфейс не предлагает
 * восстановление, поэтому текст остаётся «удалит», а не «пометит».
 */
export interface ProjectDeletePreview {
  items: number;
  catalogBatchRuns: number;
  abTestRuns: number;
  feedImportRuns: number;
}

/** То же самое, только для одного товара (`DELETE .../items/:itemId`). */
export interface ItemDeletePreview {
  analogs: number;
  catalogBatchItems: number;
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
  /** Чем сейчас является `photoUrl` — оригиналом или ИИ-скетчем (§6.3). */
  photoVariant?: 'original' | 'sketch';
  /** Исходное фото: левая половина сравнения «до/после». */
  originalPhotoUrl?: string | null;
  /** Оригинал удалён (§4 п.10) — «Вернуть оригинал» больше не предлагаем. */
  originalDeleted?: boolean;
  /** Id применённого скетча — начальное состояние меню без доп. запроса. */
  activeSketchId?: string | null;
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
