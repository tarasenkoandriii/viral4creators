import type { Metadata } from "next";
import { PRODUCT_LINKS } from "../../../brand";
import { QA_LINKS } from "../../../brand";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { SiteChrome } from "../../../components/SiteChrome";
import { getDictionary } from "../../../lib/get-dictionary";
import type { Locale } from "../../../lib/i18n";
import { href, pageMetadata } from "../../../lib/pages";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  return pageMetadata("qa", (await params).locale);
}
export default async function QaPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  const d = getDictionary(locale);
  const q = d.home.qa;
  const c = d.voiceLanding;
  return (
    <SiteChrome locale={locale} path="/qa" current="qa">
      <Breadcrumbs locale={locale} current="qa" />
      <section className="hero wrap">
        <p className="eyebrow">QA · Viral4Creators</p>
        <h1>{c.qaTitle}</h1>
        <p className="lead">{q.text}</p>
        <p className="actions">
          <a className="button" href={QA_LINKS.dashboard}>
            {q.cabinet}
          </a>
          <a className="button button-secondary" href={href(locale, "pilot")}>
            {c.qaCta}
          </a>
        </p>
      </section>
      <section className="section section-alt">
        <div className="wrap">
          <h2>{q.heading}</h2>
          <ul>
            {q.features.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p>{q.report}</p>
        </div>
      </section>
      <section className="section wrap">
        <h2>{q.quickTitle}</h2>
        <p>{q.quickText}</p>
        <a className="button" href={QA_LINKS.extension}>
          {q.download}
        </a>
        <h2>{q.flowTitle}</h2>
        <ol>
          {q.steps.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
        <p>{q.limits}</p>
        <p>{q.privacy}</p>
        <p>{q.roadmap}</p>
      </section>
      <section className="section section-alt">
        <div className="wrap">
          <h2>{c.beta}</h2>
          <p>{c.betaText}</p>
          <a href={PRODUCT_LINKS.sandbox}>Sandbox</a>
        </div>
      </section>
    </SiteChrome>
  );
}
