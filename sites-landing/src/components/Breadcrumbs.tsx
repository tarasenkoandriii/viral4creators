import { fmt } from '../lib/format';
import { getDictionary } from '../lib/get-dictionary';
import type { Locale } from '../lib/i18n';
import { href, page, type PageKey } from '../lib/pages';
import { siteUrl } from '../lib/site-url';
import { JsonLd } from './JsonLd';

/** Хлебные крошки + `BreadcrumbList` (§8.3) для вложенных страниц. */
export function Breadcrumbs({ locale, current }: { locale: Locale; current: PageKey }) {
  const dict = getDictionary(locale);
  const chain: PageKey[] = [];
  for (let key: PageKey | undefined = current; key; key = page(key).parent) chain.unshift(key);
  const label = (key: PageKey) => (key === 'home' ? dict.common.breadcrumbHome : navLabel(locale, key));
  const origin = siteUrl();
  return (
    <nav className="breadcrumbs wrap" aria-label={dict.common.breadcrumbLabel}>
      <ol>
        {chain.map((key) => (
          <li key={key}>{key === current ? <span aria-current="page">{label(key)}</span> : <a href={href(locale, key)}>{label(key)}</a>}</li>
        ))}
      </ol>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: chain.map((key, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: label(key),
            item: `${origin}${href(locale, key)}`,
          })),
        }}
      />
    </nav>
  );
}

export function navLabel(locale: Locale, key: PageKey): string {
  const n = getDictionary(locale).common.nav;
  const map: Record<PageKey, string> = {
    home: fmt(n.home),
    assistant: n.assistant,
    'how-it-works': n.howItWorks,
    pricing: n.pricing,
    security: n.security,
    faq: n.faq,
    pilot: n.pilot,
  };
  return map[key];
}
