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
 * copy for analysis, it's deleted from Blob right after the speech
 * provider (Gemini or Soniox, admin setting) has read it — in `finally`,
 * whatever the outcome (best-effort). Only the resulting text is kept (item.description).
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
import {
  PRODUCT_ITEM_NOT_FOUND,
  VOICE_RECORDING_UPLOAD_FAILED,
} from '../../common/user-facing-errors';
import { VoiceUploadService } from '../voice-upload/voice-upload.service';
import { ITEM_DESCRIPTION_MAX } from '../project/dto/product-item-request.dto';

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
    private readonly voiceUploads: VoiceUploadService,
  ) {}

  async createUploadUrl(
    userId: string,
    projectId: string,
    itemId: string,
    dto: VoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    await this.assertOwnedItem(userId, projectId, itemId);
    const pathname = voicePathname(projectId, itemId, dto.mimeType);
    // Учёт выданного пути — до ссылки: необработанную запись удалит крон
    // `voice-uploads-sweep` в пределах часа (финальный аудит ветки K).
    await this.voiceUploads.remember(pathname);
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
    await this.assertOwnedItem(userId, projectId, itemId);

    const expectedPrefix = `projects/${projectId}/items/${itemId}/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      this.logger.warn(
        `товар ${itemId}: запись пришла с чужим путём ${dto.pathname}`,
      );
      throw new BadRequestException(VOICE_RECORDING_UPLOAD_FAILED);
    }

    // Всё, что после проверки префикса, — внутри `try`, а удаление
    // записи — в `finally` (сквозной аудит голоса 29.09.2026). Раньше
    // удаление стояло после расшифровки, и отказ по дневному лимиту или
    // любое исключение оставляли уже загруженный файл в Blob до удаления
    // проекта: метла сирот живых владельцев не трогает. Условия (3.4)
    // обещают обратное; путь поздравления был починен так же ещё на K2.
    try {
      // ТЗ §25.3: расшифровка — платный вызов. Проект передаётся: по нему
      // определяется сценарий тестового доступа (`assertCanSpendUser`).
      await this.plans.assertCanSpendUser(userId, { projectId });

      let audio: Buffer;
      let mimeType: string;
      try {
        const meta = await head(dto.pathname);
        mimeType = meta.contentType || 'audio/webm';
        audio = await this.blobService.downloadBuffer(dto.pathname);
      } catch (e) {
        this.logger.warn(
          `товар ${itemId}: запись ${dto.pathname} не нашлась в хранилище (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
        throw new BadRequestException(VOICE_RECORDING_UPLOAD_FAILED);
      }

      const result = await this.transcription.transcribe(audio, mimeType, {
        userId,
      });

      const apply = dto.apply ?? true;
      let applied = false;
      if (apply && result.text) {
        await this.prisma.productItem.update({
          where: { id: itemId },
          // Потолок поля — тот же, что у ручной правки (DTO товара):
          // диктовка без него записала бы в базу текст, который
          // следующее же «Сохранить» отвергнет с 400.
          data: { description: result.text.slice(0, ITEM_DESCRIPTION_MAX) },
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
    } finally {
      // Транзитная копия — не храним ни при каком исходе. С `await`: на
      // Vercel работа, не дождавшаяся ответа, может не выполниться вовсе.
      // Строка учёта снимается только после настоящего удаления: не
      // удалилось — крон `voice-uploads-sweep` повторит (аудит после раунда).
      if (await this.blobService.deleteBlob(dto.pathname)) {
        await this.voiceUploads.forget(dto.pathname);
      }
    }
  }

  private async assertOwnedItem(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<void> {
    // `deletedAt: null` (этап 89, найдено доп. аудитом) — тот же класс
    // дыры, что и в ProductAnalogService/ProjectSessionService: без
    // фильтра голосовую заметку можно было записать поверх мягко
    // удалённого товара весь грейс-период.
    const item = await this.prisma.productItem.findFirst({
      where: {
        id: itemId,
        projectId,
        deletedAt: null,
        project: { userId, deletedAt: null },
      },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException(PRODUCT_ITEM_NOT_FOUND);
    }
  }
}
