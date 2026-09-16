import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { SUPPORTED_LOCALES } from '../../../common/locale';
import { AssistantChatMessageDto } from './assistant-chat-message.dto';

/** ТЗ §4.3: 1..600 у последней (user), до 2000 у эха ассистента, ≤ 6000 суммарно. */
const USER_CONTENT_MAX = 600;
const TOTAL_CONTENT_MAX = 6000;

@ValidatorConstraint({ name: 'AssistantMessagesShape', async: false })
class AssistantMessagesShapeConstraint implements ValidatorConstraintInterface {
  private failure = '';

  validate(messages: unknown): boolean {
    if (!Array.isArray(messages) || messages.length === 0) {
      this.failure = 'messages must be a non-empty array';
      return false;
    }
    const last = messages[messages.length - 1] as
      | { role?: string; content?: string }
      | undefined;
    if (last?.role !== 'user') {
      this.failure = 'the last message must have role "user"';
      return false;
    }
    let total = 0;
    for (const m of messages as Array<{ role?: string; content?: string }>) {
      const len = m.content?.length ?? 0;
      total += len;
      if (m.role === 'user' && len > USER_CONTENT_MAX) {
        this.failure = `user message content must be at most ${USER_CONTENT_MAX} characters`;
        return false;
      }
    }
    if (total > TOTAL_CONTENT_MAX) {
      this.failure = `combined message content must be at most ${TOTAL_CONTENT_MAX} characters`;
      return false;
    }
    return true;
  }

  defaultMessage(): string {
    return this.failure || 'invalid messages';
  }
}

/**
 * POST /assistant/chat (ТЗ §4.3). `page`/`triggeredBy` — только для
 * аналитики (§10) и подсказок, не влияют на валидность сами по себе.
 */
export class AssistantChatRequestDto {
  @IsIn(SUPPORTED_LOCALES)
  locale!: string;

  // Найдено доп. аудитом: обучалка выросла до 10 шагов (этап 92, десятый
  // — «Постпродакшн»), а этот предел остался от старой девятишаговой
  // версии — POST с stepId:10 (легитимный для последнего шага) отклонялся
  // ValidationPipe'ом ещё до контроллера. Верхняя граница здесь обязана
  // совпадать с проверками в assistant.service.ts и actions.ts (обе — 10).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  stepId?: number;

  @IsIn(['home', 'how-it-works'])
  page!: 'home' | 'how-it-works';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AssistantChatMessageDto)
  @Validate(AssistantMessagesShapeConstraint)
  messages!: AssistantChatMessageDto[];

  @IsOptional()
  @IsIn(['user', 'proactive'])
  triggeredBy?: 'user' | 'proactive';
}
