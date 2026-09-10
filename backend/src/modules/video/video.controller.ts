import {
  Controller,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { VideoService } from './video.service';
import { UploadVideoRequestDto } from './dto/upload-video-request.dto';
import { UploadVideoResponseDto } from './dto/upload-video-response.dto';
import { RegisterYoutubeRequestDto } from './dto/register-youtube-request.dto';
import { RegisterYoutubeResponseDto } from './dto/register-youtube-response.dto';
import { v4 as uuidv4 } from 'uuid';

/**
 * VideoController
 *
 * Handles HTTP endpoints for registering the reference video, either as a
 * direct browser upload (via a presigned Blob URL) or as a YouTube link.
 *
 * Note: the old "upload video directly through backend" endpoint (Multer,
 * CORS workaround) is gone — it buffered the whole file in the request
 * body, which is exactly what the 4.5MB Vercel Function body limit
 * forbids. The presigned-URL path below is the only upload path now.
 */
@Controller()
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  /**
   * POST /sessions/:sessionId/video/upload-url
   * Generate a presigned PUT URL so the browser can upload the video
   * directly to Vercel Blob.
   */
  @Post('sessions/:sessionId/video/upload-url')
  @HttpCode(HttpStatus.OK)
  async getUploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: UploadVideoRequestDto,
  ): Promise<UploadVideoResponseDto> {
    const result = await this.videoService.generateUploadUrl(
      sessionId,
      dto.fileName,
      dto.fileSize,
      dto.mimeType,
      { width: dto.width, height: dto.height },
    );

    return {
      success: true,
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
      },
    };
  }

  /**
   * POST /sessions/:sessionId/video/youtube
   * Register a public YouTube video as the analysis reference. No upload
   * happens — Gemini fetches the video itself from the URL.
   */
  @Post('sessions/:sessionId/video/youtube')
  @HttpCode(HttpStatus.OK)
  async registerYoutube(
    @Param('sessionId') sessionId: string,
    @Body() dto: RegisterYoutubeRequestDto,
  ): Promise<RegisterYoutubeResponseDto> {
    const result = await this.videoService.registerYoutubeVideo(
      sessionId,
      dto.youtubeUrl,
    );

    return {
      success: true,
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
      },
    };
  }
}
