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

  /** Э3: `user` | `proactive:<ключ>` | `scenario:<ключ>` — формат и ключ проверяет сервис. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  openedBy?: string | null;

  /** Э5: билет распознавания (`POST /widget/v1/voice`) — проверяет конвейер. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  voiceTicket?: string | null;
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

  /** Э3: `V4CAssist('identify')` — режется до WidgetIdentity (cleanIdentity). */
  @IsOptional()
  @IsObject()
  identity?: Record<string, unknown> | null;
}

/** Э3: «позвать человека» (§3.7). Старый iframe Э2 шлёт `{}` — все поля необязательны. */
export class WidgetHandoffDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId?: string | null;

  @IsOptional()
  @IsIn(['uk', 'ru', 'en'])
  uiLang?: 'uk' | 'ru' | 'en' | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  pageUrl?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  scenarioKey?: string | null;

  @IsOptional()
  @IsObject()
  identity?: Record<string, unknown> | null;
}

export class WidgetHandoffCancelDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  conversationId!: string;
}

/** Э3: обмен `?v4c_goal=` на сессию режима выбора цели. */
export class WidgetGoalPickerSessionDto {
  @IsString()
  @MaxLength(80)
  pk!: string;

  @IsString()
  @MaxLength(200)
  token!: string;
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
