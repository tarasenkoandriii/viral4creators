/**
 * Проверка секрета крона — одно место вместо трёх копий (этап 54, Б-3.3).
 *
 * ## Почему без секрета маршрут ЗАКРЫТ, а не открыт
 *
 * Первая версия проверяла `if (cronSecret && …)`: не задана переменная —
 * маршрут публичный. Задумано «чтобы локально работало curl-ом», а по
 * факту это fail-open на маршруте, который необратимо удаляет файлы: одна
 * забытая переменная на новом стенде — и метлу может дёрнуть любой, кто
 * угадает адрес. Этап 38 закрыл это только в документации («задать
 * обязательно»), код остался прежним; второй аудит это отметил (Б-3.3),
 * третий подтвердил, что ничего не изменилось.
 *
 * Теперь правило обратное: нет секрета — нет доступа. Единственное
 * исключение — dev-стенд, и определяется он не отсутствием переменной, а
 * теми же двумя предохранителями, что открывают dev-вход в админку
 * (`ALLOW_DEV_AUTH=true` и `NODE_ENV !== 'production'`): случайно
 * оказаться в этом состоянии на проде нельзя, платформа сама ставит
 * `NODE_ENV=production`.
 *
 * ## Почему сравнение constant-time
 *
 * `!==` на строках останавливается на первом несовпавшем символе, и по
 * времени ответа секрет можно подбирать посимвольно. На практике сетевой
 * шум это прячет, но `timingSafeEqual` стоит одну строку, а спор о том,
 * «достаточно ли шума», — дороже.
 *
 * ## Почему маршруты остаются GET
 *
 * Vercel Cron вызывает адреса только GET-ом — это ограничение платформы,
 * а не выбор. Опасность GET («сработает от префетча и краулера») снята
 * самим требованием секрета: без заголовка `Authorization` ни браузер, ни
 * краулер его не пришлют.
 */

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { isDevAuthAllowed } from '../admin-auth/dev-login';

export interface CronSecretEnv {
  CRON_SECRET?: string;
  ALLOW_DEV_AUTH?: string;
  NODE_ENV?: string;
  [key: string]: string | undefined;
}

/**
 * Бросает, если запрос не имеет права запускать крон. Ничего не
 * возвращает: у вызывающего кода после этой строки сомнений быть не должно.
 */
export function assertCronSecret(
  authHeader: string | undefined,
  env: CronSecretEnv = process.env,
): void {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    if (isDevAuthAllowed(env)) return;
    // 503, а не 401: клиент ни в чём не виноват, это стенд настроен
    // не до конца. В админке та же переменная показана предупреждением.
    throw new ServiceUnavailableException(
      'CRON_SECRET не задан — крон-маршруты закрыты, пока переменная не появится',
    );
  }
  const presented = bearerToken(authHeader);
  if (!presented || !safeEqual(presented, secret)) {
    throw new UnauthorizedException('Неверный или отсутствующий секрет крона');
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/** Длины разные — сравнение всё равно делается, но над буферами равной
 * длины, чтобы ранний выход по длине не выдавал длину секрета. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
