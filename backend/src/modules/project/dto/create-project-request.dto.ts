import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { ProjectType } from '../../../common/types/project.types';
import type {
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingResolution,
  GreetingTone,
} from '../../../common/types/greeting.types';
import {
  GREETING_OCCASIONS,
  GREETING_TONES,
} from '../../../common/types/greeting.types';

/**
 * POST /projects/:id/greeting-brief и вложенный `greetingBrief` в
 * CreateProjectRequestDto (ТЗ TZ-Greeting-Video-Project-Type.md §4.1).
 *
 * `presenterProvider`/`resolution` здесь — то, что ПОПРОСИЛ пользователь;
 * сервис перепроверяет их против тарифа (`resolveGreetingConfig`, §7) —
 * DTO не гарантирует итоговое значение.
 */
export class CreateGreetingBriefDto {
  /**
   * Список берётся из `GREETING_OCCASIONS`, а не переписывается строками:
   * до этапа 2 здесь лежала своя копия семи значений, и расширение enum
   * до 24 поводов молча отвергало бы 17 новых на уровне валидации DTO —
   * фича выглядела бы сломанной, хотя база и сервис её уже понимают.
   */
  @IsIn([...GREETING_OCCASIONS])
  occasion!: GreetingOccasion;

  @ValidateIf((o: CreateGreetingBriefDto) => o.occasion === 'OTHER')
  @IsString()
  @Length(1, 200)
  customOccasionText?: string;

  @IsString()
  @Length(1, 120, {
    message: 'recipientName must be between 1 and 120 characters',
  })
  recipientName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  senderName?: string;

  @IsOptional()
  @IsIn([...GREETING_TONES])
  tone?: GreetingTone;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  personalMessage?: string;

  @IsOptional()
  @IsIn(['grok', 'hedra'])
  presenterProvider?: GreetingPresenterProvider;

  @IsOptional()
  @IsIn(['480p', '720p', '1080p'])
  resolution?: GreetingResolution;

  @IsOptional()
  @IsString()
  brandManifestId?: string;

  @IsOptional()
  @IsDateString()
  occasionDate?: string;
}

/**
 * POST /projects — spec §4 Экран 1.
 *
 * No `currency` field on purpose: it is derived from `countryCode` on the
 * server (spec §7.2, decided — no manual override in v1). Sending one is
 * rejected by the global ValidationPipe's forbidNonWhitelisted.
 */
export class CreateProjectRequestDto {
  @IsIn(['SINGLE', 'LINE', 'CLIENT_SITE', 'GREETING_VIDEO'], {
    message:
      'type must be SINGLE (один товар), LINE (линейка), CLIENT_SITE (сайт заказчика) or GREETING_VIDEO (ролик-поздравление)',
  })
  type!: ProjectType;

  @IsString()
  @Length(1, 120, { message: 'title must be between 1 and 120 characters' })
  title!: string;

  /**
   * ISO 3166-1 alpha-2; validated against the reference list in the service.
   *
   * Необязателен с этапа 115 — но только по смыслу для `CLIENT_SITE`
   * (§4.1 doc/CLIENT-SITE-TUTORIAL-SPEC.md): у проекта «сайт заказчика»
   * нет ни товара, ни цены, и спрашивать страну на первом экране значит
   * поставить лишний шаг перед тем, ради чего человек пришёл. Колонка в
   * БД остаётся NOT NULL: сервер подставляет страну последнего проекта
   * пользователя, а для первого — платформенный дефолт. Для
   * `SINGLE`/`LINE`/`GREETING_VIDEO` (§4.2 ТЗ поздравлений: оплата за
   * генерацию всё равно происходит) поле по-прежнему обязательно, и это
   * проверяет сервис, а не декоратор: на уровне DTO выразить «обязателен,
   * если тип такой-то» ценой одной строки нельзя.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'countryCode must be a 2-letter ISO 3166-1 code, e.g. "UA"',
  })
  countryCode?: string;

  /** Optional link to a Brand Manifest (spec §12); must belong to the caller. */
  @IsOptional()
  @IsString()
  brandManifestId?: string;

  /**
   * Обязателен, если type === 'GREETING_VIDEO' — проверка в сервисе, а
   * не декоратором (§4.1 ТЗ поздравлений, тот же приём, что countryCode
   * выше). Игнорируется для остальных трёх типов.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateGreetingBriefDto)
  greetingBrief?: CreateGreetingBriefDto;
}
