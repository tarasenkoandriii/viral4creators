import { HtmlDocument } from '../../../components/HtmlDocument';
import { cookieLocale } from '../../../lib/cookie-locale';

/**
 * Язык страницы приглашения — тот же, что она читает для текста
 * (`cookieLocale()` в page.tsx): страница и так `force-dynamic`, статики
 * здесь терять нечего.
 */
export default function ReferralLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <HtmlDocument locale={cookieLocale()}>{children}</HtmlDocument>;
}
