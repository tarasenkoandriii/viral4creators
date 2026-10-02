import { notFound } from 'next/navigation';
import { claimStatus } from '../lib/claims';
import { loadDoc } from '../lib/docs';
import { getDictionary } from '../lib/get-dictionary';
import type { Locale } from '../lib/i18n';
import { DOCS_LOCALES, href, page, pageMetadata, type DocsKey } from '../lib/pages';
import { siteUrl } from '../lib/site-url';
import { Breadcrumbs } from './Breadcrumbs';
import { DocsArticle } from './DocsArticle';
import { JsonLd } from './JsonLd';
import { SiteChrome } from './SiteChrome';

/**
 * Страница документации (Л5, §3.13): uk/en (§11; ru — по спросу → 404, а
 * ссылки из ru-интерфейса ведут на uk с `hrefLang`). Содержание — Markdown
 * `docs/assistant/<локаль>/*.md`; разметка `TechArticle` (§8.3).
 */
export const DOC_KEYS: readonly DocsKey[] = ['docs', 'docs-js-api', 'docs-goals', 'docs-csp'];

function available(locale: Locale): boolean {
  return (DOCS_LOCALES as readonly Locale[]).includes(locale);
}

export function docsMetadata(key: DocsKey, locale: Locale) {
  if (!available(locale) || claimStatus('docs') === 'hidden') return {};
  const doc = loadDoc(key, locale);
  return pageMetadata(key, locale, { title: doc.title, description: doc.description });
}

export function DocsPage({ docKey, locale }: { docKey: DocsKey; locale: Locale }) {
  if (!available(locale) || claimStatus('docs') === 'hidden') notFound();
  const dict = getDictionary(locale);
  const doc = loadDoc(docKey, locale);
  const nav = dict.docsUi.pages;
  return (
    <SiteChrome locale={locale} path={page(docKey).path} current={docKey} available={DOCS_LOCALES}>
      <Breadcrumbs locale={locale} current={docKey} />
      <div className="wrap docs-layout">
        <nav className="docs-nav" aria-label={dict.docsUi.navLabel}>
          <ul>
            {DOC_KEYS.map((k) => (
              <li key={k}>
                <a href={href(locale, k)} aria-current={k === docKey ? 'page' : undefined}>
                  {nav[k]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <section className="claim claim-live" data-claim="docs" data-claim-status="live" aria-label={nav[docKey]}>
          <DocsArticle doc={doc} dict={dict} />
        </section>
      </div>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: doc.title,
          description: doc.description,
          inLanguage: locale,
          url: `${siteUrl()}${href(locale, docKey)}`,
          dateModified: page(docKey).updated,
        }}
      />
    </SiteChrome>
  );
}
