/**
 * VoiceService — the two-step voice-note flow for a ProductItem.
 * doc/PRODUCT-PROJECT-SPEC.md §4 Экран 4, §6.2; Stage 5 of the plan.
 *
 * Why two steps (presigned Blob PUT, then transcribe by pathname) rather
 * than a multipart upload straight to the backend — the plan's original
 * sketch (`curl -F audio=@test.ogg`): this backend deliberately removed
 * Multer/direct uploads because of Vercel's 4.5 MB Function body limit
 * (ProductController's doc comment, doc/VERCEL-READINESS-AUDIT.md #4). A
 * voice note is usually small, but a few minutes of WAV from an iOS
 * fallback path isn't, and the frontend already has an upload helper
 * for exactly this presigned contract (photo, product image, video). So:
 * same pattern, no new dependency, no body-size cliff.
 *
 * The recording is a TRANSIT copy — like the reference-video transit
 * copy for analysis, it's deleted from Blob right after Gemini has read
 * it (best-effort). Only the resulting text is kept (item.description).
 * Each recording gets a timestamped key so a re-record never races a
 * still-running transcription of the previous take.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import {
  MAX_AUDIO_BYTES,
  VoiceTranscriptionService,
  baseMime,
} from './voice-transcription.service';
import { VoiceUploadUrlRequestDto } from './dto/voice-upload-url-request.dto';
import { TranscribeRequestDto } from './dto/transcribe-request.dto';
import { PlanService } from '../plan/plan.service';

export interface VoiceUploadUrl {
  uploadUrl: string;
  pathname: string;
}

export interface TranscribeResult {
  /** The transcript; null if nothing usable came back (see reason). */
  text: string | null;
  /** True when the text was written into item.description. */
  applied: boolean;
  reason?: string;
}

/** Extension from a (possibly parameterised) MIME type. Exported for tests. */
export function audioExtension(mimeType: string): string {
  const base = baseMime(mimeType);
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/flac': 'flac',
  };
  return map[base] ?? 'bin';
}

/** Timestamped per-item key — a new take never overwrites/races the previous one. Exported for tests. */
export function voicePathname(
  projectId: string,
  itemId: string,
  mimeType: string,
  now: Date = new Date(),
): string {
  return `projects/${projectId}/items/${itemId}/voice-${now.getTime()}.${audioExtension(mimeType)}`;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blobService: BlobService,
    private readonly transcription: VoiceTranscriptionService,
    private readonly plans: PlanService,
  ) {}

  async createUploadUrl(
    userId: string,
    projectId: string,
    itemId: string,
    dto: VoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    await this.assertOwnedItem(userId, projectId, itemId);
    const pathname = voicePathname(projectId, itemId, dto.mimeType);
    // Blob's allowedContentTypes must match the Content-Type the browser
    // sends — MediaRecorder sends the parameterised form, so pass it through as-is.
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_AUDIO_BYTES,
    );
    return { uploadUrl, pathname };
  }

  async transcribe(
    userId: string,
    projectId: string,
    itemId: string,
    dto: TranscribeRequestDto,
  ): Promise<TranscribeResult> {
    // ТЗ §25.3: расшифровка — платный вызов Gemini.
    await this.plans.assertCanSpendUser(userId);
    await this.assertOwnedItem(userId, projectId, itemId);

    const expectedPrefix = `projects/${projectId}/items/${itemId}/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `pathname must start with "${expectedPrefix}"`,
      );
    }

    let audio: Buffer;
    let mimeType: string;
    try {
      const meta = await head(dto.pathname);
      mimeType = meta.contentType || 'audio/webm';
      audio = await this.blobService.downloadBuffer(dto.pathname);
    } catch (e) {
      throw new BadRequestException(
        `Recording not found in storage at "${dto.pathname}" — upload it first via the voice/upload-url step (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    const result = await this.transcription.transcribe(audio, mimeType, {
      userId,
    });

    // Transit copy: Gemini has read it (or failed) — either way we don't
    // keep audio around. Best-effort, never affects the response.
    void this.blobService.deleteBlob(dto.pathname);

    const apply = dto.apply ?? true;
    let applied = false;
    if (apply && result.text) {
      await this.prisma.productItem.update({
        where: { id: itemId },
        data: { description: result.text },
      });
      await this.prisma.project.update({
        where: { id: projectId },
        data: { updatedAt: new Date() },
      });
      applied = true;
    }

    const out: TranscribeResult = { text: result.text, applied };
    if (result.reason) out.reason = result.reason;
    return out;
  }

  private async assertOwnedItem(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.prisma.productItem.findFirst({
      where: { id: itemId, projectId, project: { userId } },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException(
        `Item ${itemId} not found in project ${projectId}`,
      );
    }
  }
}
