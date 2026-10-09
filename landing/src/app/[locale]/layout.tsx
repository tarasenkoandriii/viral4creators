import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { clientDictionary, getDictionary } from '../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../lib/i18n';
import { localeAlternates } from '../../lib/alternates';
import { ogImageUrl, socialMeta } from '../../lib/social-meta';
import { SITE_URL } from '../../lib/content';
import { DictionaryProvider } from '../../lib/dictionary-context';
import { HtmlDocument } from '../../components/HtmlDocument';

/** Все пять локалей — статическая генерация на сборке, не по требованию. */
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const dict = getDictionary(locale);
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
      locale,
    ),
    ...socialMeta({
      title: dict.meta.title,
      description: dict.meta.description,
      url: `${SITE_URL}/${locale}`,
      locale,
      image: ogImageUrl(SITE_URL, 'main', locale),
    }),
    robots: { index: true, follow: true },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const dict = getDictionary(locale);

  return (
    // `<html lang dir>` рисуется ЗДЕСЬ, а не в корневом app/layout.tsx:
    // только этот layout знает локаль на сборке, и серверный HTML каждой
    // из пяти локалей (и страниц поддоменов, которые middleware
    // переписывает в тот же сегмент) несёт свой язык без клиентских
    // правок (см. components/HtmlDocument.tsx).
    <HtmlDocument locale={locale}>
      {/* `clientDictionary`: всё, что уходит клиентскому провайдеру, лежит
          в HTML каждой страницы (RSC-данные), — тексты «Вы в кадре» туда
          попасть не должны (см. get-dictionary.ts). */}
      <DictionaryProvider dict={clientDictionary(dict)} locale={locale}>
        {children}
      </DictionaryProvider>
    </HtmlDocument>
  );
}
