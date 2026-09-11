import type { Metadata } from 'next';
import { Header } from '../../../components/Header';
import { HowItWorks } from '../../../components/HowItWorks';
import { getDictionary } from '../../../lib/get-dictionary';
import { isLocale, locales, OG_LOCALES, type Locale } from '../../../lib/i18n';

/**
 * Выделенная страница «Как это работает» — этап 79
 * (doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md §3.4), той же структуры, что
 * `app/[locale]/blog/page.tsx`: `generateStaticParams` по пяти локалям,
 * `generateMetadata` из словаря, явный рендер `<Header/>` (макет
 * `[locale]/layout.tsx` его не добавляет). В отличие от блога — контент
 * полностью статический (живёт в словаре), похода в API не требует и
 * `revalidate` не нужен.
 */

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) return {};
  const dict = getDictionary(params.locale);
  const { metaTitle, metaDescription } = dict.steps.page;
  const languages = Object.fromEntries(locales.map((l) => [l, `/${l}/how-it-works`]));
  return {
    title: metaTitle,
    description: metaDescription,
    alternates: { languages: { ...languages, 'x-default': '/ru/how-it-works' } },
    openGraph: {
      title: metaTitle,
      description: metaDescription,
      type: 'website',
      locale: OG_LOCALES[params.locale],
    },
    robots: { index: true, follow: true },
  };
}

export default function HowItWorksPage({ params }: { params: { locale: string } }) {
  const locale: Locale = isLocale(params.locale) ? params.locale : 'ru';
  const dict = getDictionary(locale);

  return (
    <>
      <Header />
      <main className="wrap how-it-works-page">
        <h1>{dict.steps.title}</h1>
        <p className="how-it-works-lead">{dict.steps.lead}</p>
        <HowItWorks steps={dict.steps} variant="full" hrefBase="" />
      </main>
    </>
  );
}
