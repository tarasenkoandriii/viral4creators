import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Выбор музыкальной подложки (фича №4). `null` — снять подложку;
 * отсюда `@ValidateIf`, а не один `@IsOptional` (тот пропустил бы
 * строку мимо проверок вместе с `null`).
 */
export class GreetingMusicRequestDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  themeId?: string | null;
}

/**
 * Форматы своей музыки. Тот же короткий список, что у образцов голоса
 * (`user-voices`): всё, что умеют браузерные рекордеры и обычные
 * плееры, и ничего, что потребовало бы отдельной ветки у ffmpeg.
 */
export const MUSIC_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
] as const;

/** 20 МБ — это примерно три минуты mp3 приличного качества. Подложке
 * под пятнадцатисекундный ролик больше не нужно, а платить за хранение
 * чужих альбомов продукт не обязан. */
export const MAX_MUSIC_BYTES = 20 * 1024 * 1024;

export class GreetingMusicUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(MAX_MUSIC_BYTES)
  fileSize!: number;

  @IsString()
  @IsIn(MUSIC_MIME_TYPES as unknown as string[])
  mimeType!: string;
}

export class GreetingMusicConfirmRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^sessions\/[^/]+\/music\/[A-Za-z0-9_-]+\.[a-z0-9]{1,5}$/, {
    message: 'pathname должен быть путём, выданным music/upload-url',
  })
  pathname!: string;

  @IsString()
  @MaxLength(80)
  title!: string;

  /**
   * Подтверждение прав на трек.
   *
   * Не формальность: ролик человек отправляет другому человеку, и
   * чужая фонограмма в нём — это распространение, а не личное
   * прослушивание. Тот же гейт и по той же причине, что согласие на
   * клонирование голоса (`VoiceCloneRequestDto.consent`).
   */
  @IsBoolean()
  rightsConfirmed!: boolean;
}

/**
 * Ссылка на трек, права на который есть у пользователя.
 *
 * Дешёвая альтернатива загрузке: файл остаётся у себя, мы храним
 * только ссылку. Проверка ссылки — `userTrackUrl`
 * (`common/greeting-music.ts`), она строже каталожной.
 */
export class GreetingMusicLinkRequestDto {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsString()
  @MaxLength(80)
  title!: string;

  /** Тот же гейт и та же причина, что у загрузки файла. */
  @IsBoolean()
  rightsConfirmed!: boolean;
}

/**
 * Взять трек из библиотеки со свободной лицензией. `query` шлётся
 * вместе с идентификаторами не для красоты: сервер ищет кандидата тем
 * же запросом, а не берёт URL из тела, — иначе клиент мог бы заставить
 * его скачать что угодно откуда угодно.
 */
export class GreetingMusicLibraryRequestDto {
  @IsString()
  @MaxLength(100)
  query!: string;

  @IsString()
  @MaxLength(32)
  provider!: string;

  @IsString()
  @MaxLength(128)
  providerTrackId!: string;
}
