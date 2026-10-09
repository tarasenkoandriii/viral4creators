import type { Metadata } from 'next';
import { DocsPage, docsMetadata } from '../../../../components/DocsPage';
import type { Locale } from '../../../../lib/i18n';
import { DOCS_LOCALES } from '../../../../lib/pages';

/** Только uk/en (§11): `/ru/docs/assistant` — не страница сайта (404), а не пустая копия. */
export function generateStaticParams() {
  return DOCS_LOCALES.map((locale) => ({ locale }));
}
export const dynamicParams = false;

/** Документация: установка (Л5, §3.13). */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return docsMetadata('docs', (await params).locale);
}

export default async function DocsInstallPage({ params }: { params: Promise<{ locale: Locale }> }) {
  return <DocsPage docKey="docs" locale={(await params).locale} />;
}
