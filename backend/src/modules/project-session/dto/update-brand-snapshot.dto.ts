import { Type } from 'class-transformer';
import { IsOwnBlobUrl } from '../../../common/is-own-blob-url.validator';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsJsonObject } from '../../brand-manifest/dto/json-object.validator';
import { VOICE_MODES, VoiceMode } from '../../../common/voice-mode';
import { CAMERA_MOVES, CameraMove } from '../../../common/camera-move';
import {
  SUBTITLES_MODES,
  SubtitlesMode,
  SUBTITLE_THEMES,
  SubtitleTheme,
} from '../../../common/subtitles';

/**
 * PATCH /sessions/:sessionId/brand-manifest — edit the per-session copy
 * of the manifest (spec §12 "правки перед конкретной генерацией").
 * Same limits as the manifest itself (brand-manifest DTOs). Omitted
 * fields keep their snapshot value; `characters`, when present, REPLACES
 * the list (the client sends the full edited set — simplest to reason
 * about for a list the user reorders / removes from).
 */
export class SnapshotCharacterDto {
  /** Manifest character this came from; null/omitted for one added ad hoc. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  sourceCharacterId?: string | null;

  @IsString()
  @Length(1, 80, { message: 'label must be between 1 and 80 characters' })
  label!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  // §12/А-2.11: адрес должен вести в НАШЕ хранилище. Проверки «это
  // https-URL» мало: сервер потом скачивает эту картинку, и любой
  // внешний адрес превращает его в чужого агента.
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @Validate(IsOwnBlobUrl)
  photoUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'description must be between 1 and 2000 characters',
  })
  description?: string | null;
}

/** Same practical cap as a manifest — enough for any brand, blocks abuse. */
export const MAX_SNAPSHOT_CHARACTERS = 20;

export class UpdateBrandSnapshotRequestDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 4000, {
    message: 'styleNotes must be between 1 and 4000 characters',
  })
  styleNotes?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'voiceNotes must be between 1 and 2000 characters',
  })
  voiceNotes?: string | null;

  /**
   * Режим озвучки для ЭТОЙ генерации (ТЗ §15.1). Правится здесь, а не
   * только в манифесте: один ролик из серии вполне может понадобиться
   * с другим голосом, и лезть ради этого в бренд — значит менять его
   * для всех остальных.
   */
  @IsOptional()
  @IsIn(VOICE_MODES, {
    message: `voiceMode must be one of: ${VOICE_MODES.join(', ')}`,
  })
  voiceMode?: VoiceMode;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  ttsVoiceId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  ttsModel?: string | null;

  /**
   * Движение камеры для ЭТОГО ролика (ТЗ §29). Правится здесь по той же
   * причине, что и голос: предметный кадр и говорящий человек просят
   * разного, а менять ради одного ролика бренд — значит менять его для
   * всей серии. В отличие от голоса это ничего не стоит: движение
   * просит промпт, а не отдельный вызов.
   */
  @IsOptional()
  @IsIn(CAMERA_MOVES, {
    message: `cameraMove must be one of: ${CAMERA_MOVES.join(', ')}`,
  })
  cameraMove?: CameraMove;

  /**
   * Субтитры для ЭТОГО ролика (TODO §Уровень 2.7, этап 67) — правится
   * здесь по той же причине, что голос и камера: один ролик из серии
   * может понадобиться без субтитров или с другой темой без изменения
   * бренда целиком.
   */
  @IsOptional()
  @IsIn(SUBTITLES_MODES, {
    message: `subtitlesMode must be one of: ${SUBTITLES_MODES.join(', ')}`,
  })
  subtitlesMode?: SubtitlesMode;

  @IsOptional()
  @IsIn(SUBTITLE_THEMES, {
    message: `subtitleTheme must be one of: ${SUBTITLE_THEMES.join(', ')}`,
  })
  subtitleTheme?: SubtitleTheme;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Validate(IsJsonObject)
  filters?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Validate(IsJsonObject)
  effects?: Record<string, unknown> | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SNAPSHOT_CHARACTERS)
  @ValidateNested({ each: true })
  @Type(() => SnapshotCharacterDto)
  characters?: SnapshotCharacterDto[];
}
