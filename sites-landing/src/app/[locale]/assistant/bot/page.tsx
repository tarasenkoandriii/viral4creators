import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard, ClaimSection } from '../../../../components/Claim';
import { CodeBlock } from '../../../../components/DocsArticle';
import { SiteChrome } from '../../../../components/SiteChrome';
import { PRODUCT_NAMES } from '../../../../brand';
import { claimStatus } from '../../../../lib/claims';
import { fmt } from '../../../../lib/format';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { robotsBlock } from '../../../../lib/install';
import { pageMetadata } from '../../../../lib/pages';
import { SANDBOX_PUBLIC_LIMITS } from '../../../../lib/sandbox';
import { OPT_OUT_HONEYPOT, OPT_OUT_LIMITS } from '../../../../server/opt-out';

/**
 * Страница бота обхода (Л4; адрес — в User-Agent продукта
 * `CRAWLER_USER_AGENT`, QA-ТЗ §5.5): что за бот, как его остановить
 * `robots.txt` (мгновенно, без нас) и форма «уберите мой сайт» (opt-out
 * ядра, ≤ 72 ч, §13). Форма — обычная HTML-отправка без клиентского JS:
 * `POST /api/opt-out` → 303 на страницу результата.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return pageMetadata('bot', (await params).locale);
}

export default async function BotPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  if (claimStatus('crawler-opt-out') === 'hidden') notFound();
  const dict = getDictionary(locale);
  const b = dict.botPage;
  const f = b.form;
  const vars = { pages: SANDBOX_PUBLIC_LIMITS.pages, token: PRODUCT_NAMES.crawlerRobotsToken };
  return (
    <SiteChrome locale={locale} path="/assistant/bot" current="bot">
      <Breadcrumbs locale={locale} current="bot" />
      <section className="hero wrap">
        <h1>{fmt(b.heading)}</h1>
        <p className="lead">{fmt(b.lead)}</p>
      </section>
      <section className="section wrap" aria-labelledby="bot-ua">
        <h2 id="bot-ua">{b.uaHeading}</h2>
        <p>{b.uaText}</p>
        <CodeBlock code={PRODUCT_NAMES.crawlerUserAgent} label={b.uaHeading} wrap />
        <ul className="list-claims">
          {b.behaviour.map((item) => (
            <ClaimCard key={item.text} as="li" claim={item.claim} dict={dict} text={fmt(item.text, vars)} />
          ))}
        </ul>
      </section>
      <section className="section section-alt" aria-labelledby="bot-robots">
        <div className="wrap">
          <h2 id="bot-robots">{b.robotsHeading}</h2>
          <p>{fmt(b.robotsText, vars)}</p>
          <CodeBlock code={robotsBlock()} label="robots.txt" />
        </div>
      </section>
      <ClaimSection claim="crawler-opt-out" dict={dict} heading={b.optOutHeading} headingId="bot-optout" className="section wrap">
        <p>{b.optOutText}</p>
        <form className="pilot-form optout-form" method="post" action="/api/opt-out" data-testid="optout-form">
          <input type="hidden" name="locale" value={locale} />
          <div className="field">
            <label htmlFor="oo-domain">
              {f.domain} <span className="req">*</span>
            </label>
            <input id="oo-domain" name="domain" type="text" inputMode="url" required maxLength={OPT_OUT_LIMITS.domain} aria-describedby="oo-domain-hint" autoComplete="url" />
            <p id="oo-domain-hint" className="field-hint">
              {f.domainHint}
            </p>
          </div>
          <div className="field">
            <label htmlFor="oo-contact">
              {f.contact} <span className="req">*</span>
            </label>
            <input id="oo-contact" name="contact" type="text" required maxLength={OPT_OUT_LIMITS.contact} aria-describedby="oo-contact-hint" autoComplete="email" />
            <p id="oo-contact-hint" className="field-hint">
              {f.contactHint}
            </p>
          </div>
          <div className="field">
            <label htmlFor="oo-comment">{f.comment}</label>
            <textarea id="oo-comment" name="comment" rows={3} maxLength={OPT_OUT_LIMITS.comment} />
          </div>
          <div className="hp" aria-hidden="true">
            <label htmlFor="oo-hp">{f.honeypot}</label>
            <input id="oo-hp" name={OPT_OUT_HONEYPOT} type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <div className="field field-check">
            <input id="oo-consent" name="consent" type="checkbox" required />
            <label htmlFor="oo-consent">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- /legal: свой корневой документ, см. SiteChrome */}
              {f.consent} <a href="/legal/privacy">{dict.common.footer.privacy}</a>
            </label>
          </div>
          <p className="field-hint">{f.required}</p>
          <button className="button" type="submit">
            {f.submit}
          </button>
        </form>
      </ClaimSection>
    </SiteChrome>
  );
}
