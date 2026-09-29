/**
 * GET /greeting/policy — вся таблица правил ролика по регистрам и поводам
 * (этап B ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.1).
 *
 * Публичный и без параметров: данных пользователя в нём нет, это каталог.
 * Нужен интерфейсу (этап D), чтобы строить выбор тонов, наклеек, музыки и
 * числа сцен из той же таблицы, что проверяет сервер, — а не из своей
 * копии во фронтенде, которая однажды разойдётся (как уже разошёлся лимит
 * длины повода, Г-11).
 */

import { Controller, Get, Header } from '@nestjs/common';
import {
  GreetingPolicyView,
  greetingPolicyView,
} from '../../common/greeting-policy';

@Controller('greeting/policy')
export class GreetingPolicyController {
  @Get()
  // Таблица меняется только релизом — кешировать её можно смело.
  @Header('Cache-Control', 'public, max-age=300')
  get(): GreetingPolicyView {
    return greetingPolicyView();
  }
}
