import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BRAND } from '../../../brand';
import { LegalArticle } from '../../../components/LegalArticle';
import { SiteChrome } from '../../../components/SiteChrome';
import { getDictionary } from '../../../lib/get-dictionary';
import { locales } from '../../../lib/i18n';
import { isLegalSlug, LEGAL_DOCS, legalMarkdown, legalTitle } from '../../../lib/legal-docs';
import { siteUrl } from '../../../lib/site-url';

export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!isLegalSlug(slug)) return {};
  const md = legalMarkdown(slug);
  const draft = LEGAL_DOCS.find((d) => d.slug === slug)!.draft;
  return {
    title: `${legalTitle(md)} — ${BRAND.name}`,
    alternates: { canonical: `${siteUrl()}/legal/${slug}` },
    // Черновик в поиске не нужен (и в sitemap его нет).
    robots: draft ? { index: false, follow: true } : { index: true, follow: true },
  };
}

export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isLegalSlug(slug)) notFound();
  const uk = getDictionary('uk');
  const doc = LEGAL_DOCS.find((d) => d.slug === slug)!;
  const md = legalMarkdown(slug);
  const others = LEGAL_DOCS.filter((d) => d.slug !== doc.slug);
  return (
    // Та же шапка и тот же футер (уроки Ф-2, С-3). Переключатель языка
    // ведёт на главные локалей: перевода черновика нет.
    <SiteChrome locale="uk" path="">
      <div className="wrap section">
        {doc.draft && (
          <p className="draft-banner" role="note">
            {uk.legal.draftBanner}
          </p>
        )}
        {/* Для читателей других локалей — на их языке, почему текст только украинский. */}
        {locales
          .filter((l) => l !== 'uk')
          .map((l) => (
            <p key={l} lang={l} className="note">
              {getDictionary(l).legal.onlyUk}
            </p>
          ))}
        <LegalArticle markdown={md} />
        <nav aria-label={uk.common.footer.legalHeading}>
          <ul>
            {others.map((d) => (
              <li key={d.slug}>
                <a href={`/legal/${d.slug}`}>{legalTitle(legalMarkdown(d.slug))}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </SiteChrome>
  );
}
