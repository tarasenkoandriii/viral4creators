import { IsOptional, IsString, Length } from 'class-validator';

/**
 * POST /tts/preview (ТЗ §15.3, этап 36) — послушать голос до генерации.
 *
 * Потолок в 300 символов не технический, а смысловой: проба это фраза, а
 * не сценарий. Пустить сюда полный текст озвучки значило бы дать способ
 * синтезировать ролик бесплатно в обход счётчика генераций — а платит за
 * символы всё равно владелец.
 */
export const PREVIEW_MAX_CHARACTERS = 300;

export class PreviewVoiceRequestDto {
  @IsString()
  @Length(1, PREVIEW_MAX_CHARACTERS, {
    message: `Текст пробы — от 1 до ${PREVIEW_MAX_CHARACTERS} символов`,
  })
  text!: string;

  /** Голос; пусто — голос по умолчанию стенда. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  voiceId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  model?: string;
}
