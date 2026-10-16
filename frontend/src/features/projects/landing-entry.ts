/**
 * Разбор ссылки, по которой человек пришёл с лендинга.
 *
 * Отдельный модуль, а не функции внутри `ProjectCreateScreen`, по двум
 * причинам, и обе выяснились на практике.
 *
 * 1. Это единственная точка, где адрес снаружи влияет на состояние
 *    формы. Проверять её надо, а React-экран ради трёх строк логики в
 *    проекте не поднимают — DOM-тестов здесь нет.
 * 2. Прошлая попытка это проверить (`scripts/greeting-entry.test.ts`,
 *    этап поздравлений) сверяла КОПИЮ разбора, переписанную в самом
 *    тесте. Такой тест зелен и тогда, когда оригинал давно уехал: он
 *    проверяет копию, а не код. Теперь и экран, и тест зовут одно и то
 *    же.
 *
 * Находка Б-1 аудита `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`:
 * лендинги уже ставили в ссылку `?entry=…`, но прочитать его было
 * некому — во всём монорепозитории параметр только писался. Для
 * поздравлений это сходило с рук, потому что работу делал второй
 * параметр (`?occasion=`, из него выводился и тип проекта). У обучалки
 * по сайту второго параметра нет, и её ссылка открывала бы мастер на
 * плитке товарного ролика — то есть на форме совсем другого продукта.
 */

import {
  GREETING_OCCASIONS,
  type GreetingOccasion,
  type ProjectType,
} from '../../types/project';

/**
 * Закрытый список меток источника — по одной на лендинг: главная
 * (рекламный ролик), поздравления, обучалка по сайту и Story‑Tales. Тот
 * же список разбирает `startapp=e_<метка>` в Telegram
 * (`lib/start-param.ts`) и собирает лендинг
 * (`landing/src/lib/telegram-entry.ts`).
 *
 * `stories` (лендинг Story‑Tales, решение Р-STL-10
 * `doc/STORY-TALES-LANDING-ADAPTED.md`) — первая метка, которая ведёт НЕ
 * в форму нового проекта: мастера сказки ещё нет, и до его приёмки
 * переход обязан открывать честный информационный раздел `#/stories`, а
 * не поздравление или товарный ролик под видом сказки.
 */
export const LANDING_ENTRIES = [
  'ads',
  'greetings',
  'site-tutorial',
  'stories',
] as const;
export type LandingEntry = (typeof LANDING_ENTRIES)[number];

/**
 * Метки, которые открывают раздел TMA, а не форму проекта. Отдельная
 * таблица, а не `if (entry === 'stories')` в двух местах: маршрут запуска
 * (`entryLaunchUrl`) и предвыбор типа (`projectTypeFromSearch`) обязаны
 * знать одно и то же, и новая «разделовая» метка не должна молча получить
 * тип проекта по умолчанию.
 */
// Литералы, а не `routes.*` из `lib/router`: модуль чистый (без React),
// его исполняет и проверка лендинга (`landing/scripts/telegram-entry.test.ts`),
// у которой нет зависимостей frontend. Совпадение с `routes` держит
// `scripts/landing-entry.test.ts`.
export const ENTRY_SECTION_ROUTES = {
  stories: '/stories',
} as const satisfies Partial<Record<LandingEntry, string>>;
/** Форма нового проекта (`routes.projectNew()`). */
export const PROJECT_NEW_ROUTE = '/projects/new';
type SectionEntry = keyof typeof ENTRY_SECTION_ROUTES;
/** Метки, ведущие в форму нового проекта. */
export type ProjectEntry = Exclude<LandingEntry, SectionEntry>;

function isSectionEntry(entry: LandingEntry): entry is SectionEntry {
  return Object.prototype.hasOwnProperty.call(ENTRY_SECTION_ROUTES, entry);
}

/**
 * Hash-маршрут (без `#`), который открывает метка: раздел TMA для
 * `ENTRY_SECTION_ROUTES`, иначе — форма нового проекта.
 */
export function entryHashRoute(entry: LandingEntry): string {
  return isSectionEntry(entry)
    ? ENTRY_SECTION_ROUTES[entry]
    : PROJECT_NEW_ROUTE;
}

export function isLandingEntry(value: unknown): value is LandingEntry {
  return (
    typeof value === 'string' &&
    (LANDING_ENTRIES as readonly string[]).includes(value)
  );
}

/**
 * Метка источника → тип проекта, который должен быть выбран сразу.
 *
 * Ключи — те самые значения, которые лендинги уже кладут в ссылку;
 * менять их здесь в отрыве от `landing/` нельзя. `ads` — главная:
 * рекламный ролик товара, тот же тип, что и умолчание формы, но метка
 * нужна, чтобы вход из Telegram (`startapp=e_ads`) вёл туда же, куда
 * кнопка главной в браузере, — в форму нового проекта, а не в список.
 */
export const ENTRY_PROJECT_TYPES: Readonly<Record<ProjectEntry, ProjectType>> =
  {
    ads: 'SINGLE',
    greetings: 'GREETING_VIDEO',
    'site-tutorial': 'CLIENT_SITE',
  };

/**
 * Повод поздравления из `?occasion=`. Неизвестный код игнорируется:
 * адрес приходит снаружи, и падать из-за опечатки в нём форма не
 * должна — остаётся обычное умолчание.
 */
export function occasionFromSearch(search: string): GreetingOccasion | null {
  const raw = new URLSearchParams(search).get('occasion');
  if (!raw) return null;
  return (GREETING_OCCASIONS as readonly string[]).includes(raw)
    ? (raw as GreetingOccasion)
    : null;
}

/**
 * Тип проекта, предвыбранный ссылкой.
 *
 * `occasion` сильнее `entry`: он конкретнее (не просто «пришёл с
 * лендинга поздравлений», а «нажал плитку „Свадьба“»), и ссылка с
 * поводом всегда означает поздравление, какой бы источник в ней ни
 * стоял.
 */
export function projectTypeFromSearch(search: string): ProjectType | null {
  if (occasionFromSearch(search)) return 'GREETING_VIDEO';
  const entry = new URLSearchParams(search).get('entry');
  // Метка раздела (`stories`) типа проекта не задаёт: такая ссылка вообще
  // не ведёт в форму, а если форму открыли руками — остаётся умолчание.
  return isLandingEntry(entry) && !isSectionEntry(entry)
    ? ENTRY_PROJECT_TYPES[entry]
    : null;
}

/**
 * Адрес, на который мини-апп переписывает себя при запуске с
 * `startapp=e_<метка>`: ровно тот, что лендинг даёт браузерной кнопке
 * (`?entry=<метка>#/projects/new`), — дальше форма разбирает его тем же
 * `projectTypeFromSearch`, и двух путей в один сценарий не появляется.
 * Для метки раздела (`stories`) — `?entry=stories#/stories`: раздел TMA,
 * а не форма. Прочие query-параметры адреса запуска сохраняются.
 */
export function entryLaunchUrl(
  pathname: string,
  search: string,
  entry: LandingEntry
): string {
  const params = new URLSearchParams(search);
  params.set('entry', entry);
  return `${pathname}?${params.toString()}#${entryHashRoute(entry)}`;
}

/**
 * Адрес сайта из `?site=` — чтобы лендинг обучалки мог довести человека
 * до первого раунда одним кликом, а не двумя действиями.
 *
 * Пропускаются только абсолютные `http(s)`-адреса. Это не защита
 * сервера (он проверяет адрес сам — `assertPubliclyRoutableUrl`,
 * доменный замок), а защита ИНТЕРФЕЙСА: `javascript:`-строка в поле
 * ввода не опасна сама по себе, но она попадёт в форму, уедет на
 * сервер и вернётся отказом, который человек не поймёт, — а виноват
 * будет чужой адрес в чужой ссылке.
 */
export function siteUrlFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('site');
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Текущий адрес страницы. Отдельной функцией, чтобы всё, что выше,
 * оставалось чистым и проверяемым, а обращение к `window` было ровно в
 * одном месте.
 */
export function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}
