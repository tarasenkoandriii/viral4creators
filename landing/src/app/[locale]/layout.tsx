import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDictionary } from '../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../lib/i18n';
import { localeAlternates } from '../../lib/alternates';
import { ogImageUrl, socialMeta } from '../../lib/social-meta';
import { SITE_URL } from '../../lib/content';
import { DictionaryProvider } from '../../lib/dictionary-context';
import { SetHtmlLang } from '../../components/SetHtmlLang';

/** Все пять локалей — статическая генерация на сборке, не по требованию. */
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) return {};
  const dict = getDictionary(params.locale);
  return {
    title: dict.meta.title,
    description: dict.meta.description,
    keywords: dict.meta.keywords,
    // hreflang + canonical одной функцией (см. lib/alternates.ts): на
    // каждой языковой версии указаны все остальные, абсолютными
    // адресами, и x-default ведёт на реальную страницу локали по
    // умолчанию, а не на корень, отвечающий редиректом.
    alternates: localeAlternates(
      (l) => `${SITE_URL}/${l}`,
      (l) => `/${l}`,
      params.locale,
    ),
    ...socialMeta({
      title: dict.meta.title,
      description: dict.meta.description,
      url: `${SITE_URL}/${params.locale}`,
      locale: params.locale,
      image: ogImageUrl(SITE_URL, 'main', params.locale),
    }),
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
