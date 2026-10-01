import type { Metadata } from 'next';
import { HtmlDocument } from '../components/HtmlDocument';
import { SiteChrome } from '../components/SiteChrome';
import { fmt } from '../lib/format';
import { getDictionary } from '../lib/get-dictionary';
import { locales, X_DEFAULT_LOCALE } from '../lib/i18n';

export const metadata: Metadata = {
  title: fmt(getDictionary(X_DEFAULT_LOCALE).pages['not-found'].title),
  robots: { index: false, follow: false },
};

/**
 * Последний резерв вне `[locale]`: языка запроса здесь не знаем, поэтому
 * короткий текст на всех трёх языках, каждый со своим `lang`.
 */
export default function NotFound() {
  return (
    <HtmlDocument lang={X_DEFAULT_LOCALE}>
      <SiteChrome locale={X_DEFAULT_LOCALE} path="">
        <div className="wrap section">
        {[X_DEFAULT_LOCALE, ...locales.filter((x) => x !== X_DEFAULT_LOCALE)].map((l, i) => {
          const d = getDictionary(l).notFound;
          const Heading = i === 0 ? 'h1' : 'h2';
          return (
            <section key={l} lang={l}>
              <Heading>{d.heading}</Heading>
              <p>
                {d.text} <a href={`/${l}`}>{d.home}</a>
              </p>
            </section>
          );
        })}
        </div>
      </SiteChrome>
    </HtmlDocument>
  );
}
