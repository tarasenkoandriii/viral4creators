/**
 * Стоп-лист действий воркера (Э-С Ш3) — общий с голосовым управлением
 * помощника и обучалкой: категории `danger-words` + словарь
 * `assist-ui-core/action-words` (копии `scripts/sync-worker-shared.mjs`).
 *
 * Воркер не исполняет действий над сайтом: клик разрешён только по
 * раскрывашке (меню, вкладка, аккордеон) с видимым именем, не в форме и не
 * отправка, и ни одной категории словаря (оплата, удаление, оформление
 * заказа, отмена, возврат, списание, массовые действия, отправка
 * сообщения, подписка). Переход — только по ссылке своего хоста, без
 * «выйти» и без разрушительных слов в адресе (GET-ссылка «/orders/5/delete»
 * — тоже действие). Вход в учётку — нажатие Enter в поле пароля, не клик.
 */
import { actionKindsFor, paymentPath } from '../shared/action-words';
import { lockHostOf } from '../shared/browser-job-protocol';

export type ClickRefusal = 'form' | 'danger' | 'unnamed';

export function clickRefusal(t: {
  text: string;
  hidden: string | null;
  submit: boolean;
  inForm: boolean;
}): ClickRefusal | null {
  if (t.submit || t.inForm) return 'form';
  const name = `${t.text} ${t.hidden ?? ''}`.trim();
  if (!name) return 'unnamed';
  if (actionKindsFor(t.text).length || actionKindsFor(t.hidden ?? '').length) {
    return 'danger';
  }
  return null;
}

/** «Выход» — словом в тексте или адресе (общий с `write-guard.ts`). */
export const LOGOUT =
  /(?<![\p{L}\p{N}])(logout|log-out|log_out|logoff|signout|sign-out|sign_out|выйти|выход|вийти|вихід)(?![\p{L}\p{N}])/iu;
/** Разрушительное слово в адресе (общий с `write-guard.ts`). */
export const DESTRUCTIVE =
  /(^|[/_.=&?:-])(delete|del|remove|destroy|erase|drop|purge|wipe|cancel|refund|void|deactivate|disable|ban|block|reset|logout|logoff|signout|unsubscribe|truncate|clear|approve|reject|send|publish|import|export|download|archive|unarchive|restore|confirm)([/_.=&?:-]|$)/i;

/**
 * camelCase адреса — на слова через `-` (`/api/deleteOrder` →
 * `/api/delete-Order`, `logoutAll` → `logout-All`): словари выше ищут
 * слово целиком, между разделителями (заход 11, аудит P3-4).
 */
export function splitCamel(s: string): string {
  return s.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1-$2');
}

export type LinkRefusal = 'offhost' | 'logout' | 'danger' | 'scheme';

export function linkRefusal(
  raw: string,
  text: string,
  allowedHosts: readonly string[],
): LinkRefusal | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'scheme';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'scheme';
  if (u.username || u.password) return 'scheme';
  if (!allowedHosts.includes(lockHostOf(u))) return 'offhost';
  const pathQuery = splitCamel(
    decodeURIComponentSafe(`${u.pathname}${u.search}`),
  );
  if (LOGOUT.test(text) || LOGOUT.test(pathQuery)) return 'logout';
  if (DESTRUCTIVE.test(pathQuery) || paymentPath(u.pathname)) return 'danger';
  if (actionKindsFor(text).length) return 'danger';
  return null;
}

/**
 * Раскрывашка, которая на деле — ССЫЛКА (`<a href aria-expanded>`, вкладка
 * `<a role="tab" href>`): клик по ней — переход, и решает тот же стоп-лист,
 * что у ссылок обхода (аудит Ш3: `<a href="/orders/7/delete"
 * aria-expanded="false">Ще</a>` открывался кликом — GET-удаление под
 * сессией учётки). Не переход — `javascript:`, якорь той же страницы,
 * отсутствие `href`: такие клики решает `clickRefusal`.
 */
export function toggleLinkRefusal(
  href: string | null,
  current: string,
  text: string,
  allowedHosts: readonly string[],
): LinkRefusal | null {
  if (!href) return null;
  let u: URL;
  let here: URL;
  try {
    here = new URL(current);
    u = new URL(href, here);
  } catch {
    return 'scheme';
  }
  if (u.protocol === 'javascript:') return null;
  u.hash = '';
  here.hash = '';
  if (u.toString() === here.toString()) return null;
  return linkRefusal(u.toString(), text, allowedHosts);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
