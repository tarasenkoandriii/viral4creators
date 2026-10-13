import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import Byline from '@/components/Byline';
import Cta from '@/components/Cta';
import Sources from '@/components/Sources';
import { PUBLISHER_BRAND, PUBLISHER_VERSION_META } from '@/brand';
import { getContent, listPublished } from '@/lib/api';
import { dict } from '@/lib/dict';
import { Markdown } from '@/lib/markdown';
import { pageMetadata, plainExcerpt } from '@/lib/page-meta';
import { absoluteUrl, siteHost } from '@/lib/site-url';

/**
 * Страница материала (ТЗ §8.2, проектный документ §13.2): основной текст —
 * в серверном HTML (читается без JS, AT-CORE-01), `<meta name="pub-version">`
 * с hash показанной версии. SSG по опубликованным + ISR 300 с; новые slug
 * собираются по первому запросу. Снятый материал — 410 (middleware →
 * `/gone/[slug]`); если страница уже была в кэше, ревалидация превращает
 * её в 404, а не оставляет снятый текст. CTA — после текста.
 */
export const revalidate = 300;

type Params = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return (await listPublished()).map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const r = await getContent(slug);
  if (r.kind !== 'ok') return { title: dict.meta.notFoundTitle, robots: { index: false, follow: false } };
  const c = r.content;
  return pageMetadata(`/materials/${slug}`, c.title, plainExcerpt(c.shortAnswer) ?? plainExcerpt(c.body) ?? c.title, {
    other: { [PUBLISHER_VERSION_META]: c.versionHash },
  });
}

/** JSON-LD статьи — без цен, оферт и рейтингов (check-built). */
function articleLd(
  slug: string,
  c: { title: string; editor: string | null; publishedAt: string | null; substantiallyUpdatedAt: string | null },
) {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: c.title,
    mainEntityOfPage: absoluteUrl(`/materials/${slug}`),
    inLanguage: 'uk',
    publisher: { '@type': 'Organization', name: PUBLISHER_BRAND.name },
  };
  if (c.editor) ld.author = { '@type': 'Person', name: c.editor };
  if (c.publishedAt) ld.datePublished = c.publishedAt;
  if (c.substantiallyUpdatedAt ?? c.publishedAt) ld.dateModified = c.substantiallyUpdatedAt ?? c.publishedAt;
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

export default async function MaterialPage({ params }: Params) {
  const { slug } = await params;
  const r = await getContent(slug);
  if (r.kind !== 'ok') notFound();
  const c = r.content;
  const t = dict.material;
  const md = { siteHost: siteHost() };
  return (
    <article className="page material" data-slug={slug}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: articleLd(slug, c) }} />
      <p className="crumbs">
        <Link href="/materials">{t.back}</Link>
      </p>
      {c.stage === 'test' ? <p className="badge">{t.testStage}</p> : null}
      <h1>{c.title}</h1>
      <Byline
        editor={c.editor}
        publishedAt={c.publishedAt}
        updatedAt={c.substantiallyUpdatedAt}
        labels={{ editor: t.editor, editorMissing: t.editorMissing, published: t.published, updated: t.updated }}
      />
      {c.shortAnswer ? (
        <section className="short-answer" aria-labelledby="short-title">
          <h2 id="short-title">{t.shortAnswer}</h2>
          <p>{c.shortAnswer}</p>
        </section>
      ) : null}
      <div className="prose" data-testid="material-body">
        <Markdown source={c.body} options={md} />
      </div>
      {c.example ? (
        <section aria-labelledby="example-title">
          <h2 id="example-title">{t.example}</h2>
          <div className="prose">
            <Markdown source={c.example} options={md} />
          </div>
        </section>
      ) : null}
      {c.limitations.length ? (
        <section aria-labelledby="limits-title">
          <h2 id="limits-title">{t.limitations}</h2>
          <ul>
            {c.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {c.sources.length ? (
        <section aria-labelledby="sources-title">
          <h2 id="sources-title">{t.sources}</h2>
          <Sources sources={c.sources} labels={{ privateSource: t.sourcePrivate, untitled: t.sourceUntitled }} />
        </section>
      ) : null}
      <section className="next-step" aria-labelledby="next-title">
        <h2 id="next-title">{t.nextStep}</h2>
        <Cta label={c.cta?.trim() || t.ctaFallback} id="material-next" material={slug} />
      </section>
    </article>
  );
}
