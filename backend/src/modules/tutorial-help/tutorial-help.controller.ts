/**
 * GET /tutorial-help/:subjectKey — справка по теме мастера.
 *
 * Без входа и без данных пользователя, как `GET /greeting/policy`: это
 * каталог продукта, а не чьи-то данные. Ключ темы и язык — всё, что
 * нужно; кто спрашивает, здесь не важно.
 *
 * `?theme=light|dark` — необязательное пожелание темы ролика (лендинг
 * со светлой/тёмной страницей). Неизвестное значение молча
 * игнорируется, а не даёт 400: ответ кешируется публично, и опечатка в
 * параметре не должна стоить посетителю справки.
 */

import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { TutorialHelpService, TutorialHelpView } from './tutorial-help.service';

@Controller('tutorial-help')
export class TutorialHelpController {
  constructor(private readonly help: TutorialHelpService) {}

  @Get(':subjectKey')
  // Пять минут: ролик и текст меняются релизом и вычиткой оператора, а
  // не ежеминутно. Тот же срок, что у таблицы правил поздравления.
  @Header('Cache-Control', 'public, max-age=300')
  get(
    @Param('subjectKey') subjectKey: string,
    @Query('locale') locale?: string,
    @Query('theme') theme?: string,
  ): Promise<TutorialHelpView> {
    return this.help.get(subjectKey, locale, theme);
  }
}
