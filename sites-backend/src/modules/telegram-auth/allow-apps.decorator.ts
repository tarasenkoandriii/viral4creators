/**
 * Какие приложения пускает маршрут — объявляется ЯВНО на каждом маршруте
 * (или контроллере). `TelegramIdentityGuard` глобальный, и маршрут без
 * объявления закрыт: забытый декоратор — это 403 в первом же тесте, а не
 * маршрут, открытый initData «не того» бота (ТЗ помощника §4.1).
 *
 *  - `@AllowApps('any')` — кабинетные маршруты ядра `site-core` (оба бота);
 *  - `@AllowApps('assist')` / `@AllowApps('qa')` — маршруты продукта;
 *  - `@PublicRoute('причина')` — без Telegram вообще: `/health`, вебхуки
 *    ботов (у них свой секрет), публичные маршруты виджета (свой гвард).
 *
 * Метод переопределяет контроллер (`getAllAndOverride`).
 */

import { SetMetadata } from '@nestjs/common';
import { TELEGRAM_APPS } from '../../brand';
import type { AppScope } from './identity';

export const ALLOW_APPS_KEY = 'sites:allow-apps';
export const PUBLIC_ROUTE_KEY = 'sites:public-route';

const KNOWN_SCOPES: readonly string[] = [...TELEGRAM_APPS, 'any'];

export function AllowApps(...scopes: AppScope[]) {
  // Пустой список и опечатка ловятся при загрузке модуля, а не на запросе:
  // `@AllowApps()` читался бы как «пускаю всех» или «никого» — смотря кто
  // читает.
  if (scopes.length === 0) {
    throw new Error('@AllowApps(): укажите хотя бы одно приложение или any');
  }
  for (const s of scopes) {
    if (!KNOWN_SCOPES.includes(s)) {
      throw new Error(`@AllowApps(): неизвестное приложение «${String(s)}»`);
    }
  }
  return SetMetadata(ALLOW_APPS_KEY, [...scopes]);
}

/**
 * Маршрут без идентичности Telegram. Причина обязательна — чтобы каждое
 * такое место было видно грепом и в ревью (как `SitesDb.system`).
 */
export function PublicRoute(reason: string) {
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new Error('@PublicRoute(): укажите причину, почему маршрут открыт');
  }
  return SetMetadata(PUBLIC_ROUTE_KEY, reason);
}
