import { HtmlDocument } from '../../../components/HtmlDocument';
import { isLocale } from '../../../lib/i18n';
import { getSharedVideo } from '../../../lib/shared-video-api';

/**
 * `<html lang>` публичной страницы ролика — локаль снимка, та же, на
 * которой говорит сама страница (`getDictionary(page.locale)` в page.tsx),
 * а не `ru` для всех. Запрос тот же, что у страницы и её метаданных:
 * Next склеивает одинаковые `fetch` одного рендера в один, а кеш держит
 * `revalidate` (lib/shared-video-api.ts), так что лишнего похода в API
 * здесь нет. Нет снимка — страница ответит `notFound()`, и 404 нарисует
 * свой `<html>` (app/not-found.tsx); `ru` ниже — только на этот миг.
 */
export default async function SharedVideoLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const page = await getSharedVideo((await params).id);
  const locale = page && isLocale(page.locale) ? page.locale : 'ru';
  return <HtmlDocument locale={locale}>{children}</HtmlDocument>;
}
