import { LocaleSwitcher } from './LocaleSwitcher';
import { SITE_URL, TMA_URL } from '../lib/content';
import type { Dictionary } from '../lib/get-dictionary';

/**
 * Шапка мини-лендингов на поддоменах (`greeting.*`, `tutorial.*`).
 *
 * Появилась по находке Ф-2 аудита живого лендинга: у обеих страниц не
 * было шапки вовсе, и переключателя языка вместе с ней. Пять локалей
 * существовали только для того, кто угадает адрес: ссылки на них нет, а
 * `hreflang` (находка Ф-1) тоже отсутствовал — то есть ни человеку, ни
 * поисковику. Для страницы обучалок это дороже всего: её целевой запрос
 * чаще англоязычный, чем у остальных (§7 ТЗ).
 *
 * Почему НЕ общий `Header`, а своя: тот выводит пункты меню из
 * `dict.header.nav` — а это якоря разделов ГЛАВНОЙ страницы (`#features`,
 * `#plans`). На поддомене таких разделов нет, и каждый пункт вёл бы в
 * пустоту. Здесь ровно три элемента: марка (она же выход на главный
 * сайт), выбор языка и кнопка в продукт.
 *
 * Марка — абсолютная ссылка на главный домен: это другой хост, и
 * относительный `/` вернул бы на ту же страницу.
 *
 * Класс навигации СВОЙ (`.subdomain-nav`), а не `.site-nav` главной:
 * та на ≤720px прячется под гамбургер, и при первой же проверке на
 * телефоне переключатель языка снова исчез — то есть ровно там, где
 * находка Ф-2 болит сильнее всего. Двум элементам гамбургер не нужен,
 * они помещаются в строку.
 */
export function SubdomainHeader({
  dict,
  locale,
  ctaHref,
}: {
  dict: Dictionary;
  locale: string;
  ctaHref?: string;
}) {
  return (
    <header className="site-header">
      <div className="wrap site-header-inner">
        <a className="brand" href={`${SITE_URL}/${locale}`}>
          viral4creators
        </a>
        <nav className="subdomain-nav" aria-label={dict.header.navAriaLabel}>
          <LocaleSwitcher />
          <a className="cta cta-small" href={ctaHref ?? TMA_URL}>
            {dict.header.open}
          </a>
        </nav>
      </div>
    </header>
  );
}
