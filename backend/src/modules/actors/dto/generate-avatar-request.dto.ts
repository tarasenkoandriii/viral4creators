import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * Тело POST /admin/actors/:sessionId/generate — doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §3.2/§5.3.
 * Оператор указывает, какой персонаж снимка бренда используется — по
 * индексу в `session.brandManifestSnapshot.characters`, а не по id (тот
 * же приём, что у `CastReplacement.brandCharacterId`, см. actors.types.ts).
 */
export class GenerateAvatarRequestDto {
  @IsInt()
  @Min(0)
  characterIndex!: number;

  /** Своя короткая сцена/описание для Hedra (§3.2, шаг 3); по умолчанию собирается из описания персонажа. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  prompt?: string;

  @IsOptional()
  @IsIn(['1:1', '4:3', '3:4', '16:9', '9:16', '9:21', '21:9'])
  aspectRatio?: string;

  @IsOptional()
  @IsIn(['540p', '720p', '1080p'])
  resolution?: '540p' | '720p' | '1080p';

  /**
   * Явный чекбокс — субтитры нужны не всем роликам, включаются только по
   * запросу оператора (§ актуализация ТЗ, этап 72а). По умолчанию
   * выключены (`false`) — тот же принцип умолчания, что у
   * `SubtitlesMode` брендового пайплайна.
   */
  @IsOptional()
  @IsBoolean()
  subtitles?: boolean;
}
