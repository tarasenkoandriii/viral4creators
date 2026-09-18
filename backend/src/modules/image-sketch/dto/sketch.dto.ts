/**
 * DTO ИИ-скетча (doc/AI-SKETCH-SPEC.md §6.2).
 *
 * Клиент НЕ присылает путей к файлам — ни оригинала, ни скетча: путь
 * сервер берёт из самого слота. Это не перестраховка, а исправление
 * ровно того класса дефекта, который нашёлся у соседних маршрутов
 * (§6.8 ТЗ): присланный путь копировали, не сверяя ни с сессией, ни с
 * владельцем.
 */

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import {
  SKETCH_MODES,
  SKETCH_RENDERINGS,
  SKETCH_STYLES,
  SKETCH_TARGET_TYPES,
  SketchMode,
  SketchRendering,
  SketchStyle,
  SketchTargetType,
} from '../../../common/types/sketch.types';

export class SketchTargetDto {
  @IsIn(SKETCH_TARGET_TYPES as readonly string[])
  type!: SketchTargetType;

  @IsString()
  @Length(1, 200)
  id!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  subId?: string | null;
}

export class SketchOptionsDto {
  /** Для персонажей сервер всё равно поставит `true` (§4 п.3 ТЗ). */
  @IsOptional()
  @IsBoolean()
  anonymizeFace?: boolean;

  @IsOptional()
  @IsBoolean()
  removeLogos?: boolean;

  @IsOptional()
  @IsBoolean()
  keepColors?: boolean;

  @IsOptional()
  @IsIn(SKETCH_RENDERINGS as readonly string[])
  sketchRendering?: SketchRendering;
}

export class GenerateSketchRequestDto {
  @ValidateNested()
  @Type(() => SketchTargetDto)
  target!: SketchTargetDto;

  @IsIn(SKETCH_MODES as readonly string[])
  mode!: SketchMode;

  @IsIn(SKETCH_STYLES as readonly string[])
  style!: SketchStyle;

  @IsObject()
  @ValidateNested()
  @Type(() => SketchOptionsDto)
  options!: SketchOptionsDto;

  @IsOptional()
  @IsString()
  @Length(3, 2000)
  description?: string | null;
}

export class SketchTargetRequestDto {
  @ValidateNested()
  @Type(() => SketchTargetDto)
  target!: SketchTargetDto;
}

export class ApplySketchRequestDto {
  @IsOptional()
  @IsIn(SKETCH_RENDERINGS as readonly string[])
  sketchRendering?: SketchRendering;
}
