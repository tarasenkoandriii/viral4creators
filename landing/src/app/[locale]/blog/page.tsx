import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '../../../components/Header';
import { getDictionary } from '../../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../../lib/i18n';
import { listBlogPosts } from '../../../lib/blog-api';
import { localeAlternates } from '../../../lib/alternates';
import { ogImageUrl, socialMeta } from '../../../lib/social-meta';
import { SITE_URL } from '../../../lib/content';

/**
 * Витрина блога (этап 58, TODO §II.3) — статическая генерация +
 * ревалидация, а НЕ поход в API на каждый заход посетителя: страница
 * собирается на сборке (пустой список, если backend недоступен —
 * getJson() в blog-api.ts не бросает) и обновляется раз в
 * BLOG_REVALIDATE_SECONDS секунд запросом с сервера Vercel, не из
 * браузера посетителя.
 */
// Литерал, а не `BLOG_REVALIDATE_SECONDS`: Next 15 читает конфиг сегмента
// статически, по исходнику, и импортированную константу отвергает ошибкой
// сборки (Next 14 брал значение из модуля). Равенство константе держит
// scripts/segment-config.test.ts.
export const revalidate = 900;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const dict = getDictionary(locale);
  return {
    title: `${dict.blog.listTitle}${dict.blog.metaTitleSuffix}`,
    description: dict.blog.listLead,
    alternates: localeAlternates(
      (l) => `${SITE_URL}/${l}/blog`,
      (l) => `/${l}/blog`,
      locale,
    ),
    ...socialMeta({
      title: `${dict.blog.listTitle}${dict.blog.metaTitleSuffix}`,
      description: dict.blog.listLead,
      url: `${SITE_URL}/${locale}/blog`,
      locale,
      image: ogImageUrl(SITE_URL, 'main', locale),
    }),
    robots: { index: true, follow: true },
  };
}

export default async function BlogListPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ru';
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
