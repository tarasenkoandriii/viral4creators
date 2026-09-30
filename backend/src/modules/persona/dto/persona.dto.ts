import {
  Equals,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SUPPORTED_LOCALES } from '../../../common/locale';
import {
  PERSONA_LIVENESS_MIME_TYPES,
  PERSONA_SELFIE_MIME_TYPES,
  PersonaLivenessMime,
  PersonaSelfieMime,
} from '../persona-rules';

/**
 * `POST /personas` — согласие до камеры (§4.1 п.1). `consent` обязан быть
 * именно `true`: галочка, а не отсутствие возражений.
 *
 * Типы файлов необязательны (контракт волны — `{ consent, consentTextVersion }`):
 * без них ссылки выдаются под JPEG и webm. iOS пишет ролик в mp4 — такой
 * клиент передаёт `livenessMimeType: 'video/mp4'`, иначе хранилище
 * откажет в загрузке по Content-Type.
 */
export class CreatePersonaDto {
  @IsBoolean()
  @Equals(true, { message: 'Нужно согласие' })
  consent!: boolean;

  @IsString()
  @MaxLength(32)
  consentTextVersion!: string;

  /** Локаль текста, который человек видел — сохраняется вместе с согласием. */
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES)
  locale?: string;

  @IsOptional()
  @IsIn(PERSONA_SELFIE_MIME_TYPES)
  selfieMimeType?: PersonaSelfieMime;

  @IsOptional()
  @IsIn(PERSONA_LIVENESS_MIME_TYPES)
  livenessMimeType?: PersonaLivenessMime;
}
