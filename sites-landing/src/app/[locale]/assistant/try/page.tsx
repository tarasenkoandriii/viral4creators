import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard } from '../../../../components/Claim';
import { SandboxTry, type SandboxStrings } from '../../../../components/SandboxTry';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { BRAND } from '../../../../brand';
import { assistEnv } from '../../../../lib/assist-env';
import { claimStatus, isVisible } from '../../../../lib/claims';
import { fmt } from '../../../../lib/format';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { href, pageMetadata } from '../../../../lib/pages';
import { SANDBOX_PUBLIC_LIMITS, sandboxEndpoint } from '../../../../lib/sandbox';

/**
 * «Попробовать на своём сайте» — песочница по URL (Л4, §6). Клиентский
 * компонент — суть страницы (§9 п.2, бюджет JS 160 КБ); остальное —
 * серверная разметка: лимиты, чего песочница не делает, скриншот («скоро»,
 * только на воркере QA), владельцам сайтов — страница бота и opt-out.
 * Страница существует, пока `sandbox` не `hidden`. Результат песочницы — не
 * адрес, а состояние вкладки: OG, индексации и публичной ссылки у него нет.
 */
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return pageMetadata('try', params.locale);
}

function withBrand<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\{brand\}/g, () => BRAND.name) as T;
  if (Array.isArray(value)) return value.map(withBrand) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withBrand(v)])) as T;
  return value;
}

export default function TryPage({ params }: { params: { locale: Locale } }) {
  const { locale } = params;
  const status = claimStatus('sandbox');
  if (status === 'hidden') notFound();
  const dict = getDictionary(locale);
  const t = dict.tryPage;
  const env = assistEnv();
  const limits = {
    pages: SANDBOX_PUBLIC_LIMITS.pages,
    questions: SANDBOX_PUBLIC_LIMITS.questions,
    hours: SANDBOX_PUBLIC_LIMITS.ttlHours,
    perDay: SANDBOX_PUBLIC_LIMITS.perIpPerDay,
  };
  return (
    <SiteChrome locale={locale} path="/assistant/try" current="try">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="try" />
      <section className="hero wrap">
        <h1>{t.heading}</h1>
        <p className="lead">{fmt(t.lead, limits)}</p>
      </section>

      {status === 'soon' ? (
        <section className="section wrap">
          <ClaimCard as="div" claim="sandbox" dict={dict} title={t.heading} text={fmt(t.lead, limits)} />
        </section>
      ) : (
        <section className="section wrap claim claim-live sb" data-claim="sandbox" data-claim-status="live" aria-label={t.sandbox.formLabel} data-testid="sandbox">
          <SandboxTry
            strings={withBrand(t.sandbox) as SandboxStrings}
            endpoint={sandboxEndpoint(env.apiOrigin)}
            botUsername={env.botUsername}
            pilotHref={href(locale, 'pilot')}
            widgetHref={isVisible('configurator') ? href(locale, 'widget') : null}
            brandName={BRAND.name}
            locale={locale}
          />
        </section>
      )}

      <section className="section section-alt" aria-labelledby="try-limits">
        <div className="wrap">
          <h2 id="try-limits">{t.limitsHeading}</h2>
          <ul className="list-claims">
            {t.limits.map((item) => (
              <ClaimCard key={item.text} as="li" claim={item.claim} dict={dict} text={fmt(item.text, limits)} />
            ))}
          </ul>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="try-not">
        <h2 id="try-not">{t.notHeading}</h2>
        <ul className="list-claims">
          {t.not.map((item) => (
            <ClaimCard key={item.text} as="li" claim={item.claim} dict={dict} text={fmt(item.text, limits)} />
          ))}
        </ul>
        <ClaimCard as="div" claim={t.screenshot.claim} dict={dict} title={t.screenshot.title} text={t.screenshot.text} className="card" />
      </section>

      <section className="section section-alt" aria-labelledby="try-owners">
        <div className="wrap">
          <ClaimCard
            as="div"
            heading="h2"
            headingId="try-owners"
            claim={t.owners.claim}
            dict={dict}
            title={t.owners.title}
            text={t.owners.text}
            cta={{ href: href(locale, 'bot'), label: t.owners.cta, place: 'bot' }}
          />
          <p className="note">
            {t.privacy} <a href="/legal/privacy">{dict.common.footer.privacy}</a>
          </p>
        </div>
      </section>
    </SiteChrome>
  );
}
