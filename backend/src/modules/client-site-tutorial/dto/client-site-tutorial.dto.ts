/**
 * Тела запросов визарда обучалки по сайту заказчика — §5.2 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 111.
 *
 * Глобальный `ValidationPipe` в `main.ts` включён с `whitelist` и
 * `forbidNonWhitelisted`, так что лишние поля в теле — это 400, а не
 * тихо проигнорированный мусор.
 */

import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Потолок полей формы — §14 п.8 ТЗ требует поддержать многополевые
 * формы входа, но 20 полей в одной форме это уже не форма входа. */
const MAX_FIELDS_PER_ROUND = 20;
/** Селекторы бывают длинными (CSS-путь с `:nth-of-type()` — последний
 * вариант приоритета §5.4), но не безразмерными. */
const MAX_SELECTOR_LENGTH = 512;
const MAX_VALUE_LENGTH = 4096;

export class ExploreRequestDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  url!: string;
}

export class FillFieldDto {
  @IsString()
  @MaxLength(MAX_SELECTOR_LENGTH)
  selector!: string;

  /**
   * Пустая строка не принимается (аудит этапа 116, закрыто этапом 117).
   * В сценарии `value: ''` означает «это было секретное поле, значение
   * лежит в `credentialsEnc`» — и честное пустое значение от маркера
   * было неотличимо: переигровка падала на нём с «учётные данные не
   * сохранены», и черновик навсегда переставал отменяться. Заполнять
   * поле пустотой всё равно бессмысленно: `fill('')` ничего не делает.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_VALUE_LENGTH)
  value!: string;
}

export class StepRequestDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsArray()
  @ArrayMaxSize(MAX_FIELDS_PER_ROUND)
  @ValidateNested({ each: true })
  @Type(() => FillFieldDto)
  fills!: FillFieldDto[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SELECTOR_LENGTH)
  clickSelector?: string;
}

export class LoginFieldDto {
  @IsString()
  @MaxLength(MAX_SELECTOR_LENGTH)
  selector!: string;

  @IsString()
  @MaxLength(MAX_VALUE_LENGTH)
  value!: string;

  /** §5.2: пароль — всегда `true`; обычный логин/email — на усмотрение
   * фронтенда, но по умолчанию тоже `true`, раз это часть входа. */
  @IsBoolean()
  sensitive!: boolean;
}

export class LoginRequestDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsString()
  @MaxLength(MAX_SELECTOR_LENGTH)
  submitSelector!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_FIELDS_PER_ROUND)
  @ValidateNested({ each: true })
  @Type(() => LoginFieldDto)
  fields!: LoginFieldDto[];

  /** «Одноразово» (Ш0.5 аудита 02.10.2026): стереть данные входа после
   * первой успешной сборки ролика. Не передан — прежний выбор черновика
   * не меняется; по умолчанию данные живут 30 дней с последнего раунда. */
  @IsOptional()
  @IsBoolean()
  forgetAfterBuild?: boolean;
}

/** Ш2-хвост (3): поля формы входа, указанные человеком (запасной путь). */
export class LoginFieldPickDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SELECTOR_LENGTH)
  usernameSelector?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SELECTOR_LENGTH)
  passwordSelector?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SELECTOR_LENGTH)
  submitSelector?: string;
}

/**
 * Ш2-хвост (3): вход учёткой из реестра сайта (режим A). Секретов в теле
 * нет — только id учётки; логин и пароль сервер берёт арендой.
 */
export class RegistryLoginRequestDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  testAccountId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LoginFieldPickDto)
  pick?: LoginFieldPickDto;

  /** «Одноразово» — как у `/login`. */
  @IsOptional()
  @IsBoolean()
  forgetAfterBuild?: boolean;
}

export class UndoRequestDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class FinishRequestDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** Название обучалки — его увидит оператор в очереди на проверку и
   * зритель у готового ролика. `Transform` до валидации: иначе
   * «   » проходило `@MinLength(3)` и сохранялось пустым, а у готового
   * ролика оказывался пустой заголовок (аудит этапа 116). */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  /** Озвучить обучалку по кадрам (решение владельца 06.10.2026). Не
   * передано — прежний выбор черновика (по умолчанию ВКЛ). */
  @IsOptional()
  @IsBoolean()
  voice?: boolean;

  /** Язык интерфейса — язык реплик и подписей ролика. */
  @IsOptional()
  @IsIn(['ru', 'uk', 'en', 'de', 'es'])
  locale?: 'ru' | 'uk' | 'en' | 'de' | 'es';
}

export class RejectDraftDto {
  /** Причину видит пользователь на карточке проекта — пустая отписка
   * оставила бы его без понимания, что чинить (§5.2, §14 п.10). */
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class CompleteLiveLoginDto {
  /** Оптимистичная блокировка — как у всех остальных мутаций (аудит
   * этапа 116). Этот путь самый долгий: между чтением черновика и
   * записью проходят поход в реле и полный раунд браузера. */
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** Зашифрованная квитанция, выданная `/live-login/start`. Именно она,
   * а НЕ `sessionId`: тот пришёл бы от клиента, и подставив чужой,
   * сосед записал бы чужую живую сессию в свой черновик
   * (`live-login-ticket.ts`). */
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  ticket!: string;
}

/** Э-С Ш1: режим A/B для ссылки (до первого `/explore`) или черновика. */
export class SiteAccessRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  url?: string;
}

/**
 * П-Т2: подтверждение прав на аккаунт и согласия с условиями сайта в
 * режиме B. `accepted` — ровно `true` (галочка), `textVersion` — версия
 * текста, который человек видел (сервер сверяет с текущей).
 */
export class AccountConsentRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  url?: string;

  @IsString()
  @MaxLength(64)
  textVersion!: string;

  @IsIn(['uk', 'ru', 'en'])
  locale!: 'uk' | 'ru' | 'en';

  @Equals(true)
  accepted!: true;
}

/**
 * Ш1: «Подтвердить сайт» — завести хост в кабинете сайтов. `linkAccount`
 * — явное согласие на экране: кабинет сайтов находится или создаётся по
 * Telegram-аккаунту пользователя (вопрос 6 аудита слияния).
 */
export class RegisterSiteRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  url?: string;

  @Equals(true)
  linkAccount!: true;
}
