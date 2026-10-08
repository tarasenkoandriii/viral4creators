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
  IsISO8601,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

  /** Э8: потолок исполнений write/danger сайта за UTC-сутки. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  actionsDailyCap?: number;

  /** Э8: уведомлять владельцев о каждом исполнении danger. */
  @IsOptional()
  @IsBoolean()
  notifyDanger?: boolean;

  /** Р-З9-17: сессия по `pk_test` ходит в коннекторы и действия. */
  @IsOptional()
  @IsBoolean()
  testKeyConnectors?: boolean;

  /** Р-З10-16 (Ш6 (7)): «админка» — Telegram Mini App (Telegram Web предком). */
  @IsOptional()
  @IsBoolean()
  adminTmaFrame?: boolean;

  /**
   * Р-З10-15 (Ш6 (4)): подпись кнопки на странице админки (`data-label`);
   * null/'' — подпись по умолчанию. Строгая проверка — `cleanWidgetLabel`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  widgetLabel?: string | null;

  /** №57: разметка диалогов сотрудников ИИ (§5-тер.13). */
  @IsOptional()
  @IsBoolean()
  analyticsLabeling?: boolean;

  /** №57: минуты на тип задачи — «≈ N часов сэкономлено». */
  @IsOptional()
  @IsObject()
  analyticsTaskMinutes?: Record<string, number>;

  /** №57: еженедельный отчёт «Админки» владельцам в Telegram. */
  @IsOptional()
  @IsBoolean()
  weeklyReport?: boolean;
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

  /** Р-З9-14: маскировать ПД в данных read-операций до модели. */
  @IsOptional()
  @IsBoolean()
  maskPd?: boolean;
}

/** Э8: связь операции — `x-assist-compensation` / `x-assist-preview`. */
export class LinkedOperationDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,100}$/)
  operationId!: string;

  @IsObject()
  params!: Record<string, string>;
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

  // ── Э8: действия ──
  @IsOptional()
  @IsBoolean()
  idempotent?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => LinkedOperationDto)
  compensation?: LinkedOperationDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LinkedOperationDto)
  preview?: LinkedOperationDto | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/)
  dryRunParam?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/)
  amountParam?: string | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(1e12)
  maxAmount?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(1e13)
  dailyAmountCap?: number | null;

  /** Слово подтверждения danger: буквы и пробелы, ≤ 30. */
  @IsOptional()
  @IsString()
  @Matches(/^[\p{L} ]{2,30}$/u)
  confirmWord?: string | null;
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

/**
 * Перевыпуск секрета (секрет подписи JWT, секрет подписи коннектора) —
 * аудит Э7 (д), Р-З9-18: `expectedSetAt` — какой выпуск TMA видела (ISO
 * `setAt` из экрана; null — секрета не было). Не совпало (второй
 * одновременный перевыпуск успел первым) — 409 `ADMIN_SECRET_CHANGED`, и
 * показанный TMA секрет не оказывается «мёртвым». Без поля — как раньше
 * (старые сборки TMA).
 */
export class IssueSecretDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  expectedSetAt?: string | null;
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

  /** Хвост аудита Э7 (ж): сервис принимал `limit`, DTO — нет (400). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /** Э8: read | write | danger | proposal | decision | chain | memo | actions. */
  @IsOptional()
  @IsIn([
    'read',
    'write',
    'danger',
    'proposal',
    'decision',
    'chain',
    'memo',
    'actions',
  ])
  kind?: string;
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
