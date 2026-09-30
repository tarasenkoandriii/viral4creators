import { Transform } from 'class-transformer';
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
  MinLength,
} from 'class-validator';

/**
 * Presigned-Blob поток, тот же приём, что у фото персонажа/сцены бренда
 * (`brand-manifest/dto/character-photo.dto.ts`) и сцен-референсов
 * (`reference-assets/dto/reference-assets.dto.ts`) — здесь тело записи
 * голоса вместо изображения.
 *
 * Образец уходит в Resemble ссылкой (`dataset_url`,
 * `ResembleService.cloneVoice`). Документация Resemble называет для
 * образца «Single WAV file (≥10 seconds)», длина «10 seconds – 3 minutes»
 * (docs.resemble.ai/voice-creation/voices/clone-overview) — поэтому
 * клиент с 30.09.2026 перекодирует запись в WAV в браузере
 * (frontend/src/lib/voice-sample.ts). Остальные типы — запасной путь,
 * когда браузер не смог декодировать запись: mp3/m4a — обычные форматы
 * готового файла, webm — запись MediaRecorder как есть. ogg/aac сюда
 * НЕ добавлены: Resemble их не называет, а браузер, который их записал
 * или открыл, их же и декодирует в WAV.
 */
const ALLOWED_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/webm',
] as const;

/**
 * Синонимы одного контейнера → тип из списка. Та же таблица —
 * `MIME_ALIASES` в frontend/src/lib/voice-sample.ts (сверяет тест
 * фронтенда): клиент нормализует тип так же, и PUT в Blob идёт ровно с
 * тем Content-Type, под который подписан адрес.
 */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
};

/**
 * `audio/webm;codecs=opus` → `audio/webm`, регистр — нижний, синонимы —
 * к типу из списка. Прод-дефект 30.09.2026: Telegram Android присылал тип
 * с параметром кодека, `@IsIn` сверял строку целиком и отвечал английским
 * «mimeType must be one of…». Нормализация — ДО проверки (`@Transform`),
 * и дальше (путь, `allowedContentTypes` подписи Blob) идёт уже голый тип.
 */
export function normalizeVoiceSampleMime(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const base = value.split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

export const VOICE_SAMPLE_FORMAT_UNSUPPORTED =
  'Этот формат записи не поддерживается — запишите голос заново или загрузите mp3/wav/m4a';

export class VoiceSampleUploadUrlRequestDto {
  @IsString({ message: 'Не удалось прочитать имя файла записи' })
  @MaxLength(255, { message: 'Слишком длинное имя файла записи' })
  fileName!: string;

  @IsNumber({}, { message: 'Не удалось определить размер записи' })
  @Min(1, { message: 'Запись пустая — запишите голос ещё раз' })
  // 15MB — с большим запасом над «минутой речи» (§5.2б TTS-спека); WAV
  // двух минут, который собирает клиент, — ≈10,6 МБ.
  @Max(15 * 1024 * 1024, {
    message:
      'Запись больше 15 МБ — загрузите запись покороче (до 2 минут) в mp3/wav/m4a',
  })
  fileSize!: number;

  @Transform(({ value }) => normalizeVoiceSampleMime(value))
  @IsString({ message: VOICE_SAMPLE_FORMAT_UNSUPPORTED })
  @IsIn(ALLOWED_MIME_TYPES, { message: VOICE_SAMPLE_FORMAT_UNSUPPORTED })
  mimeType!: string;

  /**
   * Голос персоны «Я в кадре» (ТЗ TZ-Greeting-2.0 §4.6): один на персону,
   * вне лимита клонов — проверка лимита на этом шаге другая.
   */
  @IsOptional()
  @IsBoolean()
  forPersona?: boolean;
}

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
};

export function sampleExtFor(mimeType: string): string {
  const base = normalizeVoiceSampleMime(mimeType);
  return (typeof base === 'string' && EXT_BY_MIME[base]) || 'bin';
}

export class VoiceCloneRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^users\/[^/]+\/voices\/[A-Za-z0-9_-]+\/sample\.[a-z0-9]+$/, {
    message:
      'pathname must be the value returned by the voices/upload-url step (users/<userId>/voices/<id>/sample.<ext>)',
  })
  pathname!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  /**
   * Явное согласие (TODO §3.6.3) — обязательное поле, не отдельная
   * галочка «я прочитал»: запись используется для клонирования голоса,
   * а не просто хранится, и это должно быть подтверждено осознанно на
   * каждый клон, а не один раз в настройках аккаунта.
   */
  @IsBoolean()
  consent!: boolean;

  /** Голос персоны (§4.6) — см. `VoiceSampleUploadUrlRequestDto.forPersona`. */
  @IsOptional()
  @IsBoolean()
  forPersona?: boolean;

  /**
   * Версия фразы согласия, которую человек произнёс первой в записи
   * (`GET /personas/voice-consent-phrase`). Обязательна при
   * `forPersona`: запись со старой фразой — не то согласие, что сейчас
   * действует.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  consentPhraseVersion?: string;
}
