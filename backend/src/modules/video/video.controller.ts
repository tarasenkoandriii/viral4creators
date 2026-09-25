import {
  Controller,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
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
  // Этап 136: регистрация ссылки перестала быть бесплатной для НАС —
  // она спрашивает у Google теги исходника, и это единица суточной
  // квоты всего деплоя (10 000 на все: поиск референсов, блог, теги).
  // Сам маршрут при этом дешёвый и доступен любому, у кого есть id
  // своей сессии, то есть ровно тот случай, для которого в проекте
  // заведён `RateLimitGuard`: «дёшево для нас, неограниченно для
  // чужого». Двадцати в минуту хватает и человеку, который меняет
  // референс, передумав; двухсот в час — офису за NAT. Перебору,
  // способному выесть суточную квоту за три минуты, — нет.
  @Post('sessions/:sessionId/video/youtube')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit([
    { name: 'video-youtube-register', limit: 20, windowSec: 60 },
    { name: 'video-youtube-register-hour', limit: 200, windowSec: 3600 },
  ])
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
