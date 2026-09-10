/**
 * Response DTO for presigned video upload URL
 *
 * The browser PUTs the file bytes directly to `uploadUrl` (Vercel Blob),
 * then calls POST /sessions/:sessionId/analysis as before — the backend
 * never sees the raw bytes at this step.
 */
export class UploadVideoResponseDto {
  success!: boolean;
  data!: {
    uploadUrl: string;
    pathname: string;
  };
  meta!: {
    timestamp: string;
    requestId: string;
  };
}
