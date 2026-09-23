/**
 * Pure snapshot builders — the "copy, don't reference" rule of spec §7.8
 * (Project → Session) and §12 (Brand Manifest → Session), kept free of
 * Prisma/Nest so they unit-test in isolation and read like the spec.
 */

import { normalizeVoiceMode } from '../../common/voice-mode';
import { normalizeCameraMove } from '../../common/camera-move';
import {
  normalizeSubtitlesMode,
  normalizeSubtitleTheme,
} from '../../common/subtitles';
import { ProductInformation } from '../../common/types/product.types';
import { SketchableRow, sketchRefFromRow } from '../../common/active-image';
import { SketchRef } from '../../common/types/sketch.types';
import { AudienceProfile } from '../../common/types/audience.types';
import { findCountry } from '../../common/data/countries';
import {
  BrandCharacterSnapshot,
  BrandManifestSnapshot,
  BrandSceneSnapshot,
  JsonObject,
} from '../../common/types/brand-manifest.types';
import {
  GreetingBriefSnapshot,
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingResolution,
  GreetingTone,
} from '../../common/types/greeting.types';

type DecimalLike = { toString(): string } | number | string;

/** What we need from a ProductItem row (structural, see project.service.ts). */
export interface SnapshotItemSource {
  id: string;
  title: string | null;
  photoUrl: string | null;
  description: string | null;
  category: string | null;
  price: DecimalLike | null;
  /** Json column — AudienceProfile or null (§18). */
  audience?: unknown;
}

export interface SnapshotProjectSource {
  title: string;
  currency: string;
  /** ISO 3166-1 alpha-2 — lets the wizard scope YouTube search (§9.1). */
  countryCode: string;
}

export interface SnapshotManifestSource {
  id: string;
  title: string;
  styleNotes: string | null;
  voiceNotes?: string | null;
  voiceMode?: string | null;
  ttsVoiceId?: string | null;
  ttsModel?: string | null;
  ttsProvider?: string | null;
  cameraMove?: string | null;
  subtitlesMode?: string | null;
  subtitleTheme?: string | null;
  filters: unknown;
  effects: unknown;
  characters: Array<{
    id: string;
    label: string;
    photoUrl: string | null;
    description: string | null;
  }>;
  /** Brand scenes (§17.1). Optional so pre-Stage-22 callers/tests still compile. */
  scenes?: Array<{
    id: string;
    label: string;
    photoUrl: string | null;
    description: string | null;
  }>;
}

/**
 * Public Blob URL → the pathname BlobService.downloadBuffer() expects.
 * Item photos are uploaded with `addRandomSuffix: false` to a fixed
 * pathname (product-analog.service.ts `photoPathname`), so the URL path
 * IS the pathname — no lookup needed. Returns null for anything that is
 * not an absolute URL, so a bad value degrades to "no image" rather than
 * a crash at generation time.
 */
export function blobPathnameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
};

export function imageMimeFromPathname(pathname: string): string {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

/**
 * ProductItem → Session.productInformation. The two fields the existing
 * prompt/generation flow reads (`productName`, `productDescription`,
 * `productImagePathname`) are filled so Stages 11–15 work on a
 * project-bound session with zero changes to PromptService /
 * GenerationService; the extra fields ride along for later use.
 *
 * Name falls back to the project title (an item in a SINGLE project has
 * no title of its own — spec §2). Description is required by §7.4 for a
 * "complete" item, but a session may still be started from an incomplete
 * one; the empty string keeps the existing prompt template valid.
 */
export function productInformationFromItem(
  item: SnapshotItemSource & SketchableRow,
  project: SnapshotProjectSource,
  now: Date = new Date(),
): ProductInformation {
  const pathname = item.photoUrl ? blobPathnameFromUrl(item.photoUrl) : null;
  // Товар со скетчем отдаёт в сессию скетч (§4 п.8 ТЗ скетча).
  const sketch = item.activeSketch ? sketchRefFromRow(item.activeSketch) : null;
  return {
    productName: (item.title ?? '').trim() || project.title,
    productDescription: (item.description ?? '').trim(),
    ...(pathname
      ? {
          productImagePathname: pathname,
          productImageMimeType: imageMimeFromPathname(pathname),
          productImageUrl: item.photoUrl as string,
        }
      : {}),
    ...(sketch ? { sketch } : {}),
    ...(item.originalDeletedAt ? { originalDeleted: true } : {}),
    category: item.category,
    audience: audienceOf(item.audience),
    price: item.price === null ? null : Number(item.price),
    currency: project.currency,
    countryCode: project.countryCode,
    languageCode: findCountry(project.countryCode)?.language ?? null,
    sourceProductItemId: item.id,
    addedAt: now,
  };
}

function asJsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Json column → AudienceProfile, null for anything that is not a profile-shaped object. */
export function audienceOf(raw: unknown): AudienceProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    ageRange: typeof o.ageRange === 'string' ? o.ageRange : null,
    gender:
      o.gender === 'women' || o.gender === 'men' || o.gender === 'any'
        ? o.gender
        : null,
    interests: Array.isArray(o.interests)
      ? o.interests.filter((x): x is string => typeof x === 'string')
      : [],
    summary: typeof o.summary === 'string' ? o.summary : null,
    source: o.source === 'user' ? 'user' : 'gemini',
  };
}

export function characterSnapshot(
  c: {
    id: string;
    label: string;
    photoUrl: string | null;
    description: string | null;
  } & SketchableRow,
): BrandCharacterSnapshot {
  // Снимок замораживает АКТИВНЫЙ вариант (§4 п.8 ТЗ скетча): если у
  // персонажа бренда применён скетч, в сессию едет он, а не фото.
  const sketch = c.activeSketch ? sketchRefFromRow(c.activeSketch) : null;
  return {
    sourceCharacterId: c.id,
    label: c.label,
    photoUrl: c.photoUrl,
    description: c.description,
    ...(sketch ? { sketch } : {}),
    ...(c.originalDeletedAt ? { originalDeleted: true } : {}),
  };
}

export function sceneSnapshot(
  c: {
    id: string;
    label: string;
    photoUrl: string | null;
    description: string | null;
  } & SketchableRow,
): BrandSceneSnapshot {
  const sketch = c.activeSketch ? sketchRefFromRow(c.activeSketch) : null;
  return {
    sourceSceneId: c.id,
    label: c.label,
    photoUrl: c.photoUrl,
    description: c.description,
    ...(sketch ? { sketch } : {}),
    ...(c.originalDeletedAt ? { originalDeleted: true } : {}),
  };
}

/** BrandManifest (+ characters + scenes) → Session.brandManifestSnapshot. */
export function brandManifestSnapshotFrom(
  manifest: SnapshotManifestSource,
  now: Date = new Date(),
): BrandManifestSnapshot {
  return {
    brandManifestId: manifest.id,
    title: manifest.title,
    styleNotes: manifest.styleNotes,
    voiceNotes: manifest.voiceNotes ?? null,
    // ТЗ §15.1: режим и голос замораживаются вместе с остальным брендом —
    // иначе смена голоса в манифесте задним числом поменяла бы озвучку
    // уже отснятых роликов.
    voiceMode: normalizeVoiceMode(manifest.voiceMode),
    ttsVoiceId: manifest.ttsVoiceId ?? null,
    ttsModel: manifest.ttsModel ?? null,
    ttsProvider: manifest.ttsProvider ?? null,
    // ТЗ §29: движение камеры — часть стиля серии, замораживается вместе
    // с голосом по той же причине.
    cameraMove: normalizeCameraMove(manifest.cameraMove),
    // TODO §Уровень 2.7, этап 67: субтитры — тоже часть стиля серии,
    // замораживаются вместе с остальным по той же причине.
    subtitlesMode: normalizeSubtitlesMode(manifest.subtitlesMode),
    subtitleTheme: normalizeSubtitleTheme(manifest.subtitleTheme),
    filters: asJsonObject(manifest.filters),
    effects: asJsonObject(manifest.effects),
    characters: manifest.characters.map(characterSnapshot),
    scenes: (manifest.scenes ?? []).map(sceneSnapshot),
    snapshotAt: now.toISOString(),
    editedAt: null,
  };
}

/** What we need from a GreetingBrief row (structural — ТЗ TZ-Greeting-Video-Project-Type.md §3.2). */
export interface SnapshotGreetingBriefSource {
  id: string;
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  brandManifestId: string | null;
  occasionDate: Date | null;
}

/**
 * GreetingBrief → Session.greetingBriefSnapshot (§3.2/§4.3 — «копия, не
 * ссылка», тот же принцип, что `productInformationFromItem` выше).
 *
 * `requestedPresenterProvider`/`requestedResolution` — то, что лежит в
 * БД брифа (уже прошло `resolveGreetingConfig` при создании/правке
 * брифа, §7); `resolved*` дублирует те же значения здесь для симметрии
 * с DTO/сервисным слоем (§3.2 doc-comment `GreetingBriefSnapshot`) —
 * пайплайн генерации обязан читать `resolved*`, а не пересчитывать
 * тариф заново на каждом рендере: тариф пользователя мог с тех пор
 * измениться, а уже созданная сессия должна остаться при том качестве,
 * на которое согласился пользователь в момент создания брифа.
 */
export function greetingBriefSnapshotFrom(
  brief: SnapshotGreetingBriefSource,
  now: Date = new Date(),
): GreetingBriefSnapshot {
  const presenterProvider =
    brief.presenterProvider as GreetingPresenterProvider;
  const resolution = brief.resolution as GreetingResolution;
  return {
    sourceGreetingBriefId: brief.id,
    occasion: brief.occasion,
    customOccasionText: brief.customOccasionText,
    recipientName: brief.recipientName,
    senderName: brief.senderName,
    tone: brief.tone,
    personalMessage: brief.personalMessage,
    requestedPresenterProvider: presenterProvider,
    resolvedPresenterProvider: presenterProvider,
    requestedResolution: resolution,
    resolvedResolution: resolution,
    brandManifestId: brief.brandManifestId,
    occasionDate: brief.occasionDate ? brief.occasionDate.toISOString() : null,
    addedAt: now.toISOString(),
  };
}

/** Поля голоса бренда, которые подтягиваются в сессию до первого рендера. */
export interface ManifestVoiceSource {
  ttsVoiceId: string | null;
  ttsModel: string | null;
  ttsProvider: string | null;
}

/**
 * Подтянуть голос из бренда в снимок сессии перед первым рендером.
 * `null` — менять нечего: голос в сессии выбран вручную
 * (`voiceEditedAt`) или уже совпадает с брендом. Режим озвучки НЕ
 * трогается: он входит в бриф промпта, и его смена после сборки
 * промпта дала бы ролик, снятый под один режим и озвученный в другом.
 */
export function syncSnapshotVoice(
  snapshot: BrandManifestSnapshot,
  manifest: ManifestVoiceSource,
): BrandManifestSnapshot | null {
  if (snapshot.voiceEditedAt) return null;
  const same =
    (snapshot.ttsVoiceId ?? null) === manifest.ttsVoiceId &&
    (snapshot.ttsModel ?? null) === manifest.ttsModel &&
    (snapshot.ttsProvider ?? null) === manifest.ttsProvider;
  if (same) return null;
  return {
    ...snapshot,
    ttsVoiceId: manifest.ttsVoiceId,
    ttsModel: manifest.ttsModel,
    ttsProvider: manifest.ttsProvider,
  };
}

/** Форма манифеста, из которой берутся применённые скетчи ассетов. */
export interface ManifestSketchSource {
  characters: Array<{ id: string } & SketchableRow>;
  scenes?: Array<{ id: string } & SketchableRow> | null;
}

/**
 * Подтянуть в снимок сессии ИИ-скетчи, применённые в бренде ПОСЛЕ её
 * создания (§4 п.8 doc/AI-SKETCH-SPEC.md). `null` — менять нечего.
 *
 * Слот, у которого в сессии уже есть свой скетч, не трогаем: это
 * осознанный выбор пользователя для этого ролика, и он сильнее бренда
 * — тот же принцип, что у голоса (`voiceEditedAt`). Файл такого скетча
 * уборка не удалит: она считает ссылки (аудит A-5).
 *
 * А вот признак «оригинал удалён» подтягивается ВСЕГДА (аудит A-12):
 * без него в сессии остаётся кнопка «Вернуть оригинал» на файл,
 * которого уже нет.
 */
export function syncSnapshotSketches(
  snapshot: BrandManifestSnapshot,
  manifest: ManifestSketchSource,
): BrandManifestSnapshot | null {
  let changed = false;
  const byCharacter = new Map(manifest.characters.map((c) => [c.id, c]));
  const byScene = new Map((manifest.scenes ?? []).map((s) => [s.id, s]));

  function converge<
    T extends {
      sketch?: SketchRef | null;
      originalDeleted?: boolean;
    },
  >(entry: T, row: SketchableRow | undefined): T {
    const fromBrand = row?.activeSketch
      ? sketchRefFromRow(row.activeSketch)
      : null;
    // Свой скетч сессии сильнее бренда — берём скетч бренда, только
    // если своего нет.
    const sketch = entry.sketch ?? fromBrand;
    if (!sketch) return entry;
    const originalDeleted = entry.originalDeleted || !!row?.originalDeletedAt;
    if (
      entry.sketch?.sketchId === sketch.sketchId &&
      (entry.originalDeleted ?? false) === originalDeleted
    ) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      sketch,
      ...(originalDeleted ? { originalDeleted: true } : {}),
    };
  }

  const characters = snapshot.characters.map((entry) =>
    entry.sourceCharacterId
      ? converge(entry, byCharacter.get(entry.sourceCharacterId))
      : entry,
  );

  const scenes = (snapshot.scenes ?? []).map((entry) =>
    entry.sourceSceneId
      ? converge(entry, byScene.get(entry.sourceSceneId))
      : entry,
  );

  if (!changed) return null;
  return {
    ...snapshot,
    characters,
    ...(snapshot.scenes ? { scenes } : {}),
  };
}
