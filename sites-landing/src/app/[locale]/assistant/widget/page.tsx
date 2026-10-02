import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard, visibleClaims } from '../../../../components/Claim';
import { Configurator, type ConfiguratorStrings } from '../../../../components/Configurator';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { WIDGET_NAMES } from '../../../../brand';
import { assistEnv, draftsEndpoint, loaderUrl } from '../../../../lib/assist-env';
import { claimStatus } from '../../../../lib/claims';
import { fmt } from '../../../../lib/format';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { liveWidgetTag } from '../../../../lib/live-widget';
import { pageMetadata } from '../../../../lib/pages';
import { widgetMeasurement } from '../../../../lib/widget-measure';

/**
 * Виджет и конфигуратор — `/assistant/widget` (§3.6, §5; Л3). Блоки:
 * (1) конфигуратор (клиентский — суть страницы, §9 п.2; бюджет JS 160 КБ),
 * (2) 4 угла / своя кнопка / встраивание, (3) брендинг по тарифам,
 * (4) скорость — с нашим лабораторным замером, (5) доступность.
 * Страница существует, только пока `configurator` не `hidden`.
 */
export function generateMetadata({ params }: { params: { locale: Locale } }): Metadata {
  return pageMetadata('widget', params.locale);
}

/** `{brand}` подставляется на сервере; остальные плейсхолдеры — в компоненте. */
function withBrand<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\{brand\}/g, () => fmt('{brand}')) as T;
  if (Array.isArray(value)) return value.map(withBrand) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withBrand(v)])) as T;
  }
  return value;
}

export default function WidgetPage({ params }: { params: { locale: Locale } }) {
  const { locale } = params;
  const status = claimStatus('configurator');
  if (status === 'hidden') notFound();
  const dict = getDictionary(locale);
  const w = dict.widgetPage;
  const env = assistEnv();
  const live = liveWidgetTag(locale, env) !== null;
  const m = widgetMeasurement();
  const defaultGreetings = { uk: getDictionary('uk'), en: getDictionary('en'), ru: getDictionary('ru') };
  const perf = w.performance;

  return (
    <SiteChrome locale={locale} path="/assistant/widget" current="widget">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="widget" />
      <section className="hero wrap">
        <h1>{w.heading}</h1>
        <p className="lead">{w.lead}</p>
      </section>

      {status === 'soon' ? (
        <section className="section wrap">
          <ClaimCard as="div" claim="configurator" dict={dict} title={w.configurator.label} text={w.lead} />
        </section>
      ) : (
      <section className="section wrap claim claim-live" data-claim="configurator" data-claim-status="live" aria-label={w.configurator.label}>
        <Configurator
          strings={withBrand(w.configurator) as ConfiguratorStrings}
          locale={locale}
          defaultName={w.configurator.defaultName}
          defaultGreetings={{
            uk: defaultGreetings.uk.widgetPage.configurator.defaultGreeting,
            en: defaultGreetings.en.widgetPage.configurator.defaultGreeting,
            ru: defaultGreetings.ru.widgetPage.configurator.defaultGreeting,
          }}
          loaderSrc={loaderUrl(env)}
          anchor={WIDGET_NAMES.anchor}
          draftsEndpoint={draftsEndpoint(env)}
          botUsername={env.botUsername}
          liveWidget={live}
        />
        <ClaimCard as="div" claim={w.fonts.claim} dict={dict} title={w.fonts.title} text={w.fonts.text} className="cfg-fonts-claim" />
      </section>
      )}

      <section className="section section-alt" aria-labelledby="placement-heading">
        <div className="wrap">
          <h2 id="placement-heading">{w.placement.heading}</h2>
          <div className="grid">
            {visibleClaims(w.placement.items).map((item) => (
              <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={item.title} text={item.text} />
            ))}
          </div>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="tariffs-heading">
        <h2 id="tariffs-heading">{w.tariffs.heading}</h2>
        <div className="grid">
          {visibleClaims(w.tariffs.items).map((item) => (
            <ClaimCard key={item.title} className="card" claim={item.claim} dict={dict} title={fmt(item.title)} text={fmt(item.text)} />
          ))}
        </div>
      </section>

      {m && (
        <section className="section section-alt" aria-labelledby="perf-heading">
          <div className="wrap">
            <ClaimCard
              as="div"
              heading="h2"
              headingId="perf-heading"
              claim={perf.claim}
              dict={dict}
              title={perf.heading}
              text={fmt(perf.text, { loaderKb: m.loaderKb, chatKb: m.chatKb })}
            />
            <p className="perf-measured" data-claim-detail="live-widget">
              {fmt(perf.measured, { runs: m.runs, dLcp: m.dLcpMs, dTbt: m.dTbtMs, dCls: m.dCls })}
            </p>
            <p className="note">{fmt(perf.measuredNote, { date: m.dateText(locale) })}</p>
          </div>
        </section>
      )}

      <section className="section wrap" aria-labelledby="a11y-heading">
        <ClaimCard
          as="div"
          heading="h2"
          headingId="a11y-heading"
          claim={w.accessibility.claim}
          dict={dict}
          title={w.accessibility.heading}
          text={w.accessibility.text}
        />
      </section>
    </SiteChrome>
  );
}
