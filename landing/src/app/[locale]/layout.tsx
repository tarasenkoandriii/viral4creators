import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDictionary } from '../../lib/get-dictionary';
import { isLocale, locales, OG_LOCALES, type Locale } from '../../lib/i18n';
import { DictionaryProvider } from '../../lib/dictionary-context';
import { SetHtmlLang } from '../../components/SetHtmlLang';

/** Все пять локалей — статическая генерация на сборке, не по требованию. */
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) return {};
  const dict = getDictionary(params.locale);
  const languages = Object.fromEntries(locales.map((l) => [l, `/${l}`]));
  return {
    title: dict.meta.title,
    description: dict.meta.description,
    keywords: dict.meta.keywords,
    alternates: {
      // hreflang для поисковика — на каждой языковой версии страницы
      // указаны все остальные, плюс x-default на дефолтную локаль (ru).
      languages: { ...languages, 'x-default': '/' },
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      type: 'website',
      locale: OG_LOCALES[params.locale],
    },
    twitter: {
      card: 'summary',
      title: dict.meta.title,
      description: dict.meta.description,
    },
    robots: { index: true, follow: true },
  };
}

export default function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const locale: Locale = params.locale;
  const dict = getDictionary(locale);

  return (
    <DictionaryProvider dict={dict} locale={locale}>
      {/* Корневой <html lang> задан один раз в app/layout.tsx (там, где
          он физически рендерится) и не может быть переписан отсюда —
          вложенный layout меняет его через маленький клиентский эффект,
          тот же приём, что применяют next-intl и сам Next.js в проектах
          без route-groups под каждую локаль. */}
      <SetHtmlLang locale={locale} />
      {children}
    </DictionaryProvider>
  );
}
