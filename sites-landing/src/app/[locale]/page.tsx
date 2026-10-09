import type { Metadata } from 'next';
import { ClaimCard } from '../../components/Claim';
import { SiteChrome } from '../../components/SiteChrome';
import { fmt } from '../../lib/format';
import { getDictionary } from '../../lib/get-dictionary';
import type { Locale } from '../../lib/i18n';
import { href, pageMetadata } from '../../lib/pages';

/**
 * Главная домена (§3.1): короткая витрина двух продуктов семейства —
 * Помощник (посадочная — `/assistant`) и QA (`soon`, раздел делает автор
 * QA-ТЗ в этой же оболочке).
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return pageMetadata('home', (await params).locale);
}

export default async function HomePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const dict = getDictionary(locale);
  const h = dict.home;
  return (
    <SiteChrome locale={locale} path="" current="home">
      <section className="hero wrap">
        <h1>{fmt(h.hero.title)}</h1>
        <p className="lead">{fmt(h.hero.lead)}</p>
        <p className="actions">
          <a className="button" href={href(locale, 'pilot')}>
            {h.hero.cta}
          </a>
        </p>
      </section>
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
            </div>
          </div>
        </div>
      </section>
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
