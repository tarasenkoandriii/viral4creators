import type { ReactNode } from 'react';
import { BRAND } from '../brand';
import { pathFor } from '../lib/alternates';
import { fmt } from '../lib/format';
import { isVisible } from '../lib/claims';
import { getDictionary } from '../lib/get-dictionary';
import { LOCALE_LABELS, LOCALE_SHORT, LOCALE_SWITCH_PARAM, locales, type Locale } from '../lib/i18n';
import { href, hrefLang, type PageKey } from '../lib/pages';

/**
 * Одна шапка и один футер на все страницы (уроки Ф-2 и С-3, §0).
 *
 * Всё — серверные компоненты, без клиентского JS:
 *  - переключатель языка — обычные ссылки `/<loc>/путь?hl=<loc>`;
 *    middleware пишет cookie выбора (явное действие человека — §10.1) и
 *    уводит на чистый адрес. Виден на 360 px (Ф-2): три коротких кода,
 *    не выпадающий список;
 *  - навигация переносится строками, а не прячется в «бургер» (бургер —
 *    это клиентский JS и ещё одна вещь, которая пропадает на телефоне).
 *
 * Пункты меню — по реестру: «Блог», «Войти», «Подключить» — `hidden`
 * (blog, web-login, tma-connect). «Документація» (Л5) — uk/en: из ru-
 * интерфейса ссылка ведёт на uk с `hrefLang`. Кнопка в шапке — главный CTA
 * §3.1 «Попробовать на своём сайте» (песочница, Л4); без неё — заявка в пилот.
 * `available` — локали страницы, если не все (документация): переключатель
 * языка показывает только существующие версии.
 */
export function SiteChrome({
  locale,
  path,
  current,
  available = locales,
  children,
}: {
  locale: Locale;
  /** Путь текущей страницы БЕЗ локали — для переключателя языка. */
  path: string;
  current?: PageKey;
  available?: readonly Locale[];
  children: ReactNode;
}) {
  const dict = getDictionary(locale);
  const nav: Array<{ key: PageKey; label: string }> = [
    { key: 'assistant', label: dict.common.nav.assistant },
    { key: 'how-it-works', label: dict.common.nav.howItWorks },
    // Конфигуратор `/widget` — Л3 (С2); без `configurator: live` пункта нет.
    ...(isVisible('configurator') ? [{ key: 'widget' as const, label: dict.common.nav.widget }] : []),
    ...(isVisible('integrations') ? [{ key: 'integrations' as const, label: dict.common.nav.integrations }] : []),
    { key: 'pricing', label: dict.common.nav.pricing },
    { key: 'security', label: dict.common.nav.security },
    { key: 'faq', label: dict.common.nav.faq },
    ...(isVisible('docs') ? [{ key: 'docs' as const, label: dict.common.nav.docs }] : []),
  ];
  const navCurrent = current?.startsWith('docs') ? 'docs' : current?.startsWith('integrations') ? 'integrations' : current;
  const sandbox = isVisible('sandbox');
  return (
    <>
      <a className="skip-link" href="#main">
        {dict.common.skipLink}
      </a>
      <header className="site-header">
        <div className="wrap header-row">
          <a className="brand" href={href(locale, 'home')} aria-label={fmt(dict.common.nav.home)}>
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">{BRAND.name}</span>
          </a>
          <nav className="locale-switcher" aria-label={dict.common.localeSwitcher.label}>
            <ul>
              {available.map((l) => (
                <li key={l}>
                  {l === locale ? (
                    <span aria-current="true" lang={l} title={LOCALE_LABELS[l]}>
                      {LOCALE_SHORT[l]}
                    </span>
                  ) : (
                    <a
                      href={`${pathFor(l, path)}?${LOCALE_SWITCH_PARAM}=${l}`}
                      hrefLang={l}
                      lang={l}
                      title={LOCALE_LABELS[l]}
                    >
                      {LOCALE_SHORT[l]}
                      <span className="sr-only"> — {LOCALE_LABELS[l]}</span>
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
          <a className="button button-small header-cta" href={href(locale, sandbox ? 'try' : 'pilot')} data-cta="header">
            {sandbox ? dict.common.nav.tryShort : dict.common.nav.pilot}
          </a>
        </div>
        <nav className="wrap main-nav" aria-label={dict.common.nav.label}>
          <ul>
            {nav.map((item) => (
              <li key={item.key}>
                <a href={href(locale, item.key)} hrefLang={hrefLang(locale, item.key)} aria-current={item.key === navCurrent ? 'page' : undefined}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="site-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer" aria-label={dict.common.footer.label}>
        <div className="wrap footer-grid">
          <p className="footer-about">{fmt(dict.common.footer.about)}</p>
          <div>
            <h2 className="footer-heading">{dict.common.footer.productHeading}</h2>
            <ul className="footer-links">
              {nav.map((item) => (
                <li key={item.key}>
                  <a href={href(locale, item.key)} hrefLang={hrefLang(locale, item.key)}>
                    {item.label}
                  </a>
                </li>
              ))}
              {sandbox && (
                <li>
                  <a href={href(locale, 'try')}>{dict.common.nav.try}</a>
                </li>
              )}
              <li>
                <a href={href(locale, 'pilot')}>{dict.common.nav.pilot}</a>
              </li>
              {isVisible('crawler-opt-out') && (
                <li>
                  <a href={href(locale, 'bot')}>{dict.common.nav.bot}</a>
                </li>
              )}
            </ul>
          </div>
          <div>
            <h2 className="footer-heading">{dict.common.footer.legalHeading}</h2>
            <ul className="footer-links">
              <li>
                <a href="/legal/privacy">{dict.common.footer.privacy}</a>
              </li>
              <li>
                <a href="/legal/terms">{dict.common.footer.terms}</a>
              </li>
              <li>
                <a href="/legal/cookies">{dict.common.footer.cookies}</a>
              </li>
            </ul>
            <p className="footer-note">{dict.common.footer.draftNote}</p>
          </div>
        </div>
        <div className="wrap footer-bottom">
          <p>{fmt(dict.common.footer.copyright, { year: new Date().getUTCFullYear() })}</p>
        </div>
      </footer>
    </>
  );
}

/** Плашка «ранняя версия: «скоро» ещё не работает» на страницах Помощника. */
export function StatusBanner({ locale }: { locale: Locale }) {
  const dict = getDictionary(locale);
  return (
    <div className="status-banner" role="note">
      <div className="wrap">
        <p>
          {fmt(dict.common.statusBanner)} <a href={href(locale, 'pilot')}>{dict.common.statusBannerCta}</a>
        </p>
      </div>
    </div>
  );
}
