import { IsIn, IsString, Length, ValidateIf } from 'class-validator';
import {
  GREETING_PRESENTER_VARIANTS,
  GreetingPresenterVariant,
} from '../../../common/types/greeting.types';

/**
 * «Кто в кадре» в брифе поздравления (этап G, ТЗ Greeting 2.0 §4.8):
 * `{ kind: 'ai' }` или `{ kind: 'persona', lookId, variant }`.
 *
 * Одним классом, а не объединением: class-validator не различает ветви
 * по дискриминатору, поэтому поля образа обязательны только при
 * `kind: 'persona'` (`ValidateIf`). Лишние поля при `ai` отвергает
 * глобальный `forbidNonWhitelisted` только если их нет в классе — здесь
 * они есть, поэтому сервис игнорирует их при `ai` (`resolvePresenterChoice`).
 * Принадлежность, готовность образа и режим `PERSONA_ENABLED` проверяет
 * сервис — DTO про это не знает.
 */
export class GreetingPresenterDto {
  @IsIn(['ai', 'persona'])
  kind!: 'ai' | 'persona';

  @ValidateIf((o: GreetingPresenterDto) => o.kind === 'persona')
  @IsString()
  @Length(1, 64)
  lookId!: string;

  @ValidateIf((o: GreetingPresenterDto) => o.kind === 'persona')
  @IsIn([...GREETING_PRESENTER_VARIANTS])
  variant!: GreetingPresenterVariant;
}
