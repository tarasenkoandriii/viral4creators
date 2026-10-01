/** Тела маршрутов песочницы (K3). Лишнее поле — 400 (forbidNonWhitelisted). */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { SANDBOX_LIMITS } from '../../config/assist-defaults';

export class SandboxUrlDto {
  @IsString()
  @IsNotEmpty({ message: 'Укажите адрес сайта' })
  @MaxLength(2048)
  url!: string;
}

export class SandboxChatDto {
  @IsString()
  @IsNotEmpty({ message: 'Задайте вопрос' })
  @MaxLength(SANDBOX_LIMITS.maxQuestionChars, {
    message: `Вопрос — не длиннее ${SANDBOX_LIMITS.maxQuestionChars} символов`,
  })
  question!: string;
}
