/**
 * Настройки глобальной валидации — одни на приложение и на тесты маршрутов
 * (тот же приём, что backend/src/common/validation-pipe.ts: копия настроек
 * в тесте проверяла бы саму себя).
 */

import { ValidationPipeOptions } from '@nestjs/common';

export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  /** Поля вне DTO отбрасываются… */
  whitelist: true,
  /** …и не молча: лишнее поле — отказ. */
  forbidNonWhitelisted: true,
  /** Тело превращается в экземпляр DTO — нужно для вложенных структур. */
  transform: true,
};
