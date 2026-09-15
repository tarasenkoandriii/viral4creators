import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** ТЗ §10 — клиентские события виджета, без внешней аналитики. */
export const ASSISTANT_EVENT_KINDS = [
  'open',
  'ask',
  'action_click',
  'close',
  'proactive_shown',
  'proactive_dismissed',
  'proactive_engaged',
] as const;

export const ASSISTANT_TRIGGERS = [
  'step-pause',
  'step-return',
  'plans-dwell',
  'exit-intent',
  'idle-open-panel',
] as const;

export class AssistantEventItemDto {
  @IsIn(ASSISTANT_EVENT_KINDS)
  kind!: (typeof ASSISTANT_EVENT_KINDS)[number];

  /** `open` — 'user' | 'proactive'; `proactive_*` — trigger name. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  detail?: string;
}

/** Батч (§10: «через тот же бэкенд, батч, тот же rate limit»). */
export class AssistantEventBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistantEventItemDto)
  events!: AssistantEventItemDto[];
}
