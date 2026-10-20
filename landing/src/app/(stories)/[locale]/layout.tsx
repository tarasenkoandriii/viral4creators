import { notFound } from 'next/navigation';
import { isLocale, locales, type Locale } from '../../../lib/i18n';
import { HtmlDocument } from '../../../components/HtmlDocument';

/**
 * Документ страницы Story‑Tales — отдельно от `app/[locale]/layout.tsx`
 * (находка S3-7 аудита 16.10, закрыта 20.10.2026).
 *
 * Общий layout локали отдаёт клиентскому `DictionaryProvider` словарь
 * главной (`clientDictionary`): всё, что передано клиентскому компоненту,
 * лежит в RSC-данных HTML. Под ним страница Story‑Tales несла в скрытых
 * данных тексты рекламной главной (QA, API, товарная генерация) — ровно
 * то, чего на ней быть не должно (ТЗ §4), и лишний вес. Layout не знает,
 * какая страница под ним, поэтому страница вынесена в группу маршрутов
 * `(stories)`: адрес тот же (`/<locale>/stories`, группа в URL не
 * входит), а предки — только корневой layout и этот.
 *
 * Здесь — то же, что у общего layout'а, кроме словаря: `<html lang dir>`
 * через `HtmlDocument` (`scripts/html-lang.test.ts`) и 404 на чужой
 * локали. Провайдера словаря нет — компоненты страницы его не читают
 * (тексты — `lib/stories/copy`, только на сервере). Метаданные целиком
 * задаёт `stories/page.tsx`; `robots: index` общего layout'а сюда больше
 * не наследуется вовсе.
 */
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function StoriesLocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  return <HtmlDocument locale={locale}>{children}</HtmlDocument>;
}
