/**
 * Тела маршрутов знаний — одни и те же формы у «Сайта» и «Админки»
 * (контракт Э1 §«REST»): режим задаёт МАРШРУТ, в теле его нет и быть не
 * может (слой 5 — `forbidNonWhitelisted`: лишнее поле `mode` — 400).
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { KNOWLEDGE_DEFAULTS } from '../../../config/assist-defaults';

/** Url-источник: адресов в одном — не больше. */
export const MAX_URLS_PER_SOURCE = KNOWLEDGE_DEFAULTS.maxUrlsPerSource;

export class CreateSourceDto {
  @IsIn(['url', 'file'], { message: 'Тип источника: url или file' })
  kind!: 'url' | 'file';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ValidateIf((o: CreateSourceDto) => o.kind === 'url')
  @IsArray({ message: 'Укажите адреса страниц' })
  @ArrayMinSize(1, { message: 'Укажите хотя бы один адрес' })
  @ArrayMaxSize(MAX_URLS_PER_SOURCE, {
    message: `Не больше ${MAX_URLS_PER_SOURCE} адресов в одном источнике`,
  })
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  urls?: string[];

  @ValidateIf((o: CreateSourceDto) => o.kind === 'file')
  @IsString()
  @IsNotEmpty({ message: 'Укажите имя файла' })
  @MaxLength(255)
  fileName?: string;

  @ValidateIf((o: CreateSourceDto) => o.kind === 'file')
  @IsString()
  @IsNotEmpty({ message: 'Укажите тип файла' })
  @MaxLength(200)
  mimeType?: string;

  @ValidateIf((o: CreateSourceDto) => o.kind === 'file')
  @Type(() => Number)
  @IsInt({ message: 'Размер файла — целое число байт' })
  @Min(1, { message: 'Файл пустой' })
  @Max(1_000_000_000)
  bytes?: number;

  /** «Сайт»: «этот файл увидят все посетители» (§3.4) — обязано быть true. */
  @IsOptional()
  @IsBoolean()
  confirmPublic?: boolean;
}

export class PatchSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'], { message: 'Статус: active или disabled' })
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Укажите хотя бы один адрес' })
  @ArrayMaxSize(MAX_URLS_PER_SOURCE, {
    message: `Не больше ${MAX_URLS_PER_SOURCE} адресов в одном источнике`,
  })
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  urls?: string[];
}

export class DocumentsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceId?: string;

  @IsOptional()
  @IsIn(['active', 'gone', 'excluded', 'failed', 'skipped'])
  status?: 'active' | 'gone' | 'excluded' | 'failed' | 'skipped';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}

export class CreateFaqDto {
  @IsString()
  @IsNotEmpty({ message: 'Укажите вопрос' })
  @MaxLength(500)
  question!: string;

  @IsString()
  @IsNotEmpty({ message: 'Укажите ответ' })
  @MaxLength(5000)
  answer!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  variants?: string[];

  @IsOptional()
  @IsIn(['uk', 'ru', 'en'])
  lang?: string;
}

export class PatchFaqDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  answer?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  variants?: string[];

  @IsOptional()
  @IsIn(['uk', 'ru', 'en'])
  lang?: string;

  @IsOptional()
  @IsIn(['active', 'archived'], { message: 'Статус: active или archived' })
  status?: 'active' | 'archived';
}

export class CreateExclusionDto {
  @IsIn(['url', 'urlPrefix', 'chunkHash', 'document'], {
    message: 'Вид исключения: url, urlPrefix, chunkHash или document',
  })
  kind!: 'url' | 'urlPrefix' | 'chunkHash' | 'document';

  @IsString()
  @IsNotEmpty({ message: 'Укажите, что исключить' })
  @MaxLength(2048)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** «Сайт»: горячие страницы (§4-тер.2). */
export class HotPagesDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  urls!: string[];
}

export class SiteKnowledgeSettingsDto {
  @IsIn(['manual', 'weekly', 'daily'], {
    message: 'Частота переобхода: manual, weekly или daily',
  })
  recrawlEvery!: 'manual' | 'weekly' | 'daily';
}

export class AdminKnowledgeSettingsDto {
  @IsOptional()
  @IsBoolean()
  includePublicInAdmin?: boolean;

  @IsOptional()
  @IsBoolean()
  includeUgcInAdmin?: boolean;
}
