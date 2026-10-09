import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimSection } from '../../../../components/Claim';
import { PilotForm } from '../../../../components/PilotForm';
import { SiteChrome } from '../../../../components/SiteChrome';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { pageMetadata } from '../../../../lib/pages';

/**
 * Заявка в пилот (§3.11; В-13 ТЗ TMA: 3–5 сайтов, 2 месяца бесплатно,
 * доступ к диалогам для eval по DPA). Форма → `POST /api/pilot` →
 * служебный Telegram-канал (см. `server/pilot-handler.ts`). Пока кейсов
 * нет, `/cases` не существует (урок Б-3), в навигации — «Пилот».
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return pageMetadata('pilot', (await params).locale);
}

export default async function PilotPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const dict = getDictionary(locale);
  const p = dict.pilot;
  return (
    <SiteChrome locale={locale} path="/assistant/pilot" current="pilot">
      <Breadcrumbs locale={locale} current="pilot" />
      <section className="hero wrap">
        <h1>{p.heading}</h1>
        <p className="lead">{p.lead}</p>
      </section>
      <ClaimSection claim="pilot-form" dict={dict} heading={p.termsHeading} headingId="terms-heading" className="section wrap">
        <ul>
          {p.terms.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </ClaimSection>
      <section className="section section-alt">
        <div className="wrap">
          <PilotForm locale={locale} strings={p.form} privacyHref="/legal/privacy" />
        </div>
      </section>
    </SiteChrome>
  );
}
