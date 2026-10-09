import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard } from '../../../../components/Claim';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { claimStatus, isVisible } from '../../../../lib/claims';
import { fmt } from '../../../../lib/format';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { href, hrefLang, pageMetadata } from '../../../../lib/pages';
import { MORE_PLATFORMS, PLATFORMS } from '../../../../lib/platforms';

/**
 * Интеграции (Л5, §3.7): сетка платформ — названия текстом, без логотипов
 * (§13: «совместимо с», не «партнёр»). У каждой карточки — утверждение
 * своей страницы и пометка, как проверена инструкция.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return pageMetadata('integrations', (await params).locale);
}

export default async function IntegrationsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  if (claimStatus('integrations') === 'hidden') notFound();
  const dict = getDictionary(locale);
  const t = dict.integrations;
  return (
    <SiteChrome locale={locale} path="/assistant/integrations" current="integrations">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="integrations" />
      <section className="hero wrap">
        <h1>{t.heading}</h1>
        <p className="lead">{fmt(t.lead)}</p>
      </section>
      <section className="section wrap" aria-labelledby="int-grid">
        <h2 id="int-grid">{t.gridHeading}</h2>
        <div className="grid">
          {PLATFORMS.filter((p) => isVisible(p.claim)).map((p) => {
            const d = dict.platforms[p.slug];
            return (
              <ClaimCard
                key={p.slug}
                className="card"
                claim={p.claim}
                dict={dict}
                title={d.name}
                text={`${d.card} ${p.checked === 'stand' ? t.checkedStand : t.checkedDocs}`}
                cta={{ href: href(locale, `integrations-${p.slug}`), label: fmt(t.open, { name: d.name }), place: 'integrations' }}
              />
            );
          })}
          <ClaimCard className="card" claim="more-platforms" dict={dict} title={MORE_PLATFORMS.join(', ')} text={t.moreText} />
        </div>
      </section>
      <section className="section section-alt" aria-labelledby="int-common">
        <div className="wrap">
          <h2 id="int-common">{t.commonHeading}</h2>
          <ul className="list-claims">
            {t.common.map((item) => (
              <ClaimCard key={item.text} as="li" claim={item.claim} dict={dict} text={item.text} />
            ))}
          </ul>
          {isVisible('docs') && (
            <p className="claim-cta">
              <a className="button button-secondary" href={href(locale, 'docs')} hrefLang={hrefLang(locale, 'docs')} data-cta="integrations">
                {t.docsCta}
              </a>
            </p>
          )}
        </div>
      </section>
    </SiteChrome>
  );
}
