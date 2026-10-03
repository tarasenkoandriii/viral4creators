/** Тела маршрутов «Админки: действия» (Э8). */
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ConfirmProposalDto {
  /** Хеш параметров, который сотрудник видел в карточке (§5.4 п.6). */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  paramsHash!: string;

  /** danger: слово подтверждения (§5.2). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  phrase?: string;

  /** Повтор после `unknown` у неидемпотентной операции — «я проверил». */
  @IsOptional()
  @IsBoolean()
  acknowledgeRisk?: boolean;
}

export class CreateMemoDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{2,40}$/)
  key?: string;

  @IsOptional()
  @IsObject()
  draft?: Record<string, unknown>;
}

export class PatchMemoDraftDto {
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  expectedRevision!: number;

  @IsObject()
  draft!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{2,40}$/)
  key?: string;
}

export class ProposalsQueryDto {
  @IsOptional()
  @IsIn(['review'])
  chain?: 'review';
}
