import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { Faq } from '../../../../components/Faq';
import { JsonLd } from '../../../../components/JsonLd';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { faqGroups } from '../../../../lib/faq';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { pageMetadata } from '../../../../lib/pages';

/**
 * FAQ (§3.12). Вопросы — по реестру: `hidden` нет ни в HTML, ни в
 * `FAQPage`; `soon` — с меткой. `FAQPage` — для семантики и ИИ-поиска,
 * не ради сниппета (§8.3).
 */
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return pageMetadata('faq', params.locale);
}

export default function FaqPage({ params }: { params: { locale: Locale } }) {
  const { locale } = params;
  const dict = getDictionary(locale);
  const groups = faqGroups(locale);
  return (
    <SiteChrome locale={locale} path="/assistant/faq" current="faq">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="faq" />
      <section className="hero wrap">
        <h1>{dict.faq.heading}</h1>
        <p className="lead">{dict.faq.lead}</p>
      </section>
      <div className="section wrap">
        {groups.map((g, i) => (
          <section key={g.title} className="faq-group" aria-labelledby={`faq-g${i}`}>
            <h2 id={`faq-g${i}`}>{g.title}</h2>
            <Faq items={g.items} soonLabel={dict.common.soon} soonTitle={dict.common.soonTitle} />
          </section>
        ))}
      </div>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: locale,
          mainEntity: groups
            .flatMap((g) => g.items)
            .map((item) => ({
              '@type': 'Question',
              name: item.q,
              acceptedAnswer: { '@type': 'Answer', text: item.soon ? `(${dict.common.soon}) ${item.a}` : item.a },
            })),
        }}
      />
    </SiteChrome>
  );
}
