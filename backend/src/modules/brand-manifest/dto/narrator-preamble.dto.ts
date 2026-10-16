import {
  Equals,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
export class PreambleUploadDto {
  @IsInt() @Min(1) @Max(20971520) fileSize!: number;
}
export class PreambleConfirmDto {
  @IsString()
  @Matches(/^brand-manifests\/[^/]+\/preamble-uploads\/[a-f0-9-]+\.mp4$/)
  pathname!: string;
  @IsIn(['ru', 'uk', 'en', 'de', 'es']) locale!: string;
  @Equals(true) approved!: true;
}
