/**
 * Тела запросов приглашений — этап 134.
 *
 * Валидация здесь простая, но нужная: `main.ts` включает
 * `forbidNonWhitelisted`, то есть лишнее поле в теле — отказ, а не
 * молчаливое игнорирование. Код нормализуется в сервисе
 * (`normalizeCode`), здесь — только форма.
 */

import { ArrayMaxSize, IsArray, IsIn, IsString, Length } from 'class-validator';
import {
  CODE_LENGTH,
  INVITE_EVENT_STEPS,
  type InviteEventStep,
} from '../../../common/referral';

export class VisitDto {
  @IsString()
  @Length(CODE_LENGTH, CODE_LENGTH)
  code!: string;
}

export class ClaimDto {
  @IsString()
  @Length(CODE_LENGTH, CODE_LENGTH)
  code!: string;
}

/**
 * Телеметрия кабинета (§12.2). Батч, а не событие на запрос: экран
 * умеет накопить пару событий, а маршрут анонимный — чем меньше
 * запросов, тем меньше поводов их ограничивать.
 *
 * `@IsIn` по закрытому списку, а не свободная строка: открытый `stepId`
 * в анонимном маршруте означал бы, что писать в нашу таблицу может кто
 * угодно и что угодно.
 */
export class InviteEventsDto {
  @IsArray()
  @ArrayMaxSize(INVITE_EVENT_STEPS.length)
  @IsIn(INVITE_EVENT_STEPS as unknown as string[], { each: true })
  steps!: InviteEventStep[];
}
