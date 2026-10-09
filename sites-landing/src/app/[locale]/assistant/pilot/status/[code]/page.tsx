import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteChrome } from '../../../../../../components/SiteChrome';
import { fmt } from '../../../../../../lib/format';
import { getDictionary } from '../../../../../../lib/get-dictionary';
import { locales, type Locale } from '../../../../../../lib/i18n';
import { href } from '../../../../../../lib/pages';
import { PILOT_RESULT_CODES, type PilotResultCode } from '../../../../../../lib/pilot-validation';

/**
 * Итог отправки формы БЕЗ JS (route handler отвечает 303 сюда). Статика
 * на каждый код × локаль; `noindex` — служебная страница, в sitemap её нет.
 */
export function generateStaticParams() {
  return locales.flatMap((locale) => PILOT_RESULT_CODES.map((code) => ({ locale, code })));
}
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const dict = getDictionary((await params).locale);
  return {
    title: fmt(dict.pages['pilot-status'].title),
    description: fmt(dict.pages['pilot-status'].description),
    robots: { index: false, follow: false },
  };
}

export default async function PilotStatusPage({ params }: { params: Promise<{ locale: Locale; code: string }> }) {
  const { locale, code: raw } = await params;
  if (!(PILOT_RESULT_CODES as readonly string[]).includes(raw)) notFound();
  const code = raw as PilotResultCode;
  const dict = getDictionary(locale);
  return (
    <SiteChrome locale={locale} path={`/assistant/pilot/status/${code}`}>
      <section className="hero wrap">
        <h1>{fmt(dict.pages['pilot-status'].title)}</h1>
        {/* Свои тексты, а не `pilot.form.result`: те говорят «поля, отмеченные
            ниже» и «данные остались в форме», а здесь формы нет — после
            отправки без JS человек на отдельной странице. */}
        <p className={`form-status form-status-${code}`} role="status">
          {dict.pilot.status.result[code]}
        </p>
        <p className="actions">
          {code !== 'sent' && (
            <a className="button" href={href(locale, 'pilot')}>
              {dict.pilot.status.back}
            </a>
          )}
          <a className="button button-secondary" href={href(locale, 'assistant')}>
            {dict.pilot.status.home}
          </a>
        </p>
      </section>
    </SiteChrome>
  );
}
