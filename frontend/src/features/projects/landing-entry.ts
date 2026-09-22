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
 * Метка источника → тип проекта, который должен быть выбран сразу.
 *
 * Ключи — те самые значения, которые лендинги уже кладут в ссылку;
 * менять их здесь в отрыве от `landing/` нельзя.
 */
export const ENTRY_PROJECT_TYPES: Readonly<Record<string, ProjectType>> = {
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
  if (!entry) return null;
  return ENTRY_PROJECT_TYPES[entry] ?? null;
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
