import { Injectable, BadRequestException } from '@nestjs/common';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { referenceResetPatch } from '../../common/session-reset';
import { SessionStatus } from '../../common/types/session.types';
import { aspectRatioFromSize } from '../../common/aspect-ratio';
import { VideoSourceType } from '../../common/types/video.types';
import { YoutubeSearchService } from '../youtube-search/youtube-search.service';
import { parseYoutubeVideoId } from '../youtube-search/youtube-url';

const MAX_VIDEO_BYTES = 104857600; // 100MB

/**
 * Расширение ключа в хранилище выводится из MIME-типа, а не из присланного
 * имени файла (этап 54, Б-3.5). `fileName` — единственное место, где часть
 * пути в Blob бралась из ввода: DTO требовал лишь непустую строку, и всё
 * после последней точки уходило в ключ как есть — вместе с `..`, слешами
 * и любой длиной. Нормализует ли Vercel Blob такие ключи, мы не проверяли
 * и проверять не должны: раз список допустимых типов и так закрытый, из
 * него же берётся и расширение. Имя файла остаётся в сессии только для
 * показа пользователю.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
};
const ALLOWED_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);

/**
 * VideoService
 *
 * Registers the reference video for a session. Two sources are supported:
 *  - Upload: issues a presigned Vercel Blob PUT URL so the browser sends
 *    bytes directly to storage, bypassing the 4.5MB body limit a Vercel
 *    Function would otherwise impose. We never see the raw bytes here —
 *    AnalysisService downloads the blob once, forwards it to Gemini's
 *    Files API, and deletes it right after (see AnalysisService).
 *  - YouTube: just validates and records the URL. No upload, no storage —
 *    Gemini fetches the video itself when analysis runs.
 */
@Injectable()
export class VideoService {
  constructor(
    private readonly blobService: BlobService,
    private readonly sessionService: SessionService,
    private readonly youtubeSearch: YoutubeSearchService,
  ) {}

  /**
   * Generate presigned upload URL for a video file
   * @param sessionId - Session identifier
   * @param fileName - Original filename
   * @param fileSize - File size in bytes
   * @param mimeType - MIME type of the video
   * @returns Presigned PUT URL and the blob pathname it targets
   */
  async generateUploadUrl(
    sessionId: string,
    fileName: string,
    fileSize: number,
    mimeType: string,
    size?: { width?: number; height?: number },
  ): Promise<{ uploadUrl: string; pathname: string }> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    if (fileSize > MAX_VIDEO_BYTES) {
      throw new BadRequestException('Video file exceeds maximum size of 100MB');
    }

    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(
        `Invalid video format. Allowed formats: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    const pathname = `sessions/${sessionId}/original${EXTENSION_BY_MIME[mimeType]}`;

    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      mimeType,
      MAX_VIDEO_BYTES,
    );

    // The blob doesn't exist yet — the browser is about to PUT to
    // uploadUrl. We record it optimistically so /analysis can find it;
    // if the PUT never completes, analysis fails cleanly on download
    // (BlobService.downloadBuffer's head() call throws).
    await this.sessionService.updateSession(sessionId, {
      // Новый референс отменяет всё, что описывало прежний (этап 28).
      ...referenceResetPatch(),
      originalVideo: {
        sourceType: VideoSourceType.UPLOAD,
        blobPathname: pathname,
        fileName,
        fileSize,
        mimeType,
        uploadedAt: new Date(),
        ...(size?.width && size?.height
          ? {
              frame: {
                width: size.width,
                height: size.height,
                aspectRatio: aspectRatioFromSize(size.width, size.height),
                source: 'file' as const,
              },
            }
          : {}),
      },
      status: SessionStatus.VIDEO_UPLOADED,
    });

    return { uploadUrl, pathname };
  }

  /**
   * Register a public YouTube video as the analysis reference.
   * Validation of the URL format happens in RegisterYoutubeRequestDto;
   * this just persists it on the session.
   * @param sessionId - Session identifier
   * @param youtubeUrl - Public youtube.com/youtu.be URL
   */
  async registerYoutubeVideo(
    sessionId: string,
    youtubeUrl: string,
  ): Promise<{ youtubeUrl: string }> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    // Теги исходника (ТЗ TZ-Multilingual-YouTube.md, этап 136) —
    // единственный момент, когда их вообще можно взять: дальше ссылка
    // уходит в разбор, а к моменту публикации спрашивать у Google уже
    // поздно и незачем. Берутся здесь, а не в поиске, потому что этот
    // путь общий для обоих способов задать референс — и «нашли в
    // поиске», и «вставили ссылку руками».
    //
    // `await` внутри регистрации осознанный: вызов стоит одну единицу
    // квоты и укладывается в тот же таймаут, что и остальные обращения
    // к Google, а альтернатива (дописать теги потом, фоном) означала бы
    // вторую запись в ту же сессию наперегонки с разбором.
    //
    // `catch` здесь не дублирует обещание `fetchVideoTags` никогда не
    // бросать, а страхует от него: «референс регистрируется, даже если
    // тегов не досталось» — инвариант ЭТОГО метода, и держать его на
    // честном слове соседнего класса нельзя. Стоит там появиться
    // исключению — и человек не сможет задать референс вовсе, из-за
    // украшения поля ввода.
    //
    // Повторная регистрация ТОЙ ЖЕ ссылки тегов заново не спрашивает:
    // это снимок на момент регистрации, а не зеркало YouTube, и второй
    // вызов дал бы то же самое за ещё одну единицу квоты. Заодно это
    // закрывает самый дешёвый способ жечь чужую квоту — слать один и
    // тот же URL в цикле.
    const previous = session.originalVideo;
    const sameLink =
      previous?.sourceType === VideoSourceType.YOUTUBE &&
      previous.youtubeUrl === youtubeUrl
        ? (previous.sourceTags ?? [])
        : null;

    const videoId = parseYoutubeVideoId(youtubeUrl);
    const sourceTags =
      sameLink && sameLink.length > 0
        ? sameLink
        : videoId
          ? await this.youtubeSearch
              .fetchVideoTags(videoId, sessionId)
              .catch(() => [] as string[])
          : [];

    await this.sessionService.updateSession(sessionId, {
      ...referenceResetPatch(),
      originalVideo: {
        sourceType: VideoSourceType.YOUTUBE,
        youtubeUrl,
        registeredAt: new Date(),
        // Пустой список не пишем вовсе: «тегов у исходника нет» и «поле
        // есть, но пустое» — одно и то же для панели публикации, а
        // отсутствие поля честнее говорит, что взять их было неоткуда.
        ...(sourceTags.length > 0 ? { sourceTags } : {}),
      },
      status: SessionStatus.VIDEO_UPLOADED,
    });

    return { youtubeUrl };
  }
}
