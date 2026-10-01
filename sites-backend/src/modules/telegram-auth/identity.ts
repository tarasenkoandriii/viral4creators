/**
 * Контракт идентичности запроса для модулей sites-backend (Э0).
 *
 * Зафиксирован координатором ДО реализации, чтобы ядро сайтов (агент B)
 * и авторизация двух ботов (агент C) писались параллельно. Реализацию —
 * гвард, проверку initData токеном именно своего бота, выбор бота по
 * заголовку `X-Telegram-App` — делает модуль `telegram-auth`.
 */
import type { Request } from 'express';
import type { TelegramApp } from '../../brand';

/** Кто пришёл: проверенный пользователь Telegram конкретного приложения. */
export interface RequestIdentity {
  /** Приложение, initData которого проверена (бот помощника или QA). */
  app: TelegramApp;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  languageCode: string | null;
}

export type IdentifiedRequest = Request & { identity: RequestIdentity };

/**
 * Какие приложения пускает маршрут: кабинетные маршруты ядра (`/sites/*`)
 * принимают оба, продуктовые — только своё (ТЗ помощника §4.1).
 */
export type AppScope = TelegramApp | 'any';
