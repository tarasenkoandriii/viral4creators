import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  STORY_PRONUNCIATION_CHARS,
  STORY_PRONUNCIATION_MAX,
} from './story-video-segments';

export class StoryPronunciationDto {
  @IsString() @MaxLength(STORY_PRONUNCIATION_CHARS) written!: string;
  @IsString() @MaxLength(STORY_PRONUNCIATION_CHARS) spoken!: string;
}
/** `POST :id/video` and `POST :id/video/quote` (same body; quote has no side effects). */
export class StoryVideoDto {
  @IsOptional() @IsString() @MaxLength(100) narratorManifestId?: string;
  @IsOptional() @IsString() @MaxLength(80) voiceConsentVersion?: string;
  @IsOptional() @IsBoolean() voiceConsentAccepted?: boolean;
  @IsString() @MaxLength(180) preambleText!: string;
  /** WP4 ST-P1: synthesized (default) or the adult's own recording. */
  @IsOptional() @IsIn(['synth', 'recorded']) preambleSource?:
    | 'synth'
    | 'recorded';
  @IsOptional() @IsUUID() recordingId?: string;
  /** WP4: optional closing line, same voice, same promise validator. */
  @IsOptional() @IsString() @MaxLength(180) outroText?: string;
  /** WP4 ST-P2: respellings applied to TTS input only (never subtitles). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(STORY_PRONUNCIATION_MAX)
  @ValidateNested({ each: true })
  @Type(() => StoryPronunciationDto)
  pronunciations?: StoryPronunciationDto[];
  /** WP5↔WP4: show the profile narrator image (applied look or original) as the intro frame; default false. */
  @IsOptional() @IsBoolean() useNarratorImage?: boolean;
  /** ST3-S-12: the credits the user confirmed; differs → 409 STORY_PRICE_CHANGED. */
  @IsOptional() @IsInt() @Min(0) @Max(100000) expectedCredits?: number;
}
/** `POST :id/render`: the confirmed price (optional, ST3-S-12). */
export class StoryRenderDto {
  @IsOptional() @IsInt() @Min(0) @Max(100000) expectedCredits?: number;
}
/** `POST :id/video/recording`: canonical WAV as base64 + explicit consent. */
export class StoryRecordingDto {
  @IsString() @MaxLength(1333340) base64!: string;
  @IsString() @MaxLength(80) consentVersion!: string;
  @Equals(true) consentAccepted!: boolean;
}
