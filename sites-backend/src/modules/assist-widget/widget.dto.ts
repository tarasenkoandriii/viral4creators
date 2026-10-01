/**
 * Тела публичных маршрутов виджета (контракт Э2 §6; формы — api-types.ts).
 * Лишнее поле — 400 (forbidNonWhitelisted глобального ValidationPipe).
 * Вложенные объекты (`page`, `context`, `fields`) проверяются вручную в
 * контроллере: у них открытый набор ключей.
 *
 * Длина вопроса здесь НЕ ограничивается до maxQuestionChars: перебор —
 * свой код QUESTION_TOO_LONG (iframe показывает понятный текст), а не
 * общий BAD_REQUEST. Здесь — только защитный потолок тела.
 */
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class WidgetSessionDto {
  @IsString()
  @MaxLength(80)
  pk!: string;

  @IsString()
  @MaxLength(300)
  parentOrigin!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resumeKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  previewSession?: string | null;
}

export class WidgetChatDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId!: string | null;

  @IsUUID()
  clientRequestId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  question!: string;

  @IsOptional()
  @IsObject()
  page!: { url: string | null; title: string | null } | null;

  @IsOptional()
  @IsObject()
  context!: Record<string, string | number> | null;

  @IsOptional()
  @IsIn(['uk', 'ru', 'en'])
  uiLang!: 'uk' | 'ru' | 'en' | null;
}

export class WidgetLeadDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId!: string | null;

  @IsObject()
  fields!: Record<string, unknown>;

  @IsBoolean()
  consent!: boolean;

  @IsIn(['uk', 'ru', 'en'])
  uiLang!: 'uk' | 'ru' | 'en';

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  pageUrl!: string | null;
}

export class WidgetFeedbackDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  messageId!: string;

  @IsIn([1, -1])
  rating!: 1 | -1;
}

export class WidgetPreviewExchangeDto {
  @IsString()
  @MaxLength(80)
  pk!: string;

  @IsString()
  @MaxLength(200)
  token!: string;

  @IsString()
  @MaxLength(300)
  parentOrigin!: string;
}
