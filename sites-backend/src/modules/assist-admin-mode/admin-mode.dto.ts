/**
 * Тела маршрутов кабинета «Админки» (Э7): режим, коннекторы, операции,
 * секреты, обход за логином. Проверка — class-validator (лишнее поле —
 * 400, VALIDATION_PIPE_OPTIONS).
 */
import {
  ArrayMaxSize,
  IsArray,
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
  MinLength,
} from 'class-validator';

/** Роль помощника (значение roleMap, роль операции). */
export const ASSIST_ROLE_RE = /^[a-z0-9_-]{1,32}$/;

export class PatchAdminModeDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['tma', 'script', 'both'], { message: 'Способ: tma, script или both' })
  access?: 'tma' | 'script' | 'both';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { each: true })
  adminHostIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string | null;

  @IsOptional()
  @IsObject()
  roleMap?: Record<string, string>;

  @IsOptional()
  @IsString()
  @Matches(ASSIST_ROLE_RE)
  tmaEmployeeRole?: string | null;

  @IsOptional()
  @IsBoolean()
  statsPerEmployee?: boolean;
}

export class CreateConnectorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  /** URL OpenAPI-описания (https) — либо текст файла `specText`. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2 * 1024 * 1024)
  specText?: string;

  /** Базовый URL API, если в спецификации нет servers[0] (или он другой). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  /** «Это наш аккаунт в SaaS» — хост API не подтверждён как хост сайта (§5.5). */
  @IsOptional()
  @IsBoolean()
  saasAcknowledged?: boolean;
}

export class PatchConnectorDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: 'active' | 'paused';

  @IsOptional()
  @IsBoolean()
  saasAcknowledged?: boolean;
}

export class PatchOperationDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['read', 'write', 'danger'])
  kind?: 'read' | 'write' | 'danger';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(ASSIST_ROLE_RE, { each: true })
  roles?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  dailyLimit?: number | null;
}

export class PutConnectorSecretDto {
  @IsIn(['bearer', 'basic', 'header'])
  authKind!: 'bearer' | 'basic' | 'header';

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  headerName?: string;
  // Служебные имена (Host, Content-Length, …) — отказ в сервисе
  // (`authHeaderNameAllowed`, connector-exec.ts).

  @IsString()
  @MinLength(4)
  @MaxLength(4096)
  // Управляющие символы (CR/LF) в значении заголовка — отказ сразу (аудит Э7).
  @Matches(/^[^\u0000-\u001f\u007f]+$/, {
    message:
      'Ключ API не должен содержать переводы строк и управляющие символы',
  })
  secret!: string;
}

export class ActionLogQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  outcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  operation?: string;
}

export class PutPrivateCrawlDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  hostId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  testAccountId?: string;

  @IsOptional()
  @IsString()
  // Только путь своего хоста: не `//host` и не `/\host` (протокол-
  // относительный адрес увёл бы воркер с учёткой на чужой сайт; аудит Э7).
  @Matches(/^\/(?![/\\])[^\s\\]{0,300}$/)
  startPath?: string;
}
