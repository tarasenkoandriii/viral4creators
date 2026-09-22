import type { Metadata } from 'next';
import { Header } from '../../../components/Header';
import { HowItWorks } from '../../../components/HowItWorks';
import { AssistantWidget } from '../../../components/AssistantWidget';
import { Footer } from '../../../components/Footer';
import { getDictionary } from '../../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../../lib/i18n';
import { localeAlternates } from '../../../lib/alternates';
import { ogImageUrl, socialMeta } from '../../../lib/social-meta';
import { SITE_URL } from '../../../lib/content';

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
  return {
    title: metaTitle,
    description: metaDescription,
    alternates: localeAlternates(
      (l) => `${SITE_URL}/${l}/how-it-works`,
      (l) => `/${l}/how-it-works`,
      params.locale,
    ),
    ...socialMeta({
      title: metaTitle,
      description: metaDescription,
      url: `${SITE_URL}/${params.locale}/how-it-works`,
      locale: params.locale,
      image: ogImageUrl(SITE_URL, 'main', params.locale),
    }),
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
        {/* Сетка 1fr 360px (§6.1 ТЗ AI-консультанта) — встроенная панель
            справа от блок-схемы на ≥1100px, под ней — на узких экранах
            (.how-it-works-layout в globals.css). */}
        <div className="how-it-works-layout">
          <div className="how-it-works-main">
            <HowItWorks steps={dict.steps} variant="full" hrefBase="" />
          </div>
          <aside className="how-it-works-assistant" aria-label={dict.assistant.widgetTitle}>
            <AssistantWidget locale={locale} dict={dict.assistant} page="how-it-works" variant="embedded" />
          </aside>
        </div>
      </main>
      {/* Находка С-3 аудита: с этапа 79 у этой страницы не было футера
          вовсе — ни копирайта, ни ссылок на оферту и условия
          использования. С общим компонентом это чинится само. */}
      <Footer dict={dict} locale={locale} />
    </>
  );
}
