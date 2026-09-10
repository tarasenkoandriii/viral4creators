import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header } from '../../../../components/Header';
import { getDictionary } from '../../../../lib/get-dictionary';
import { isLocale, locales, OG_LOCALES, type Locale } from '../../../../lib/i18n';
import {
  getBlogPost,
  listAllBlogPosts,
  BLOG_REVALIDATE_SECONDS,
} from '../../../../lib/blog-api';
import { TMA_URL, SITE_URL, SITE_NAME } from '../../../../lib/content';
import { jsonLdScript } from '../../../../lib/json-ld';
import { sanitizeBlogHtml } from '../../../../lib/sanitize-blog-html';

export const revalidate = BLOG_REVALIDATE_SECONDS;

/**
 * Слаги известны только с backend'а, а не на сборке из статического
 * массива (в отличие от /legal/[slug]) — TODO §II.3 требует статики+
 * ревалидации, а не похода в API на каждый заход, поэтому список слагов
 * забирается один раз при сборке для каждой уже разрешённой родителем
 * локали (см. `{ params }` — Next вызывает этот generateStaticParams
 * один раз НА КАЖДУЮ локаль из `[locale]/layout.tsx`, а не один общий
 * раз, и объединяет результат с уже известным `locale`).
 */
export async function generateStaticParams({
  params,
}: {
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) return [];
  const posts = await listAllBlogPosts(params.locale);
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: { locale: string; slug: string };
}): Promise<Metadata> {
  if (!isLocale(params.locale)) return {};
  const dict = getDictionary(params.locale);
  const post = await getBlogPost(params.slug, params.locale);
  if (!post) return { title: dict.blog.notFoundTitle };

  const languages = Object.fromEntries(
    locales.map((l) => [l, `/${l}/blog/${params.slug}`])
  );
  const description = stripHtml(post.bodyHtml).slice(0, 200);
  return {
    title: `${post.title}${dict.blog.metaTitleSuffix}`,
    description,
    alternates: { languages: { ...languages, 'x-default': `/ru/blog/${params.slug}` } },
    openGraph: {
      title: post.title,
      description,
      type: 'article',
      locale: OG_LOCALES[params.locale],
      images: post.thumbnailUrl ? [post.thumbnailUrl] : undefined,
      publishedTime: post.publishedAt ?? undefined,
    },
    twitter: {
      card: post.thumbnailUrl ? 'summary_large_image' : 'summary',
      title: post.title,
      description,
      images: post.thumbnailUrl ? [post.thumbnailUrl] : undefined,
    },
    robots: { index: post.isRequestedLocale, follow: true },
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export default async function BlogPostPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const locale: Locale = isLocale(params.locale) ? params.locale : 'ru';
  const dict = getDictionary(locale);
  const post = await getBlogPost(params.slug, locale);
  if (!post) notFound();

  // TODO §II.5: разметка Article/NewsArticle + BreadcrumbList — отдаётся
  // как JSON-LD, а не переизобретается разметкой руками в JSX. Все `url`/
  // `item` — АБСОЛЮТНЫЕ (SITE_URL): и sсhema.org, и большинство валидаторов
  // структурированных данных не принимают относительные пути.
  const pageUrl = `${SITE_URL}/${locale}/blog/${post.slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'NewsArticle',
        mainEntityOfPage: pageUrl,
        url: pageUrl,
        headline: post.title,
        image: post.thumbnailUrl ? [post.thumbnailUrl] : undefined,
        datePublished: post.publishedAt ?? undefined,
        articleSection: post.category,
        inLanguage: locale,
        publisher: { '@type': 'Organization', name: SITE_NAME },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: dict.blog.breadcrumbHome, item: `${SITE_URL}/${locale}` },
          { '@type': 'ListItem', position: 2, name: dict.blog.listTitle, item: `${SITE_URL}/${locale}/blog` },
          { '@type': 'ListItem', position: 3, name: post.title, item: pageUrl },
        ],
      },
    ],
  };

  return (
    <>
      <Header />
      <main className="wrap blog-page">
        <p className="blog-back">
          <Link href={`/${locale}/blog`}>{dict.blog.backToList}</Link>
        </p>

        <article className="blog-article">
          <div className="blog-article-category">{post.category}</div>
          <h1>{post.title}</h1>
          <p className="blog-article-meta">
            {post.publishedAt &&
              `${dict.blog.publishedLabel} ${new Date(post.publishedAt).toLocaleDateString(locale)}`}
          </p>

          {!post.isRequestedLocale && (
            <p className="blog-notice">{dict.blog.untranslatedNotice}</p>
          )}

          {post.youtubeVideoId && (
            <div className="blog-article-embed">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${post.youtubeVideoId}`}
                title={post.title}
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          )}

          {/* Г-3.1: backend уже санитизирует bodyHtml на входе в БД
              (blog-generation/blog-translation/adminCreateManual/
              adminUpdate — см. sanitize-blog-html.ts), здесь —
              дополнительный слой перед рендером на случай строк, заведённых
              до исправления или в обход backend'а. */}
          <div
            className="blog-article-body"
            dangerouslySetInnerHTML={{ __html: sanitizeBlogHtml(post.bodyHtml) }}
          />

          {post.youtubeVideoId && (
            <p className="blog-article-cta">
              <a className="cta cta-ghost" href={TMA_URL}>
                {dict.blog.sourceCta}
              </a>{' '}
              <a
                href={`https://youtube.com/watch?v=${post.youtubeVideoId}`}
                target="_blank"
                rel="noreferrer"
              >
                {dict.blog.watchOnYoutube}
              </a>
            </p>
          )}
        </article>
      </main>
      {/* eslint-disable-next-line react/no-danger */}
      <script
        type="application/ld+json"
        // Г-3.2: jsonLdScript экранирует `<` — `</script>` в
        // пользовательском title/description не обрывает тег раньше времени.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
    </>
  );
}
