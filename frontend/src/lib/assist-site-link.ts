/**
 * Привязка обучалки к сайту ИИ-помощника (Э6 помощника, ТЗ помощника
 * §4.11): экран «Видео» TMA помощника открывает Mini App генератора
 * deep-link'ом `t.me/<бот>/app?startapp=cst_<siteId>` (в браузере —
 * `?assistSite=<siteId>`). Здесь — только запомнить id сайта до первого
 * раунда визарда и открыть форму нового проекта с типом «сайт заказчика»;
 * саму привязку после `/explore` делает `ProjectCreateScreen`, а сервер
 * проверяет её во внутреннем API sites-backend (человек — владелец или
 * менеджер помощника этого сайта). Чужой id здесь ничего не даёт.
 *
 * sessionStorage, а не localStorage: намерение «снять обучение для этого
 * сайта» живёт, пока открыт этот запуск, и не должно привязать следующий,
 * никак не связанный проект через неделю.
 */

const KEY = 'assistSiteLink';
/** Префикс `startapp` (тот же, что `GENERATOR_SITE_TUTORIAL_START` sites-backend). */
export const ASSIST_SITE_START_PREFIX = 'cst_';
const SITE_ID = /^[A-Za-z0-9_-]{1,59}$/;

/** id сайта из адреса запуска: `?assistSite=` или `tgWebAppStartParam=cst_…`. */
export function assistSiteFromLaunch(
  search: string,
  hash: string
): string | null {
  const q = new URLSearchParams(search).get('assistSite');
  if (q && SITE_ID.test(q)) return q;
  const start = new URLSearchParams(hash.replace(/^#/, '')).get(
    'tgWebAppStartParam'
  );
  if (start?.startsWith(ASSIST_SITE_START_PREFIX)) {
    const id = start.slice(ASSIST_SITE_START_PREFIX.length);
    if (SITE_ID.test(id)) return id;
  }
  return null;
}

/**
 * Зовётся при старте ДО очистки служебного hash'а Telegram (как код
 * приглашения). `true` — пришли по ссылке помощника: вызывающий откроет
 * форму нового проекта обучалки.
 */
export function captureAssistSiteLink(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const id = assistSiteFromLaunch(
      window.location.search,
      window.location.hash
    );
    if (!id) return false;
    window.sessionStorage.setItem(KEY, id);
    return true;
  } catch {
    // Хранилище недоступно — обучалка просто не привяжется сама.
    return false;
  }
}

export function pendingAssistSite(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.sessionStorage.getItem(KEY);
    return v && SITE_ID.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function clearPendingAssistSite(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // см. выше
  }
}

/** Адрес формы нового проекта обучалки (тип выбран, `?entry=` — как у лендинга). */
export function assistSiteEntryUrl(pathname: string): string {
  return `${pathname}?entry=site-tutorial#/projects/new`;
}
