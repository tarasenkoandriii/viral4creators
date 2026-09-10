/**
 * DTO for presigned upload URL response for product image
 */
export class UploadProductImageResponseDto {
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
