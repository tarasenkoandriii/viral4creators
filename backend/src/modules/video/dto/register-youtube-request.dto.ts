import { IsString, IsNotEmpty, Matches } from 'class-validator';

const YOUTUBE_URL_PATTERN =
  /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i;

/**
 * Request DTO for registering a public YouTube video as the analysis
 * reference. No upload happens for this path — Gemini fetches the video
 * itself directly from the URL.
 */
export class RegisterYoutubeRequestDto {
  @IsString()
  @IsNotEmpty()
  @Matches(YOUTUBE_URL_PATTERN, {
    message: 'Only public youtube.com/youtu.be links are supported',
  })
  youtubeUrl!: string;
}
