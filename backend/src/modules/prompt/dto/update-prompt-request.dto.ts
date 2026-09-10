/**
 * Update Prompt Request DTO
 *
 * Validation for prompt update requests
 */

import { IsString, IsNotEmpty, IsOptional, Length } from 'class-validator';

/**
 * Request body for PATCH /sessions/:sessionId/prompt
 */
export class UpdatePromptRequestDto {
  /**
   * User's edited prompt text
   * Must be between 1 and 5000 characters
   */
  @IsString()
  @IsNotEmpty({ message: 'Edited text is required' })
  @Length(1, 5000, {
    message: 'Prompt must be between 1 and 5000 characters',
  })
  editedText!: string;

  /**
   * Текст озвучки (ТЗ §15.2, этап 35). Отдельное поле, а не часть
   * промпта: это разные тексты для разных читателей — промпт читает
   * Veo, реплики читает синтезатор. Не передан — прежний текст остаётся,
   * иначе правка промпта молча стирала бы выверенные реплики.
   *
   * Потолок тот же, что у провайдера синтеза (5000 символов): принять
   * больше значило бы молча обрезать текст уже при озвучке.
   */
  @IsOptional()
  @IsString()
  @Length(0, 5000, {
    message: 'Текст озвучки не должен превышать 5000 символов',
  })
  voiceoverScript?: string;
}
