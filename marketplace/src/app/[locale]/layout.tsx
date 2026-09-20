import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getDictionary } from '../../lib/get-dictionary';
import { isLocale, locales, OG_LOCALES, type Locale } from '../../lib/i18n';
import { DictionaryProvider } from '../../lib/dictionary-context';
import { SetHtmlLang } from '../../components/SetHtmlLang';
import { LocaleSwitcher } from '../../components/LocaleSwitcher';
import { TelegramLoginButton } from '../../components/TelegramLoginButton';

/** Все пять локалей — статическая генерация на сборке, тот же приём, что у landing. */
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
    alternates: { languages: { ...languages, 'x-default': '/ru' } },
    openGraph: { title: dict.meta.title, description: dict.meta.description, locale: OG_LOCALES[params.locale] },
    robots: { index: true, follow: true },
  };
}

export default function LocaleSiteLayout({
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
      {/* Настоящий <html lang> задан один раз в app/layout.tsx (там, где
          он физически рендерится) — SetHtmlLang правит его маленьким
          клиентским эффектом, тот же обход, что у landing. */}
      <SetHtmlLang locale={locale} />
      <header className="mp-header">
        <Link href={`/${locale}`} className="mp-header-logo">
          {dict.header.logo}
        </Link>
        <nav className="mp-header-nav">
          <Link href={`/${locale}/collections`} className="mp-cta-secondary">
            {dict.header.collections}
          </Link>
          <Link href={`/${locale}/dashboard`} className="mp-cta-secondary">
            {dict.header.stats}
          </Link>
          <Link href={`/${locale}/become-creator`} className="mp-cta-secondary">
            {dict.header.becomeCreator}
          </Link>
          <Link href={`/${locale}/brand-book`} className="mp-cta-secondary">
            {dict.header.brandBook}
          </Link>
          <Link href={`/${locale}/briefs`} className="mp-cta-secondary">
            {dict.briefsList.heading}
          </Link>
          <Link href={`/${locale}/brief`} className="mp-cta">
            {dict.header.postBrief}
          </Link>
          <LocaleSwitcher />
          <TelegramLoginButton />
        </nav>
      </header>
      <main className="wrap">{children}</main>
    </DictionaryProvider>
  );
}
