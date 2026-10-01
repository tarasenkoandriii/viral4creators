import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard, visibleClaims } from '../../../../components/Claim';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { href, pageMetadata } from '../../../../lib/pages';

/**
 * «Как работает» (§3.3). Скриншотов нет: продукта ещё нет, а рисунок за
 * скриншот не выдаём (§0). Блоки — по реестру утверждений.
 */
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return pageMetadata('how-it-works', params.locale);
}

export default function HowItWorksPage({ params }: { params: { locale: Locale } }) {
  const { locale } = params;
  const dict = getDictionary(locale);
  const h = dict.howItWorks;
  const lists: Array<{ id: string; heading: string; items: ReadonlyArray<{ claim: string; text: string }> }> = [
    { id: 'reads', heading: h.readsHeading, items: h.reads },
    { id: 'answers', heading: h.answersHeading, items: h.answers },
    { id: 'human', heading: h.humanHeading, items: h.human },
    { id: 'need', heading: h.needHeading, items: h.need },
  ];
  return (
    <SiteChrome locale={locale} path="/assistant/how-it-works" current="how-it-works">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="how-it-works" />
      <section className="hero wrap">
        <h1>{h.heading}</h1>
        <p className="lead">{h.lead}</p>
      </section>
      <section className="section wrap" aria-labelledby="hiw-steps">
        <h2 id="hiw-steps">{h.stepsHeading}</h2>
        <ol className="steps">
          {visibleClaims(h.steps).map((item) => (
            <ClaimCard key={item.title} as="li" claim={item.claim} dict={dict} title={item.title} text={item.text} />
          ))}
        </ol>
      </section>
      {lists.map((list, i) => {
        const items = visibleClaims(list.items);
        if (items.length === 0) return null;
        return (
          <section key={list.id} className={`section ${i % 2 === 0 ? 'section-alt' : ''}`} aria-labelledby={`hiw-${list.id}`}>
            <div className="wrap">
              <h2 id={`hiw-${list.id}`}>{list.heading}</h2>
              <ul className="list-claims">
                {items.map((item) => (
                  <ClaimCard key={item.text} as="li" claim={item.claim} dict={dict} text={item.text} />
                ))}
              </ul>
            </div>
          </section>
        );
      })}
      <section className="section wrap">
        <p className="actions">
          <a className="button" href={href(locale, 'pilot')}>
            {h.cta}
          </a>
        </p>
      </section>
    </SiteChrome>
  );
}
