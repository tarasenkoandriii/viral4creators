/**
 * Тела запросов маршрутов ядра. Глобальный ValidationPipe с
 * `forbidNonWhitelisted`: лишнее поле — 400, а не молча отброшено.
 */

import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { VERIFY_METHODS, type VerifyMethod } from './site-core.constants';

export class CreateSiteDto {
  @IsString()
  @IsNotEmpty({ message: 'Укажите название сайта' })
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'Укажите адрес сайта' })
  @MaxLength(2048)
  url!: string;
}

export class AddHostDto {
  @IsString()
  @IsNotEmpty({ message: 'Укажите адрес хоста' })
  @MaxLength(2048)
  url!: string;
}

export class MethodDto {
  @IsOptional()
  @IsIn(VERIFY_METHODS as unknown as string[], {
    message: 'Способ проверки: dns, file или meta',
  })
  method?: VerifyMethod;
}

export class ChallengeDto {
  @IsIn(VERIFY_METHODS as unknown as string[], {
    message: 'Способ проверки: dns, file или meta',
  })
  method!: VerifyMethod;
}

export class CreateInviteDto {
  @IsIn(['manager', 'operator'], {
    message: 'Пригласить можно менеджера или оператора',
  })
  role!: 'manager' | 'operator';

  @IsOptional()
  @IsObject()
  productRoles?: Record<string, unknown>;
}

export class AcceptInviteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  token!: string;
}
