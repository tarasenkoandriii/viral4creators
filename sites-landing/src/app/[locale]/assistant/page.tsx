import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../components/Breadcrumbs';
import { ClaimCard, visibleClaims } from '../../../components/Claim';
import { Faq } from '../../../components/Faq';
import { JsonLd } from '../../../components/JsonLd';
import { SiteChrome, StatusBanner } from '../../../components/SiteChrome';
import { BRAND } from '../../../brand';
import { heroVariant, isVisible } from '../../../lib/claims';
import { liveWidgetTag } from '../../../lib/live-widget';
import { WidgetPlayground } from '../../../components/WidgetPlayground';
import { faqGroups } from '../../../lib/faq';
import { fmt } from '../../../lib/format';
import { getDictionary } from '../../../lib/get-dictionary';
import type { Locale } from '../../../lib/i18n';
import { href, pageMetadata } from '../../../lib/pages';
import { formatNumber, formatUsd, PLANS } from '../../../lib/plans';
import { siteUrl } from '../../../lib/site-url';

/**
 * Главная Помощника (§3.2), точка С2 плана (Л2–Л3): hero выводится из
 * реестра (`heroVariant()` → «answers»), блок 2 — живой виджет с панелью
 * «покрутите виджет» (если в сборке есть ключ нашего виджета; иначе —
 * место под запись, `demo-recording` — «скоро»), блок 6 ведёт в
 * конфигуратор. CTA — заявка в пилот. «Попробовать на своём сайте»,
 * «Подключить в Telegram» и сравнение — `hidden` (Л4–Л5) и в разметке
 * отсутствуют.
 */
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return pageMetadata('assistant', params.locale);
}

export default function AssistantPage({ params }: { params: { locale: Locale } }) {
  const { locale } = params;
  const dict = getDictionary(locale);
  const a = dict.assistant;
  const hero = a.hero[heroVariant()];
  const liveTag = liveWidgetTag(locale);
  const plan = (id: string) => PLANS.plans.find((p) => p.id === id)!;
  const faqTeaser = faqGroups(locale)
    .flatMap((g) => g.items)
    .slice(0, 6);

  return (
    <SiteChrome locale={locale} path="/assistant" current="assistant">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="assistant" />
      <section className="hero wrap" data-hero-variant={heroVariant()}>
        <p className="eyebrow">{hero.eyebrow}</p>
        <h1>{hero.title}</h1>
        <p className="lead">{hero.lead}</p>
        {hero.note && <p className="note">{hero.note}</p>}
        <p className="actions">
          <a className="button" href={href(locale, 'pilot')} data-cta="hero">
            {hero.cta}
          </a>
          <a className="button button-secondary" href={href(locale, 'how-it-works')} data-cta="hero">
            {hero.secondary}
          </a>
        </p>
      </section>

      {/* Блок 2 (§3.2): живой виджет — если он есть в сборке (Л2, С2);
          иначе место под запись с честной подписью. */}
      {liveTag ? (
        <section className="section wrap" aria-labelledby="live-heading">
          <div className="live-block">
            <ClaimCard
              as="div"
              heading="h2"
              headingId="live-heading"
              claim={a.live.claim}
              dict={dict}
              title={a.live.heading}
              text={fmt(a.live.text)}
            />
            <p className="note">{a.live.note}</p>
            <WidgetPlayground strings={a.live.playground} />
            {isVisible('configurator') && (
              <p className="claim-cta">
                <a href={href(locale, 'widget')} data-cta="playground">
                  {a.live.more}
                </a>
              </p>
            )}
          </div>
        </section>
      ) : (
        <section className="section wrap" aria-labelledby="recording-heading">
          <ClaimCard
            as="div"
            heading="h2"
            headingId="recording-heading"
            claim={a.recording.claim}
            dict={dict}
            title={a.recording.heading}
            text={a.recording.text}
          />
          <figure className="recording">
            <div className="recording-frame" role="img" aria-label={a.recording.placeholder}>
              <span>{a.recording.placeholder}</span>
            </div>
            <figcaption>{a.recording.caption}</figcaption>
          </figure>
        </section>
      )}

      <section className="section section-alt" aria-labelledby="promises-heading">
        <div className="wrap">
          <h2 id="promises-heading">{a.promises.heading}</h2>
          <div className="grid">
            {visibleClaims(a.promises.items).map((item) => (
              <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={item.title} text={item.text} />
            ))}
          </div>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="steps-heading">
        <h2 id="steps-heading">{a.steps.heading}</h2>
        <ol className="steps">
          {visibleClaims(a.steps.items).map((item) => (
            <ClaimCard key={item.title} as="li" claim={item.claim} dict={dict} title={item.title} text={item.text} />
          ))}
        </ol>
        <p className="claim-cta">
          <a href={href(locale, 'how-it-works')}>{a.steps.more}</a>
        </p>
      </section>

      <section className="section section-alt" aria-labelledby="modes-heading">
        <div className="wrap">
          <h2 id="modes-heading">{a.modes.heading}</h2>
          <div className="grid">
            {visibleClaims(a.modes.items).map((item) => (
              <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={item.title} text={item.text} />
            ))}
          </div>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="branding-heading">
        <ClaimCard
          as="div"
          heading="h2"
          headingId="branding-heading"
          claim={a.branding.claim}
          dict={dict}
          title={a.branding.heading}
          text={a.branding.text}
          cta={isVisible('configurator') ? { href: href(locale, 'widget'), label: a.branding.cta, place: 'branding' } : undefined}
        />
      </section>

      <section className="section section-alt" aria-labelledby="install-heading">
        <div className="wrap">
          <h2 id="install-heading">{a.install.heading}</h2>
          <div className="grid">
            {visibleClaims(a.install.items).map((item) => (
              <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={item.title} text={item.text} />
            ))}
          </div>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="limits-heading">
        <h2 id="limits-heading">{a.limits.heading}</h2>
        <div className="grid">
          {visibleClaims(a.limits.items).map((item) => (
            <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={item.title} text={item.text} />
          ))}
        </div>
        <p className="claim-cta">
          <a href={href(locale, 'security')}>{a.limits.more}</a>
        </p>
      </section>

      <section className="section section-alt" aria-labelledby="pricing-teaser-heading">
        <div className="wrap">
          <ClaimCard
            as="div"
            heading="h2"
            headingId="pricing-teaser-heading"
            claim="payment"
            dict={dict}
            title={a.pricingTeaser.heading}
            text={fmt(a.pricingTeaser.text, {
              start: formatNumber(plan('start').dialogsPerMonth, locale),
              business: formatNumber(plan('business').dialogsPerMonth, locale),
              pro: formatNumber(plan('pro').dialogsPerMonth, locale),
              minOverage: formatUsd(PLANS.minOveragePerDialogUsd, locale),
            })}
          />
          <p className="claim-cta">
            <a href={href(locale, 'pricing')}>{a.pricingTeaser.more}</a>
          </p>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="pilot-block-heading">
        <ClaimCard
          as="div"
          heading="h2"
          headingId="pilot-block-heading"
          claim={a.pilot.claim}
          dict={dict}
          title={a.pilot.heading}
          text={a.pilot.text}
          cta={{ href: href(locale, 'pilot'), label: a.pilot.cta, place: 'pilot' }}
        />
      </section>

      <section className="section section-alt" aria-labelledby="faq-teaser-heading">
        <div className="wrap">
          <h2 id="faq-teaser-heading">{a.faqTeaser.heading}</h2>
          <Faq items={faqTeaser} soonLabel={dict.common.soon} soonTitle={dict.common.soonTitle} />
          <p className="claim-cta">
            <a href={href(locale, 'faq')}>{a.faqTeaser.more}</a>
          </p>
        </div>
      </section>

      {/* SoftwareApplication без `offers`: оплаты нет до Э4 (claim payment), а
          цена в разметке читалась бы как «можно купить». AggregateRating — никогда
          без реальных отзывов (§8.3). */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: `${BRAND.name} — ${dict.common.nav.assistant}`,
          applicationCategory: 'BusinessApplication',
          operatingSystem: 'Web',
          url: `${siteUrl()}${href(locale, 'assistant')}`,
          description: fmt(dict.pages.assistant.description),
          inLanguage: locale,
        }}
      />
    </SiteChrome>
  );
}
