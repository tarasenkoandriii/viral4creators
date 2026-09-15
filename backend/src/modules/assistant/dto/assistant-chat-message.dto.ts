import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Одна реплика в `messages` (ТЗ §4.3): роль только `user`/`assistant` —
 * `assistant` пускается в DTO, потому что клиент отправляет назад
 * СВОЮ ЖЕ историю (эхо прошлых ответов виджета), а не потому что
 * посетитель может представиться моделью. Лимит длины разный по роли
 * (600 у пользователя, 2000 у эха ассистента) проверяется отдельно в
 * `AssistantChatRequestDto.messages` — здесь общий верхний потолок 2000,
 * чтобы сам класс валидировался независимо от контекста.
 */
export class AssistantChatMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;
}
