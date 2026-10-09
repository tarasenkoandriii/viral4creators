import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { ClaimCard, ClaimSection, SoonBadge } from '../../../../components/Claim';
import { SiteChrome, StatusBanner } from '../../../../components/SiteChrome';
import { claimStatus, isVisible } from '../../../../lib/claims';
import { fmt } from '../../../../lib/format';
import { getDictionary } from '../../../../lib/get-dictionary';
import { INTL_LOCALES, type Locale } from '../../../../lib/i18n';
import { href, pageMetadata } from '../../../../lib/pages';
import { FEATURE_ROWS, formatNumber, formatUsd, PLANS, type AssistPlan } from '../../../../lib/plans';

/**
 * Тарифы (§3.8) — из `assist-plans.snapshot.json` (до Э4 продукта), не из
 * словарей. CTA — «в пилот», кнопки оплаты нет (точка С0, план §5). USD —
 * ориентир; оплата после запуска — гривна по курсу или Stars; EUR нет.
 * Таблицы — с `caption` и `th[scope]` (урок Ф-7). Калькулятор «сколько
 * диалогов нужно» (§3.8) — не в Л1: клиентский компонент без данных
 * продукта, вернётся вместе с живыми тарифами.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  return pageMetadata('pricing', (await params).locale);
}

export default async function PricingPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const dict = getDictionary(locale);
  const p = dict.pricing;
  const plans = PLANS.plans;
  const price = (plan: AssistPlan) => (plan.priceUsdMonthly === 0 ? formatUsd(0, locale) : formatUsd(plan.priceUsdMonthly, locale));
  const checkedDate = new Intl.DateTimeFormat(INTL_LOCALES[locale], { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${PLANS.checkedAt}T00:00:00Z`),
  );
  const trial = plans.find((x) => x.id === 'trial')!;
  const limitRows: Array<{ label: string; value: (plan: AssistPlan) => string }> = [
    { label: p.rows.price, value: (plan) => `${price(plan)}${p.perMonth}` },
    { label: p.rows.dialogs, value: (plan) => formatNumber(plan.dialogsPerMonth, locale) },
    { label: p.rows.sites, value: (plan) => formatNumber(plan.sites, locale) },
    { label: p.rows.pages, value: (plan) => formatNumber(plan.knowledgePages, locale) },
    { label: p.rows.documents, value: (plan) => formatNumber(plan.documents, locale) },
    { label: p.rows.operators, value: (plan) => formatNumber(plan.telegramOperators, locale) },
    { label: p.rows.retention, value: (plan) => formatNumber(plan.retentionDays, locale) },
    {
      label: p.rows.overage,
      value: (plan) => (plan.overageUsdPer100 === null ? p.overageStop : formatUsd(plan.overageUsdPer100, locale)),
    },
  ];
  const features = FEATURE_ROWS.filter((row) => isVisible(row.claim));

  return (
    <SiteChrome locale={locale} path="/assistant/pricing" current="pricing">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current="pricing" />
      <section className="hero wrap">
        <h1>{p.heading}</h1>
        <p className="lead">{p.lead}</p>
        <p className="note">{p.currencyNote}</p>
        <p className="actions">
          <a className="button" href={href(locale, 'pilot')}>
            {p.cta}
          </a>
        </p>
      </section>

      <ClaimSection claim="payment" dict={dict} heading={p.limitsCaption} headingId="plans-heading" className="section wrap">
        <div className="plans">
          {plans.map((plan) => (
            <div className="card" key={plan.id} data-plan-id={plan.id}>
              <h3>{p.plans[plan.id]}</h3>
              <p className="plan-price">
                {price(plan)}
                <small>{p.perMonth}</small>
              </p>
              {plan.trialDays !== null && <p className="note">{fmt(p.trialDays, { days: plan.trialDays })}</p>}
              <p>
                {p.rows.dialogs}: <strong>{formatNumber(plan.dialogsPerMonth, locale)}</strong>
                <br />
                {p.rows.sites}: <strong>{formatNumber(plan.sites, locale)}</strong>
              </p>
            </div>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <caption>{p.limitsCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{p.parameterColumn}</th>
                {plans.map((plan) => (
                  <th scope="col" key={plan.id}>
                    {p.plans[plan.id]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {limitRows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {plans.map((plan) => (
                    <td key={plan.id}>{row.value(plan)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{fmt(p.checked, { date: checkedDate })}</p>
      </ClaimSection>

      {features.length > 0 && (
        <section className="section section-alt" aria-labelledby="features-heading">
          <div className="wrap">
            <h2 id="features-heading">{p.featuresCaption}</h2>
            <div className="table-wrap">
              <table>
                <caption>{p.featuresCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{p.parameterColumn}</th>
                    {plans.map((plan) => (
                      <th scope="col" key={plan.id}>
                        {p.plans[plan.id]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {features.map((row) => {
                    const soon = claimStatus(row.claim) === 'soon';
                    return (
                      <tr key={row.key} className="claim" data-claim={row.claim} data-claim-status={claimStatus(row.claim)}>
                        <th scope="row">
                          {p.features[row.key as keyof typeof p.features]} {soon && <SoonBadge dict={dict} />}
                        </th>
                        {plans.map((plan) => (
                          <td key={plan.id}>{plan[row.key as keyof AssistPlan] ? p.yes : p.no}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="section wrap">
        <div className="grid">
          <ClaimCard
            className="card"
            claim="payment"
            dict={dict}
            title={p.dialogHeading}
            text={fmt(p.dialogText, {
              idle: PLANS.dialogRules.idleCloseMinutes,
              two: PLANS.dialogRules.countsAsTwoAfterReplies,
              three: PLANS.dialogRules.countsAsThreeAfterReplies,
            })}
          />
          <ClaimCard
            className="card"
            claim="payment"
            dict={dict}
            title={p.overageHeading}
            text={`${fmt(p.overageText, { minOverage: formatUsd(PLANS.minOveragePerDialogUsd, locale) })} ${fmt(p.annual, {
              percent: PLANS.annualDiscountPercent,
            })}`}
          />
          <ClaimCard className="card" claim={p.agency.claim} dict={dict} title={p.agency.title} text={p.agency.text} />
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="honest-heading">
        <div className="wrap">
          <h2 id="honest-heading">{p.honestHeading}</h2>
          <ul>
            {p.honest.map((line) => (
              <li key={line}>{fmt(line, { trialDialogs: formatNumber(trial.dialogsPerMonth, locale) })}</li>
            ))}
          </ul>
          <p className="actions">
            <a className="button" href={href(locale, 'pilot')}>
              {p.cta}
            </a>
          </p>
        </div>
      </section>
    </SiteChrome>
  );
}
