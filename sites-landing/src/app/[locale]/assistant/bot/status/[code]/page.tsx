import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteChrome } from '../../../../../../components/SiteChrome';
import { fmt } from '../../../../../../lib/format';
import { getDictionary } from '../../../../../../lib/get-dictionary';
import { locales, type Locale } from '../../../../../../lib/i18n';
import { href } from '../../../../../../lib/pages';
import { OPT_OUT_CODES, type OptOutCode } from '../../../../../../server/opt-out';

/** Итог формы «уберите мой сайт» (303 из `/api/opt-out`). Служебная — `noindex`, вне sitemap. */
export function generateStaticParams() {
  return locales.flatMap((locale) => OPT_OUT_CODES.map((code) => ({ locale, code })));
}
export const dynamicParams = false;

export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  const dict = getDictionary(params.locale);
  return {
    title: fmt(dict.pages['bot-status'].title),
    description: fmt(dict.pages['bot-status'].description),
    robots: { index: false, follow: false },
  };
}

export default function BotStatusPage({ params }: { params: { locale: Locale; code: string } }) {
  const { locale } = params;
  if (!(OPT_OUT_CODES as readonly string[]).includes(params.code)) notFound();
  const code = params.code as OptOutCode;
  const dict = getDictionary(locale);
  return (
    <SiteChrome locale={locale} path={`/assistant/bot/status/${code}`}>
      <section className="hero wrap">
        <h1>{fmt(dict.pages['bot-status'].title)}</h1>
        <p className={`form-status form-status-${code}`} role="status">
          {dict.botPage.status[code]}
        </p>
        <p className="actions">
          <a className="button" href={`${href(locale, 'bot')}#bot-optout`}>
            {dict.botPage.statusBack}
          </a>
        </p>
      </section>
    </SiteChrome>
  );
}
