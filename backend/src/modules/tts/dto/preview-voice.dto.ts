import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

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
  // Доп. запрос владельца продукта: проба репликами оригинала —
  // `text` становится необязательным, когда указан `useOriginalDialogue`
  // (сервер сам достаёт текст из анализа сессии, не от клиента).
  @IsOptional()
  @IsString()
  @Length(1, PREVIEW_MAX_CHARACTERS, {
    message: `Текст пробы — от 1 до ${PREVIEW_MAX_CHARACTERS} символов`,
  })
  text?: string;

  /** Голос; пусто — голос по умолчанию стенда. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  voiceId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  model?: string;

  /** Доп. запрос владельца продукта: явный выбор провайдера для этой
   * пробы, в обход платформенного дефолта — валидируется в
   * контроллере через `isVoiceoverProviderKey`, не здесь (значение из
   * `default-tts-provider.ts`, чтобы не дублировать список ключей). */
  @IsOptional()
  @IsString()
  @Length(1, 20)
  provider?: string;

  /**
   * Доп. запрос владельца продукта — проба голоса репликами
   * ОРИГИНАЛЬНОГО референсного видео (не клонирование его диктора,
   * только текст его реплик, см. доккомментарий
   * `AnalysisService.extractOriginalDialogueSample()`). Требует
   * `sessionId`; `text` в этом случае игнорируется, если оба заданы.
   */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  sessionId?: string;

  @IsOptional()
  @IsBoolean()
  useOriginalDialogue?: boolean;
}
