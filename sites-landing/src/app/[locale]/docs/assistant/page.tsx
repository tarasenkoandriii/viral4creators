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
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return docsMetadata('docs', params.locale);
}

export default function DocsInstallPage({ params }: { params: { locale: Locale } }) {
  return <DocsPage docKey="docs" locale={params.locale} />;
}
