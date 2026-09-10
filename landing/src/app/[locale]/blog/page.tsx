import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '../../../components/Header';
import { getDictionary } from '../../../lib/get-dictionary';
import { isLocale, locales, OG_LOCALES, type Locale } from '../../../lib/i18n';
import { listBlogPosts, BLOG_REVALIDATE_SECONDS } from '../../../lib/blog-api';

/**
 * Витрина блога (этап 58, TODO §II.3) — статическая генерация +
 * ревалидация, а НЕ поход в API на каждый заход посетителя: страница
 * собирается на сборке (пустой список, если backend недоступен —
 * getJson() в blog-api.ts не бросает) и обновляется раз в
 * BLOG_REVALIDATE_SECONDS секунд запросом с сервера Vercel, не из
 * браузера посетителя.
 */
export const revalidate = BLOG_REVALIDATE_SECONDS;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  if (!isLocale(params.locale)) return {};
  const dict = getDictionary(params.locale);
  const languages = Object.fromEntries(locales.map((l) => [l, `/${l}/blog`]));
  return {
    title: `${dict.blog.listTitle}${dict.blog.metaTitleSuffix}`,
    description: dict.blog.listLead,
    alternates: { languages: { ...languages, 'x-default': '/ru/blog' } },
    openGraph: {
      title: `${dict.blog.listTitle}${dict.blog.metaTitleSuffix}`,
      description: dict.blog.listLead,
      type: 'website',
      locale: OG_LOCALES[params.locale],
    },
    robots: { index: true, follow: true },
  };
}

export default async function BlogListPage({
  params,
}: {
  params: { locale: string };
}) {
  const locale: Locale = isLocale(params.locale) ? params.locale : 'ru';
  const dict = getDictionary(locale);
  const page = await listBlogPosts({ locale, pageSize: 24 });
  const items = page?.items ?? [];

  return (
    <>
      <Header />
      <main className="wrap blog-page">
        <h1>{dict.blog.listTitle}</h1>
        <p className="blog-lead">{dict.blog.listLead}</p>

        {items.length === 0 ? (
          <p className="blog-empty">{dict.blog.empty}</p>
        ) : (
          <div className="blog-grid">
            {items.map((item) => (
              <Link
                key={item.slug}
                href={`/${locale}/blog/${item.slug}`}
                className="blog-card"
              >
                {item.thumbnailUrl && (
                  // Обложка YouTube по прямой ссылке — права на чужие
                  // ролики не позволяют перезаливать её (TODO §II.3).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="blog-card-thumb" src={item.thumbnailUrl} alt="" />
                )}
                <div className="blog-card-body">
                  <span className="blog-card-category">{item.category}</span>
                  <h2 className="blog-card-title">{item.title}</h2>
                  <span className="blog-card-meta">
                    {!item.isRequestedLocale && `${dict.blog.untranslatedNotice} · `}
                    {item.publishedAt &&
                      new Date(item.publishedAt).toLocaleDateString(locale)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
