import type { Metadata } from 'next';
import { Header } from '../../../components/Header';
import { HowItWorks } from '../../../components/HowItWorks';
import { AssistantWidget } from '../../../components/AssistantWidget';
import { Footer } from '../../../components/Footer';
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
