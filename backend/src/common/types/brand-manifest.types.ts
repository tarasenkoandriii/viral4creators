/**
 * Brand Manifest API shapes — doc/PRODUCT-PROJECT-SPEC.md §12 (+ §5 model).
 * Mirrored by hand in frontend/src/types (no shared package in this repo).
 *
 * `filters`/`effects` are opaque JSON objects on purpose: their exact
 * structure is the spec's open question §12.1, to be settled once Stage
 * 15 shows how they land in the Veo prompt. Storing them as `Json`
 * means that decision won't need a migration.
 */

import { VoiceMode } from '../voice-mode';
import { CameraMove } from '../camera-move';
import { SubtitlesMode, SubtitleTheme } from '../subtitles';

export type JsonObject = Record<string, unknown>;

export interface BrandCharacterView {
  id: string;
  brandManifestId: string;
  /** UI label, e.g. "Модель 1". */
  label: string;
  /** Vercel Blob URL — goes to Veo as a referenceImage (§10.2). */
  photoUrl: string | null;
  /** Appearance in words — used when there is no photo or it didn't fit the 3-image cap (§10.3). */
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Permanent brand scene (location / set) — §17.1, Stage 22. Same shape as
 * a character on purpose: one photo that goes to Veo as a referenceImage
 * when it gets a slot, words when it doesn't. Copied into the Session
 * snapshot and listed among the slot candidates with origin 'brand'.
 */
export interface BrandSceneView {
  id: string;
  brandManifestId: string;
  /** "Шоурум", "Кухня студии". */
  label: string;
  photoUrl: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandManifestView {
  id: string;
  title: string;
  styleNotes: string | null;
  /** Voice & tone of the brand's voice-over (§13) — goes into the prompt brief. */
  voiceNotes: string | null;
  /** Как озвучивать ролик (ТЗ §15.1): veo | voiceover | dub. */
  voiceMode: VoiceMode;
  /** Голос провайдера синтеза; null — голос по умолчанию стенда. */
  ttsVoiceId: string | null;
  /** Модель провайдера синтеза; null — модель по умолчанию стенда. */
  ttsModel: string | null;
  /**
   * Провайдер, выпустивший ttsVoiceId (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
   * §4.2) — проставляется сервисом, не клиентом; null — старая запись
   * или голос не выбран.
   */
  ttsProvider: string | null;
  /** Движение камеры (ТЗ §29): none | push-in. */
  cameraMove: CameraMove;
  /** Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67): off | on. */
  subtitlesMode: SubtitlesMode;
  /** Пресетная тема оформления — значима только при subtitlesMode: 'on'. */
  subtitleTheme: SubtitleTheme;

  filters: JsonObject | null;
  effects: JsonObject | null;
  characters: BrandCharacterView[];
  /** Permanent scenes of the brand (§17.1). */
  scenes: BrandSceneView[];
  /** How many projects currently link to this manifest — shown before deleting. */
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Row of GET /brand-manifests. */
export interface BrandManifestSummaryView {
  id: string;
  title: string;
  characterCount: number;
  sceneCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

// ── Snapshot inside a Session (spec §12 "Правки перед конкретной генерацией") ──

/**
 * A brand character as COPIED into a Session at creation time. Not the
 * live BrandCharacter row: the user may rename / re-describe / drop it
 * for this one generation without touching the manifest (§12), and the
 * manifest may later change without affecting sessions already made.
 * `sourceCharacterId` only records where it came from (null for
 * characters added ad hoc for this session).
 */
export interface BrandCharacterSnapshot {
  sourceCharacterId: string | null;
  label: string;
  photoUrl: string | null;
  description: string | null;
}

/**
 * Session.data.brandManifestSnapshot — the manifest's values frozen at
 * Session creation (§7.8 snapshot rule applied to §12). Editable per
 * session via PATCH /sessions/:id/brand-manifest; the manifest itself is
 * never written through this path (open question §12.3 stays open —
 * "save back as manifest" would be a separate, explicit action).
 */
/** A brand scene as copied into a Session (§17.1); mirrors BrandCharacterSnapshot. */
export interface BrandSceneSnapshot {
  sourceSceneId: string | null;
  label: string;
  photoUrl: string | null;
  description: string | null;
}

export interface BrandManifestSnapshot {
  /** Manifest the snapshot was taken from — for display only, may be deleted later. */
  brandManifestId: string;
  title: string;
  styleNotes: string | null;
  voiceNotes: string | null;
  /**
   * Озвучка (ТЗ §15.1). Необязательные: у сессий, созданных до этапа 35,
   * этих ключей в снимке нет, и читаются они как режим по умолчанию —
   * ровно то поведение, которое у них и было.
   */
  voiceMode?: VoiceMode;
  ttsVoiceId?: string | null;
  ttsModel?: string | null;
  /**
   * Провайдер, выпустивший ttsVoiceId (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
   * §4.2) — проставляется сервисом при каждом изменении ttsVoiceId, не
   * клиентом. Необязательное по той же причине, что и остальная
   * озвучка: у снимков до этого поля его в снимке нет.
   */
  ttsProvider?: string | null;
  /**
   * Движение камеры (ТЗ §29, этап 46). Необязательное по той же
   * причине, что и озвучка: у снимков до этапа 46 ключа нет, и читаются
   * они как «статичный кадр» — ровно прежнее поведение.
   */
  cameraMove?: CameraMove;
  /**
   * Жёстко вшитые субтитры (ТЗ TODO §Уровень 2.7, этап 67). Необязательные
   * по той же причине, что и озвучка/камера: у снимков до этапа 67 ключей
   * нет, и читаются они как «выключено» — ровно прежнее поведение.
   */
  subtitlesMode?: SubtitlesMode;
  subtitleTheme?: SubtitleTheme;
  filters: JsonObject | null;
  effects: JsonObject | null;
  characters: BrandCharacterSnapshot[];
  /**
   * Brand scenes frozen at Session creation (§17.1). Optional: sessions
   * created before Stage 22 have no key here and read as "no scenes".
   */
  scenes?: BrandSceneSnapshot[];
  /** ISO time of the copy. */
  snapshotAt: string;
  /** Set when the user edited the snapshot for this session (§12). */
  editedAt: string | null;
}
