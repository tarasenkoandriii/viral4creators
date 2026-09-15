import { IsOptional, IsString, Length } from 'class-validator';

/**
 * POST /sessions/:sessionId/postprod/revoice (доп. запрос владельца
 * продукта, этап 87) — переозвучить уже готовый ролик без повторной
 * генерации у Veo/Grok.
 *
 * Голос (`ttsVoiceId`/провайдер) правится отдельно, существующим
 * `PATCH /sessions/:id/brand-manifest` — вызывается ДО этого маршрута,
 * если пользователь выбрал другой голос; сам этот DTO меняет только
 * текст реплик.
 */
export class ReVoiceRequestDto {
  /**
   * Новый текст реплик — тот же потолок, что у provайдера синтеза и у
   * `UpdatePromptRequestDto.voiceoverScript` (5000 символов). Не
   * передан — переозвучка идёт с текущим текстом из промпта (например,
   * когда меняли только голос).
   */
  @IsOptional()
  @IsString()
  @Length(0, 5000, {
    message: 'Текст озвучки не должен превышать 5000 символов',
  })
  voiceoverScript?: string;
}
