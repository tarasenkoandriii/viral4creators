import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { VOICE_MODES, VoiceMode } from '../../../common/voice-mode';
import { CAMERA_MOVES, CameraMove } from '../../../common/camera-move';
import {
  SUBTITLES_MODES,
  SubtitlesMode,
  SUBTITLE_THEMES,
  SubtitleTheme,
} from '../../../common/subtitles';
import { IsJsonObject } from './json-object.validator';
import type {
  BrandManifestKind,
  JsonObject,
} from '../../../common/types/brand-manifest.types';
import { BRAND_MANIFEST_KINDS } from '../../../common/types/brand-manifest.types';
import {
  GREETING_TONES,
  GreetingTone,
} from '../../../common/types/greeting.types';
import {
  CARD_COLOR_KEYS,
  CARD_FONT_KEYS,
} from '../../../common/greeting-cards';

/**
 * Стиль карточек поздравления (этап G, Г-6) — только ключи белого списка
 * `common/greeting-cards.ts`: шрифт должен быть у ffmpeg-сервиса, цвет —
 * читаться на тёмной плашке.
 */
export class CardStyleDto {
  @IsIn(CARD_FONT_KEYS, {
    message: `cardStyle.font must be one of: ${CARD_FONT_KEYS.join(', ')}`,
  })
  font!: string;

  @IsIn(CARD_COLOR_KEYS, {
    message: `cardStyle.color must be one of: ${CARD_COLOR_KEYS.join(', ')}`,
  })
  color!: string;
}

/**
 * Shared by POST /brand-manifests and PATCH /brand-manifests/:id.
 * Everything optional except `title` on create (enforced in the service,
 * so one DTO covers both). Explicit `null` clears styleNotes/filters/effects.
 */
export class BrandManifestRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 120, { message: 'title must be between 1 and 120 characters' })
  title?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 4000, {
    message: 'styleNotes must be between 1 and 4000 characters',
  })
  styleNotes?: string | null;

  /** Голос и тон озвучки (§13): пол/возраст голоса, темп, манера, запреты. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'voiceNotes must be between 1 and 2000 characters',
  })
  voiceNotes?: string | null;

  /**
   * Режим озвучки (ТЗ §15.1). Неизвестное значение отвергается, а не
   * приводится к умолчанию молча: «выбрал дубляж, получил голос Veo» —
   * это ошибка, о которой надо узнать сразу.
   */
  @IsOptional()
  @IsIn(VOICE_MODES, {
    message: `voiceMode must be one of: ${VOICE_MODES.join(', ')}`,
  })
  voiceMode?: VoiceMode;

  /**
   * Движение камеры (ТЗ §29). Тот же принцип, что у режима озвучки:
   * неизвестное значение отвергается, а не приводится к умолчанию —
   * «включил наезд, получил статику» тоже надо замечать сразу.
   */
  @IsOptional()
  @IsIn(CAMERA_MOVES, {
    message: `cameraMove must be one of: ${CAMERA_MOVES.join(', ')}`,
  })
  cameraMove?: CameraMove;

  /**
   * Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67). Тот же принцип,
   * что у voiceMode/cameraMove: неизвестное значение отвергается.
   */
  @IsOptional()
  @IsIn(SUBTITLES_MODES, {
    message: `subtitlesMode must be one of: ${SUBTITLES_MODES.join(', ')}`,
  })
  subtitlesMode?: SubtitlesMode;

  /** Пресетная тема оформления субтитров — значима только при subtitlesMode: 'on'. */
  @IsOptional()
  @IsIn(SUBTITLE_THEMES, {
    message: `subtitleTheme must be one of: ${SUBTITLE_THEMES.join(', ')}`,
  })
  subtitleTheme?: SubtitleTheme;

  /** Идентификатор голоса у провайдера синтеза; null — голос стенда. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  ttsVoiceId?: string | null;

  /** Модель провайдера синтеза; null — модель стенда. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  ttsModel?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Validate(IsJsonObject)
  filters?: JsonObject | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Validate(IsJsonObject)
  effects?: JsonObject | null;
  /**
   * Этап G (ТЗ Greeting 2.0 §4.7): личный бренд-бук. Меняется только при
   * создании — сервис отвергает смену вида у существующего (личный
   * бренд-бук, ставший корпоративным, ушёл бы на аукцион с лицом автора).
   * PERSONAL требует персону автора и включённый режим; `personaId`
   * сервер ставит сам.
   */
  @IsOptional()
  @IsIn(BRAND_MANIFEST_KINDS)
  kind?: BrandManifestKind;

  /** Образ персоны по умолчанию («Я в кадре»); только у PERSONAL. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 64)
  defaultLookId?: string | null;

  /** Подпись «от кого» по умолчанию — той же длины, что `senderName` брифа. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  signature?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn([...GREETING_TONES])
  defaultTone?: GreetingTone | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => CardStyleDto)
  cardStyle?: CardStyleDto | null;
}
