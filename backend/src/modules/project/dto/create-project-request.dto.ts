import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { ProjectType } from '../../../common/types/project.types';

/**
 * POST /projects — spec §4 Экран 1.
 *
 * No `currency` field on purpose: it is derived from `countryCode` on the
 * server (spec §7.2, decided — no manual override in v1). Sending one is
 * rejected by the global ValidationPipe's forbidNonWhitelisted.
 */
export class CreateProjectRequestDto {
  @IsIn(['SINGLE', 'LINE', 'CLIENT_SITE'], {
    message:
      'type must be SINGLE (один товар), LINE (линейка) or CLIENT_SITE (сайт заказчика)',
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
   * `SINGLE`/`LINE` поле по-прежнему обязательно, и это проверяет
   * сервис, а не декоратор: на уровне DTO выразить «обязателен, если
   * тип такой-то» ценой одной строки нельзя.
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
}
