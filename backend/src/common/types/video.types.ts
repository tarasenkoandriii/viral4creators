/**
 * Video Types
 *
 * Defines the reference video the user wants analyzed. It comes from one of
 * two sources:
 *  - UPLOAD: the browser PUTs bytes directly to Vercel Blob (bypassing the
 *    4.5MB body limit of Vercel Functions). The blob is a short-lived
 *    transit copy only — AnalysisService downloads it once, hands the
 *    bytes to Gemini's Files API, and deletes the blob right after. It is
 *    never meant to be a permanent store for the reference video.
 *  - YOUTUBE: a public YouTube link. Gemini fetches the video itself
 *    server-side, so nothing is uploaded or stored on our side at all.
 */

export enum VideoSourceType {
  UPLOAD = 'upload',
  YOUTUBE = 'youtube',
}

/**
 * Pixel frame of the reference (spec §16). For uploads the browser reads
 * it from the file before the PUT; for YouTube links Gemini reports it
 * during analysis. Only a DEFAULT for the ad's aspect ratio.
 */
export interface VideoFrame {
  width: number | null;
  height: number | null;
  /** "9:16", "16:9", "3:4", … — normalised, see common/aspect-ratio.ts */
  aspectRatio: string;
  source: 'file' | 'gemini' | 'manual';
}

export interface UploadedVideo {
  sourceType: VideoSourceType.UPLOAD;
  frame?: VideoFrame;

  /** Vercel Blob pathname, e.g. "sessions/{sessionId}/original.mp4" */
  blobPathname: string;

  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: Date;
}

export interface YouTubeVideo {
  sourceType: VideoSourceType.YOUTUBE;

  /** Public youtube.com/youtu.be URL */
  youtubeUrl: string;
  frame?: VideoFrame;

  /**
   * Теги исходного ролика, как их отдал `videos.list` в момент
   * регистрации ссылки (ТЗ TZ-Multilingual-YouTube.md, этап 136). Нужны
   * ровно для одного: подставить умолчанием в поле тегов панели
   * публикации, чтобы человек правил готовый список, а не начинал с
   * пустого поля.
   *
   * Поле необязательное и таким останется: тегов нет у роликов, где
   * автор их не заполнил, нет у референса, пришедшего файлом, и не
   * будет, если вызов к Google не удался. Поэтому «нет тегов» — это
   * штатный случай, на который у панели есть обязательный запасной
   * источник (название товара, категория), а не ошибка регистрации.
   *
   * Снимок на момент регистрации, а не зеркало YouTube: автор
   * оригинала может поменять свои теги когда угодно, и перечитывать их
   * ради этого никто не будет.
   */
  sourceTags?: string[];

  registeredAt: Date;
}

/**
 * OriginalVideo represents the reference UGC video the user wants analyzed.
 * Exactly one of the two shapes is present, discriminated by `sourceType`.
 */
export type OriginalVideo = UploadedVideo | YouTubeVideo;
