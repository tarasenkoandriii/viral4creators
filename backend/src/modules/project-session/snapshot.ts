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
import { AudienceProfile } from '../../common/types/audience.types';
import { findCountry } from '../../common/data/countries';
import {
  BrandCharacterSnapshot,
  BrandManifestSnapshot,
  BrandSceneSnapshot,
  JsonObject,
} from '../../common/types/brand-manifest.types';

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
  item: SnapshotItemSource,
  project: SnapshotProjectSource,
  now: Date = new Date(),
): ProductInformation {
  const pathname = item.photoUrl ? blobPathnameFromUrl(item.photoUrl) : null;
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

export function characterSnapshot(c: {
  id: string;
  label: string;
  photoUrl: string | null;
  description: string | null;
}): BrandCharacterSnapshot {
  return {
    sourceCharacterId: c.id,
    label: c.label,
    photoUrl: c.photoUrl,
    description: c.description,
  };
}

export function sceneSnapshot(c: {
  id: string;
  label: string;
  photoUrl: string | null;
  description: string | null;
}): BrandSceneSnapshot {
  return {
    sourceSceneId: c.id,
    label: c.label,
    photoUrl: c.photoUrl,
    description: c.description,
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
