/** Тела маршрутов чата сотрудника (Э7). */
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AdminSessionDto {
  @IsString()
  @MaxLength(80)
  pk!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  jwt!: string;
}

export class AdminAskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientRequestId?: string;
}

export class AdminFeedbackDto {
  @IsIn([1, -1])
  rating!: 1 | -1;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  correction?: string;
}
