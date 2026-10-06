/**
 * Приглашения на клиенте — «Условно бесплатный Lite» §5.1–5.2, этап 134.
 *
 * ## Откуда приходит код
 *
 * Двумя путями, потому что у продукта два живых варианта:
 *
 *  - **мини-апп** — `tgWebAppStartParam` из служебного hash'а Telegram
 *    (ссылка `t.me/<бот>/app?startapp=r_<код>`);
 *  - **обычный фронтенд** — query-параметр `?ref=<код>`, которым его
 *    подставляет лендинг.
 *
 * Оба разбираются ДО того, как роутер и очистка hash'а уберут их из
 * адреса, — отсюда и вызов в `main.tsx`, рядом с очисткой.
 *
 * ## Почему localStorage
 *
 * Между переходом по ссылке и входом человек проходит мастер, и код
 * обязан пережить это, не будучи никому принадлежащим: до входа
 * привязывать его не к кому. Тот же приём и по тем же причинам, что у
 * `sessionId`. Очистили браузер до входа — приглашение потеряно, и это
 * честный размен: единственная альтернатива — узнавать человека до
 * того, как он представился.
 */

import {
  REFERRAL_START_PREFIX,
  currentStartParam,
  normalizeReferralCode as normalize,
  parseStartParam,
} from './start-param';

const KEY = 'referralCode';

/**
 * Достать код из адреса и запомнить. Зовётся один раз при старте, до
 * очистки hash'а и до первого рендера.
 */
export function captureReferralCode(): void {
  if (typeof window === 'undefined') return;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('ref');
    // `startapp` бывает и составным — `e_<сценарий>__r_<код>` с
    // лендинга; формат и строгий разбор — в `start-param.ts`.
    const fromStart = parseStartParam(currentStartParam()).referralCode;
    const code = normalize(fromQuery) ?? fromStart;
    if (!code) return;
    // Первое касание выигрывает — и на клиенте тоже: человек, открывший
    // вторую ссылку, остаётся за первым пригласившим. Сервер решает то
    // же самое уникальностью, но спорить с ним из интерфейса незачем.
    if (window.localStorage.getItem(KEY)) return;
    window.localStorage.setItem(KEY, code);
  } catch {
    // Приватная вкладка, отключённое хранилище — приглашение просто не
    // запомнится. Ронять из-за этого запуск приложения нельзя.
  }
}

export function storedReferralCode(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalize(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Код применён (или отвергнут сервером) — второй раз не пробуем. */
export function clearReferralCode(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // см. выше
  }
}

/**
 * Ссылка, которой человек делится, — КАНОНИЧЕСКАЯ, на лендинг (§5.1).
 * Собирается из кода на клиенте: серверу незачем знать адрес лендинга,
 * а у стендов он разный.
 */
export function referralLink(code: string, landingUrl: string): string {
  return `${landingUrl.replace(/\/+$/, '')}/r/${code}`;
}

/**
 * `t.me`-вариант той же ссылки — для кнопки «Поделиться» ВНУТРИ
 * Telegram (§5.1): там он уместен и разворачивается карточкой бота, а
 * лендинговая ссылка увела бы человека из мессенджера в браузер и
 * обратно. Имя бота не задано — вариант недоступен, и делимся
 * лендинговой: она работает везде.
 */
export function telegramReferralLink(
  code: string,
  botUsername: string | undefined
): string | null {
  const bot = botUsername?.trim().replace(/^@/, '');
  if (!bot) return null;
  return `https://t.me/${bot}/app?startapp=${REFERRAL_START_PREFIX}${code}`;
}
