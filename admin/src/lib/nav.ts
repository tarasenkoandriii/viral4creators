// Каталог навигации админки — маршруты, подписи и группы отдельно от
// компонента меню (doc/ADMIN-NAV-AUDIT-2026-10-06.md, «Порядок
// внедрения», п. 1).
//
// Группы — по задачам оператора, а не по типу данных: раньше 12 из 30
// ссылок жили в сборной «Системе», и по названию нельзя было угадать,
// где воронка или сценарии обучалки. Теперь «Обзор» (очередь внимания)
// отдельно и первым, остальное — восемь групп по 2–6 пунктов.
//
// Адреса страниц НЕ менялись — только подписи и место в меню. Проверка
// «каждая рабочая страница есть в меню ровно один раз» — в nav.test.ts.

export interface NavLink {
  href: string;
  label: string;
}

export interface NavGroup {
  /** Стабильный ключ: id DOM-узла и ключ запомненного раскрытия. */
  key: string;
  label: string;
  links: NavLink[];
}

export const OVERVIEW_LINK: NavLink = { href: '/', label: 'Обзор' };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'people',
    label: 'Работа с пользователями',
    links: [
      { href: '/sessions', label: 'Сессии' },
      { href: '/users', label: 'Пользователи' },
    ],
  },
  {
    // Внутри — сначала очереди решений, затем справочники.
    key: 'moderation',
    label: 'Модерация и маркетплейс',
    links: [
      { href: '/publications', label: 'Публикации на модерации' },
      { href: '/shared-videos', label: 'Публичные страницы видео' },
      { href: '/creator-profiles', label: 'Исполнители' },
      { href: '/portfolio-items', label: 'Портфолио' },
      { href: '/auctions', label: 'Аукционы' },
    ],
  },
  {
    key: 'create',
    label: 'Создание видео',
    links: [
      { href: '/library', label: 'Библиотека референсов' },
      { href: '/catalog-batches', label: 'Пакетная генерация' },
      { href: '/ab-tests', label: 'A/B-варианты' },
      { href: '/feed-imports', label: 'Импорт фида' },
      { href: '/virtual-studio', label: 'Виртуальная студия' },
      { href: '/actors', label: 'AI-аватары (пилот)' },
    ],
  },
  {
    key: 'tutorials',
    label: 'Обучающие материалы',
    links: [
      { href: '/tutorial-scenarios', label: 'Сценарии демо' },
      { href: '/site-tutorial-drafts', label: 'Обучающие видео по сайтам' },
      { href: '/blog', label: 'Блог' },
    ],
  },
  {
    key: 'growth',
    label: 'Продвижение',
    links: [
      { href: '/marketing', label: 'Рассылки' },
      { href: '/funnel', label: 'Воронка' },
      { href: '/referrals', label: 'Приглашения' },
    ],
  },
  {
    key: 'finance',
    label: 'Финансы',
    links: [
      { href: '/payments', label: 'Платежи' },
      { href: '/balances', label: 'Балансы' },
      { href: '/costs', label: 'Расходы' },
    ],
  },
  {
    key: 'assistants',
    label: 'ИИ-помощники',
    links: [
      { href: '/assistant', label: 'Консультант лендинга' },
      { href: '/wizard-guide', label: 'Советник мастера' },
      { href: '/assist-platform', label: 'Помощник сайтов' },
    ],
  },
  {
    key: 'ops',
    label: 'Эксплуатация',
    links: [
      { href: '/cron', label: 'Запуски по расписанию' },
      { href: '/ui-snapshots', label: 'Снимки интерфейса' },
      { href: '/testing', label: 'Тестирование' },
      { href: '/telemetry', label: 'Телеметрия' },
      { href: '/settings', label: 'Настройки' },
    ],
  },
];

/** Все ссылки меню, кроме «Обзора», в порядке показа. */
export const ALL_NAV_LINKS: NavLink[] = NAV_GROUPS.flatMap((g) => g.links);

/**
 * Активен ли пункт для текущего адреса. «Обзор» (`/`) — только при
 * точном совпадении: `startsWith('/')` отметил бы его на каждом экране.
 * Остальные — сам адрес и вложенные (`/sessions/abc` → «Сессии»), но не
 * соседи с общим началом (`/users-x` не «Пользователи»).
 */
export function isNavActive(pathname: string | null | undefined, href: string): boolean {
  const path = normalizePath(pathname);
  if (href === '/') return path === '/';
  return path === href || path.startsWith(`${href}/`);
}

function normalizePath(pathname: string | null | undefined): string {
  if (!pathname) return '';
  const noQuery = pathname.split(/[?#]/)[0];
  return noQuery.length > 1 && noQuery.endsWith('/') ? noQuery.slice(0, -1) : noQuery;
}

/** Группа, в которой лежит текущая страница; null — «Обзор» или вне меню. */
export function activeGroupKey(pathname: string | null | undefined): string | null {
  const group = NAV_GROUPS.find((g) => g.links.some((l) => isNavActive(pathname, l.href)));
  return group ? group.key : null;
}

/** Подпись текущего раздела — для заголовка мобильной шапки. */
export function activeLabel(pathname: string | null | undefined): string | null {
  if (isNavActive(pathname, OVERVIEW_LINK.href)) return OVERVIEW_LINK.label;
  const link = ALL_NAV_LINKS.find((l) => isNavActive(pathname, l.href));
  return link ? link.label : null;
}

/** Ключ в localStorage: какие группы оператор раскрыл. */
export const NAV_EXPANDED_STORAGE_KEY = 'v4c-admin-nav-expanded';

/** Разбор запомненного раскрытия: только известные ключи групп. */
export function parseExpanded(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const known = new Set(NAV_GROUPS.map((g) => g.key));
    return value.filter((v): v is string => typeof v === 'string' && known.has(v));
  } catch {
    return null;
  }
}
