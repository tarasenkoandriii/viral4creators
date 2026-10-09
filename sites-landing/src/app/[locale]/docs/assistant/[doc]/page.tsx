import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsPage, docsMetadata } from '../../../../../components/DocsPage';
import type { Locale } from '../../../../../lib/i18n';
import { DOCS_LOCALES, type DocsKey } from '../../../../../lib/pages';

/** Документация: JS API, цели и вебхук, CSP (Л5, §3.13). */
const SLUGS: Record<string, DocsKey> = { 'js-api': 'docs-js-api', goals: 'docs-goals', csp: 'docs-csp' };

function docKey(slug: string): DocsKey | null {
  return Object.prototype.hasOwnProperty.call(SLUGS, slug) ? SLUGS[slug] : null;
}

export function generateStaticParams() {
  return DOCS_LOCALES.flatMap((locale) => Object.keys(SLUGS).map((doc) => ({ locale, doc })));
}
export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; doc: string }>;
}): Promise<Metadata> {
  const { locale, doc } = await params;
  const key = docKey(doc);
  return key ? docsMetadata(key, locale) : {};
}

export default async function DocsSubPage({ params }: { params: Promise<{ locale: Locale; doc: string }> }) {
  const { locale, doc } = await params;
  const key = docKey(doc);
  if (!key) notFound();
  return <DocsPage docKey={key} locale={locale} />;
}
