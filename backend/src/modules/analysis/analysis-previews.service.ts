/**
 * AnalysisPreviewsService — preview frames for the analysed characters and
 * scenes (doc/PRODUCT-PROJECT-SPEC.md §18.1, Stage 23).
 *
 * Where the pictures come from: the BROWSER. The reference video is never
 * kept on our side (an upload is a transit blob deleted right after
 * Gemini reads it; a YouTube link is fetched by Gemini itself), and Vercel
 * Functions have no ffmpeg. But when the user uploaded a file, that File
 * is still in the page: after the analysis returns `previewAt` seconds for
 * each character and scene, the frontend seeks the local video element,
 * draws the frame onto a canvas, and PUTs small JPEGs here through the
 * usual presigned-Blob flow. YouTube references therefore have no previews
 * — the UI says so instead of pretending.
 *
 * Keys are the analysis ids ("character:c1", "scene:s3") so the client can
 * never attach a frame to something the analysis did not name.
 */

import { LibraryService } from '../library/library.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { VideoAnalysis } from '../../common/types/analysis.types';

/** 480px JPEG frames are ~30-60 KB; the cap is generous on purpose. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_MIME = 'image/jpeg';

export type PreviewKey =
  | `character:${string}`
  | `scene:${string}`
  | `extra:${string}`;

export interface PreviewUploadTarget {
  key: string;
  uploadUrl: string;
  pathname: string;
}

/** Deterministic Blob key — one frame per analysis id, re-captures overwrite. */
export function previewPathname(sessionId: string, key: string): string {
  return `sessions/${sessionId}/previews/${key.replace(':', '-')}.jpg`;
}

/** Every key the current analysis can accept a frame for. */
export function previewKeysOf(
  analysis: VideoAnalysis | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const c of analysis?.characters ?? []) keys.add(`character:${c.id}`);
  for (const s of analysis?.scenes ?? []) keys.add(`scene:${s.id}`);
  for (const e of analysis?.extras ?? []) keys.add(`extra:${e.id}`);
  return keys;
}

/** Pure: write the confirmed URLs back into the analysis. Exported for tests. */
export function applyPreviewUrls(
  analysis: VideoAnalysis,
  urls: Record<string, string>,
): VideoAnalysis {
  return {
    ...analysis,
    ...(analysis.characters
      ? {
          characters: analysis.characters.map((c) =>
            urls[`character:${c.id}`]
              ? { ...c, previewUrl: urls[`character:${c.id}`] }
              : c,
          ),
        }
      : {}),
    ...(analysis.scenes
      ? {
          scenes: analysis.scenes.map((s) =>
            urls[`scene:${s.id}`]
              ? { ...s, previewUrl: urls[`scene:${s.id}`] }
              : s,
          ),
        }
      : {}),
    ...(analysis.extras
      ? {
          extras: analysis.extras.map((e) =>
            urls[`extra:${e.id}`]
              ? { ...e, previewUrl: urls[`extra:${e.id}`] }
              : e,
          ),
        }
      : {}),
  };
}

@Injectable()
export class AnalysisPreviewsService {
  constructor(
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly library: LibraryService,
  ) {}

  /** One presigned PUT per requested key; unknown keys are a client bug → 400. */
  async createUploadUrls(
    sessionId: string,
    keys: string[],
  ): Promise<PreviewUploadTarget[]> {
    const session = await this.load(sessionId);
    const known = previewKeysOf(session.videoAnalysis);
    const unique = [...new Set(keys)];
    for (const k of unique) {
      if (!known.has(k)) {
        throw new BadRequestException(
          `"${k}" is not a character or scene of this session's analysis`,
        );
      }
    }
    return Promise.all(
      unique.map(async (key) => {
        const pathname = previewPathname(sessionId, key);
        const { uploadUrl } = await this.blob.createUploadUrl(
          pathname,
          PREVIEW_MIME,
          PREVIEW_MAX_BYTES,
        );
        return { key, uploadUrl, pathname };
      }),
    );
  }

  /**
   * After the PUTs: verify each blob exists (a frame the browser failed to
   * upload is simply skipped, not an error — previews are a convenience)
   * and store the public URLs on the analysis.
   */
  async confirm(
    sessionId: string,
    items: Array<{ key: string; pathname: string }>,
  ): Promise<VideoAnalysis> {
    const session = await this.load(sessionId);
    const analysis = session.videoAnalysis;
    if (!analysis) throw new BadRequestException('Analysis not started');
    const known = previewKeysOf(analysis);
    const urls: Record<string, string> = {};
    for (const { key, pathname } of items) {
      if (!known.has(key)) {
        throw new BadRequestException(
          `"${key}" is not a character or scene of this session's analysis`,
        );
      }
      if (pathname !== previewPathname(sessionId, key)) {
        throw new BadRequestException(
          `pathname for "${key}" must be the value returned by upload-url`,
        );
      }
      try {
        urls[key] = (await head(pathname)).url;
      } catch {
        // Not uploaded — leave this one without a preview.
      }
    }
    const next = applyPreviewUrls(analysis, urls);
    await this.sessions.updateSession(sessionId, { videoAnalysis: next });

    // §21 (этап 39, А-2.10): только теперь у разбора есть кадры — сам он
    // записан в библиотеку раньше, ещё до того, как плеер их показал.
    // Без этой строки обложки у записей не было НИКОГДА, и весь префикс
    // `library/…` из §22 не использовался ничем.
    if (session.librarySourceKey) {
      await this.library.refreshPreviews(session.librarySourceKey, next);
    }
    return next;
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}
