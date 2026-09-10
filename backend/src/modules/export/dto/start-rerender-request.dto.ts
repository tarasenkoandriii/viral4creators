import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { VideoQuality } from '../../../common/types/generation.types';

/**
 * POST /sessions/:id/export/rerender — ярус B (доп. TODO §35,
 * `doc/MULTI-FORMAT-EXPORT-SPEC.md` §3, этап 75): второй платный рендер
 * Veo тем же одобренным промптом, но с другим целевым форматом. Отдельный
 * маршрут от `POST /export`, а не общий список чекбоксов, — это дорогое
 * и рискованное по композиции действие (§3 документа), пользователь не
 * должен заказать его случайно, отметив галочку в том же списке, что
 * дешёвые форматы яруса A.
 */
export class StartRerenderRequestDto {
  @IsString()
  @Matches(/^\d{1,5}:\d{1,5}$/, {
    message: 'targetAspectRatio must look like "16:9"',
  })
  targetAspectRatio!: string;

  /** Необязательный пресет — только для ярлыка/учёта, форматирование берётся из targetAspectRatio. */
  @IsOptional()
  @IsString()
  preset?: string;

  @IsOptional()
  @IsIn(['fast', 'standard'])
  quality?: VideoQuality;
}
