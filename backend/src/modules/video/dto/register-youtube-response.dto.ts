/**
 * Response DTO for registering a YouTube reference video
 */
export class RegisterYoutubeResponseDto {
  success!: boolean;
  data!: {
    youtubeUrl: string;
  };
  meta!: {
    timestamp: string;
    requestId: string;
  };
}
