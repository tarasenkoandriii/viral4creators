/**
 * Только куки сайта заказчика — Ш0.5 аудита
 * docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md (риск В-1).
 *
 * Реле живого входа снимает `Network.getAllCookies` со ВСЕГО контекста
 * браузера, разведчик — тоже весь jar страницы. При входе через Google
 * или Facebook туда попадает живая сессия заказчика у SSO-провайдера, и
 * до этой правки она уезжала в нашу БД (`cookiesEnc`) вместе с кукой
 * самого сайта. Для обучалки она не нужна вовсе: раунд открывает сайт
 * заказчика, а не аккаунт Google; а хранить её значит держать у себя
 * ключ ко всей почте и документам человека.
 *
 * Правило — тот же «сайт», что у доменного замка (`draft-rounds.ts`,
 * §8.1): регистрируемый домен (eTLD+1, с приватной частью списка
 * суффиксов). Кука `.shop.com` или `auth.shop.com` при базе
 * `www.shop.com` остаётся; `.google.com`, `.facebook.com`, куки
 * аналитики и рекламы — отбрасываются. Кука на общий суффикс платформы
 * (`.github.io`, `.myshopify.com`) — тоже: это не «сайт заказчика», а
 * все сайты сразу.
 *
 * Решение по SSO принято по рекомендации аудита (вопрос 5, «да,
 * отбрасываем»): сборка ролика для SSO-входа после этого держится на
 * куке САЙТА, которую SSO выдал при входе; когда она истечёт, нужен
 * свежий живой вход.
 */

import type { CdpCookie } from '../../common/cookie-jar';
import { registrableDomain } from './draft-rounds';

export interface FirstPartyCookies {
  kept: CdpCookie[];
  /** Сколько отброшено — для лога (числом, без доменов). */
  dropped: number;
}

/** Хост, к которому относится кука: без ведущей точки, в нижнем регистре. */
function cookieHost(domain: string): string {
  return domain.trim().replace(/^\./, '').toLowerCase();
}

export function isFirstPartyCookie(
  cookie: Pick<CdpCookie, 'domain'>,
  baseUrl: string,
): boolean {
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = cookieHost(cookie.domain ?? '');
  if (!host) return false;
  const baseSite = registrableDomain(baseHost);
  const cookieSite = registrableDomain(host);
  // Без регистрируемого домена (IP, localhost, общий суффикс платформы)
  // — только точное совпадение хоста: «соседей» у такого адреса нет.
  if (baseSite === null || cookieSite === null) return host === baseHost;
  return baseSite === cookieSite;
}

export function firstPartyCookies(
  cookies: readonly CdpCookie[],
  baseUrl: string,
): FirstPartyCookies {
  const kept = cookies.filter((c) => isFirstPartyCookie(c, baseUrl));
  return { kept, dropped: cookies.length - kept.length };
}
