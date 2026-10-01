import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard, visibleClaims } from '../../../../components/Claim';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { href, pageMetadata } from '../../../../lib/pages';

/**
 * Безопасность и приватность (§3.10). Формулировки — без «гарантируем» и
 * «невозможно взломать» (§13). Про продукт — `soon`; про сам лендинг
 * (`landing-no-trackers`) — `live`, это правда уже сейчас.
 */
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return pageMetadata('security', params.locale);
}

export default function SecurityPage({ params }: { params: { locale: Locale } }) {
  const { locale } = params;
  const dict = getDictionary(locale);
  const s = dict.security;
  return (
    <SiteChrome locale={locale} path="/assistant/security" current="security">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="security" />
      <section className="hero wrap">
        <h1>{s.heading}</h1>
        <p className="lead">{s.lead}</p>
      </section>
      <section className="section wrap" aria-labelledby="site-now-heading">
        <div className="card">
          <ClaimCard
            as="div"
            heading="h2"
            headingId="site-now-heading"
            claim={s.siteNow.claim}
            dict={dict}
            title={s.siteNow.heading}
            text={s.siteNow.text}
            cta={{ href: '/legal/privacy', label: s.siteNow.more }}
          />
        </div>
      </section>
      <section className="section section-alt" aria-label={s.heading}>
        <div className="wrap grid">
          {visibleClaims(s.items).map((item) => (
            <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={item.title} text={item.text} />
          ))}
        </div>
      </section>
      <section className="section wrap" aria-labelledby="open-heading">
        <h2 id="open-heading">{s.openHeading}</h2>
        <ul>
          {s.open.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="note">{s.wording}</p>
        <p className="actions">
          <a className="button" href={href(locale, 'pilot')}>
            {s.cta}
          </a>
        </p>
      </section>
    </SiteChrome>
  );
}
