import type { Metadata } from 'next';
import Link from 'next/link';
import AltContact from '@/components/AltContact';
import Cta from '@/components/Cta';
import Faq from '@/components/Faq';
import { PUBLISHER_BRAND } from '@/brand';
import { altContactOf, faqOf, getSiteConfig, listPublished } from '@/lib/api';
import { dict, fmt } from '@/lib/dict';
import { Markdown } from '@/lib/markdown';
import { pageMetadata, plainExcerpt } from '@/lib/page-meta';
import { siteHost } from '@/lib/site-url';

/**
 * Посадочная (ТЗ §8.1, проектный документ §13.2). Факты — только из
 * данных: оффер и цена — активный оффер (`offer.title/text/priceNote`),
 * FAQ — активные факты `faq`, контакты — `alt_contact`, пример — настоящий
 * опубликованный материал. Нет данных — честная строка «ещё не
 * затверджено», а не выдуманная цифра, отзыв или гарантия. Тексты о
 * процессе (шаги, AI и люди, отдельный бюджет продвижения) — словарь,
 * по ТЗ §1, §13, без чисел и обещаний результата.
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await getSiteConfig();
  return pageMetadata('/', null, plainExcerpt(cfg.offer?.text) ?? dict.meta.homeDescription);
}

export default async function Home() {
  const [cfg, published] = await Promise.all([getSiteConfig(), listPublished()]);
  const h = dict.home;
  const offer = cfg.offer;
  const faq = faqOf(cfg.faq);
  const example = published[0] ?? null;
  const md = { siteHost: siteHost() };
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <p className="kicker">{fmt(h.kicker, { positioning: PUBLISHER_BRAND.positioning })}</p>
        <h1 id="hero-title">{offer?.title?.trim() || PUBLISHER_BRAND.name}</h1>
        <p className="lead">{h.lead}</p>
        <Cta label={h.cta} id="home-hero" />
      </section>

      <section aria-labelledby="offer-title" data-block="offer">
        <h2 id="offer-title">{h.offerTitle}</h2>
        {offer?.text?.trim() ? (
          <div className="prose">
            <Markdown source={offer.text} options={md} />
          </div>
        ) : (
          <p className="pending">{h.offerMissing}</p>
        )}
      </section>

      <section aria-labelledby="steps-title" data-block="steps">
        <h2 id="steps-title">{h.stepsTitle}</h2>
        <ol className="steps">
          {h.steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="ai-title" data-block="ai-human">
        <h2 id="ai-title">{h.aiTitle}</h2>
        <ul className="split">
          <li>
            <strong>{h.aiLabel}</strong> {h.aiText}
          </li>
          <li>
            <strong>{h.humanLabel}</strong> {h.humanText}
          </li>
        </ul>
      </section>

      <section aria-labelledby="example-title" data-block="example">
        <h2 id="example-title">{h.exampleTitle}</h2>
        {example ? (
          <div className="card">
            <h3>
              <Link href={`/materials/${example.slug}`}>{example.title ?? example.slug}</Link>
            </h3>
            {example.description ? <p>{example.description}</p> : null}
            <p>
              <Link href="/materials">{h.exampleAll}</Link>
            </p>
          </div>
        ) : (
          <p className="pending">{h.exampleMissing}</p>
        )}
      </section>

      <section aria-labelledby="price-title" data-block="price">
        <h2 id="price-title">{h.priceTitle}</h2>
        {offer?.priceNote?.trim() ? <p>{offer.priceNote}</p> : <p className="pending">{h.priceMissing}</p>}
        <h3>{h.priceFactorsTitle}</h3>
        <ul>
          {h.priceFactors.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="promo-title" data-block="promo-budget">
        <h2 id="promo-title">{h.promoTitle}</h2>
        <p>{h.promoText}</p>
      </section>

      <section aria-labelledby="faq-title" data-block="faq">
        <h2 id="faq-title">{h.faqTitle}</h2>
        {faq.length ? <Faq items={faq} /> : <p className="pending">{h.faqMissing}</p>}
      </section>

      <section aria-labelledby="contacts-title" data-block="contacts">
        <h2 id="contacts-title">{h.contactsTitle}</h2>
        <p>
          <Link href="/contact">{h.contactsForm}</Link>
        </p>
        <AltContact
          value={altContactOf(cfg.altContact)}
          label={dict.chrome.altContact}
          missing={dict.chrome.altContactMissing}
        />
        <p>
          {h.contactsNotice} <Link href="/privacy">{dict.chrome.dataNotice}</Link>
        </p>
      </section>
    </>
  );
}
