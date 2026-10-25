import { MediaShowcase } from "../../components/MediaShowcase";
import type { Metadata } from 'next';
import { QA_LINKS } from '../../brand';
import { ClaimCard } from '../../components/Claim';
import { SiteChrome } from '../../components/SiteChrome';
import { fmt } from '../../lib/format';
import { claimStatus } from '../../lib/claims';
import { getDictionary } from '../../lib/get-dictionary';
import type { Locale } from '../../lib/i18n';
import { href, pageMetadata } from '../../lib/pages';

/**
 * Главная домена (§3.1): короткая витрина двух продуктов семейства —
 * Помощник и работающий QA MVP; полный аудит клиентских сайтов отделён от MVP.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return pageMetadata('home', (await params).locale);
}

export default async function HomePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const dict = getDictionary(locale);
  const h = dict.home;
  const qaLive = claimStatus('qa-product') === 'live';
  return (
    <SiteChrome locale={locale} path="" current="home">
      <section className="hero wrap home-hero">
        <h1>{fmt(h.hero.title)}</h1>
        <p className="lead">{fmt(h.hero.lead)}</p>
        <p className="actions">
          <a className="button" href={href(locale, 'pilot')}>
            {h.hero.cta}
          </a>
        </p>
      </section>
      <MediaShowcase locale={locale} product="voice" />
      <section className="section section-alt" aria-labelledby="products-heading">
        <div className="wrap">
          <h2 id="products-heading">{h.productsHeading}</h2>
          <div className="grid">
            {/* Ссылка на раздел — вне блока утверждения: это переход на
                честно помеченную страницу, а не кнопка «воспользоваться». */}
            <div className="card">
              <ClaimCard as="div" claim={h.assistant.claim} dict={dict} title={h.assistant.title} text={h.assistant.text} />
              <p className="claim-cta">
                <a href={href(locale, 'assistant')}>{h.assistant.more}</a>
              </p>
            </div>
            <div className="card">
              <ClaimCard as="div" claim={h.qa.claim} dict={dict} title={h.qa.title} text={h.qa.text} />
              {qaLive && <p><a href={href(locale, 'qa')}>{h.qa.more}</a></p>}
            </div>
          </div>
        </div>
      </section>
      <section className="section wrap"><h2>{dict.voiceLanding.nav}</h2><p>{dict.voiceLanding.lead}</p><p><a className="button" href={href(locale, 'hands-free')}>{dict.voiceLanding.nav}</a></p></section>
      {qaLive && <section id="qa" className="section wrap" aria-labelledby="qa-heading" data-claim="qa-product" data-claim-status="live">
        <h2 id="qa-heading">{h.qa.heading}</h2>
        <ul>{h.qa.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
        <p>{h.qa.report}</p>
        <div className="card">
          <h3>{h.qa.quickTitle}</h3>
          <p>{h.qa.quickText}</p>
          <p className="actions">
            <a className="button" href={QA_LINKS.extension}>{h.qa.download}</a>
            <a className="button" href={QA_LINKS.dashboard}>{h.qa.cabinet}</a>
          </p>
          <h3>{h.qa.flowTitle}</h3>
          <ol>{h.qa.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </div>
        <p>{h.qa.limits}</p>
        <p>{h.qa.privacy}</p>
        <p>{h.qa.roadmap}</p><h3>{dict.voiceLanding.beta}</h3><p>{dict.voiceLanding.betaText}</p>
      </section>}
      <section className="section wrap" aria-labelledby="pilot-heading">
        <ClaimCard
          as="div"
          heading="h2"
          headingId="pilot-heading"
          claim={h.pilot.claim}
          dict={dict}
          title={h.pilot.heading}
          text={h.pilot.text}
          cta={{ href: href(locale, 'pilot'), label: h.pilot.cta }}
        />
      </section>
    </SiteChrome>
  );
}
