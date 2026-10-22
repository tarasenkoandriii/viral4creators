import { MediaShowcase } from "../../../components/MediaShowcase";
import type { Metadata } from "next";
import { PRODUCT_LINKS } from "../../../brand";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { PilotContact } from "../../../components/PilotContact";
import { SiteChrome } from "../../../components/SiteChrome";
import { getDictionary } from "../../../lib/get-dictionary";
import type { Locale } from "../../../lib/i18n";
import { href, pageMetadata } from "../../../lib/pages";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  return pageMetadata("hands-free", (await params).locale);
}
export default async function VoicePage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  const d = getDictionary(locale);
  const c = d.voiceLanding;
  return (
    <SiteChrome locale={locale} path="/hands-free" current="hands-free">
      <Breadcrumbs locale={locale} current="hands-free" />
      <section className="hero wrap voice-hero">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lead">{c.lead}</p>
        <p className="actions">
          <a className="button" href="#pilot">
            {c.pilot}
          </a>
          <a className="button button-secondary" href={PRODUCT_LINKS.sandbox}>
            {c.demo}
          </a>
        </p>
        <p className="voice-proof">{c.proof}</p>
        <figure className="voice-example">
          <figcaption>{c.exampleLabel}</figcaption>
          <h2>{c.exampleTitle}</h2>
          <blockquote>{c.exampleUser}</blockquote>
          <p>{c.examplePlan}</p>
          <div className="voice-assurances">
            <span>{c.exampleConfirm}</span>
            <span>{c.exampleStop}</span>
          </div>
          <p className="voice-example-note">{c.exampleNote}</p>
        </figure>
      </section>
      <MediaShowcase locale={locale} product="voice" />
      <section className="section wrap">
        <h2>{c.usesTitle}</h2>
        <div className="grid">
          {c.uses.map((item) => (
            <article className="card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="section section-alt">
        <div className="wrap">
          <div className="grid">
            <article className="card">
              <h2>{c.dialog}</h2>
              <p>{c.dialogText}</p>
            </article>
            <article className="card">
              <h2>{c.control}</h2>
              <p>{c.controlText}</p>
            </article>
          </div>
          <ol className="voice-flow">
            {c.flow.map((step, i) => (
              <li key={step}>
                <span aria-hidden="true">0{i + 1}</span>
                <strong>{step}</strong>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="section wrap">
        <h2>{c.boundaries}</h2>
        <p>{c.limits}</p>
        <p>{c.safety}</p>
      </section>
      <section className="section section-alt">
        <div className="wrap">
          <h2>{c.family}</h2>
          <p>{c.familyText}</p>
          <p className="actions">
            <a href={PRODUCT_LINKS.tutorial}>Tutorial</a>
            <a href={href(locale, "assistant")}>{d.common.nav.assistant}</a>
            <a href={href(locale, "qa")}>{c.qaNav}</a>
          </p>
        </div>
      </section>
      <section id="pilot" className="section wrap">
        <h2>{c.pilotTitle}</h2>
        <ol className="voice-pilot-steps">
          {c.pilotSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>{c.pilotNote}</p>
        <p>{c.task}</p>
        <PilotContact
          locale={locale}
          strings={{ ...d.pilot.form, message: c.task }}
          privacyHref="/legal/privacy"
        />
      </section>
      <section className="section section-alt">
        <div className="wrap voice-faq">
          <h2>{c.faqTitle}</h2>
          {c.faq.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </SiteChrome>
  );
}
