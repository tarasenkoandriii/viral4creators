import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getCreatorProfile,
  getPortfolioItem,
  getSimilarPortfolioItems,
} from '../../../../lib/api';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { ViewPing } from '../../../../components/ViewPing';
import { LikeButton } from '../../../../components/LikeButton';
import { ShareButtons } from '../../../../components/ShareButtons';
import { QrCode } from '../../../../components/QrCode';
import { CrossPostPanel } from '../../../../components/CrossPostPanel';
import { jsonLdScript } from '../../../../lib/json-ld';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

/**
 * Отдельная публичная страница одной работы (ТЗ §20) — своя шарабельная
 * ссылка per-item. Нужна для #3 (OG-превью, opengraph-image.tsx рядом),
 * #12 (заготовка под Stories), #16 (VideoObject) и теперь #15 (локаль).
 */

export async function generateMetadata({
  params,
}: {
  params: { locale: Locale; id: string };
}): Promise<Metadata> {
  const item = await getPortfolioItem(params.id);
  if (!item) return {};
  return {
    title: item.title,
    alternates: { canonical: `${SITE_URL}/${params.locale}/item/${item.id}` },
    openGraph: { title: item.title, type: 'video.other', videos: [{ url: item.videoUrl }] },
    robots: { index: item.likeCount > 0 || item.viewCount > 0, follow: true },
  };
}

export default async function PortfolioItemPage({
  params,
}: {
  params: { locale: Locale; id: string };
}) {
  const { locale, id } = params;
  const dict = getDictionary(locale);
  const item = await getPortfolioItem(id);
  if (!item) notFound();

  const [creator, similar] = await Promise.all([
    getCreatorProfile(item.creatorProfileId),
    getSimilarPortfolioItems(item.id),
  ]);

  const pageUrl = `${SITE_URL}/${locale}/item/${item.id}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: item.title,
    uploadDate: item.createdAt,
    thumbnailUrl: item.thumbnailUrl ?? undefined,
    contentUrl: item.videoUrl,
    embedUrl: `${SITE_URL}/embed/${item.creatorProfileId}`,
    creator: creator
      ? { '@type': 'Person', name: creator.displayName ?? undefined, url: `${SITE_URL}/${locale}/creator/${creator.id}` }
      : undefined,
  };

  return (
    <>
      <ViewPing kind="portfolio-item" id={item.id} />

      <p className="mp-hint">
        <Link href={creator ? `/${locale}/creator/${creator.slug ?? creator.id}` : `/${locale}`}>
          ← {creator?.displayName ?? dict.profile.portfolioHeading}
        </Link>
      </p>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- пользовательский UGC-ролик, как остальные плееры проекта */}
      <video src={item.videoUrl} controls playsInline poster={item.thumbnailUrl ?? undefined} style={{ maxHeight: '70vh', margin: '0 auto' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{item.title}</h1>
        <LikeButton itemId={item.id} initialCount={item.likeCount} initialLiked={item.likedByViewer} />
      </div>
      <p className="mp-hint">
        {item.viewCount} {dict.item.viewsSuffix}
      </p>

      <h2>{dict.item.shareHeading}</h2>
      <ShareButtons url={pageUrl} title={item.title} />
      <div style={{ margin: '16px 0' }}>
        <QrCode data={pageUrl} />
      </div>
      <p className="mp-hint">
        <a href={`/${locale}/item/${item.id}/story-image`} target="_blank" rel="noreferrer">
          {dict.item.downloadStory}
        </a>
      </p>

      <h2>{dict.item.crossPostHeading}</h2>
      <CrossPostPanel videoUrl={pageUrl} title={item.title} />

      {similar.length > 0 && (
        <>
          <h2>{dict.item.similarHeading}</h2>
          <div className="mp-portfolio-grid">
            {similar.map((s) => (
              <Link key={s.id} href={`/${locale}/item/${s.id}`} className="mp-portfolio-item" style={{ textDecoration: 'none' }}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- превью без звука, как остальные превью проекта */}
                <video src={s.videoUrl} muted playsInline poster={s.thumbnailUrl ?? undefined} />
                <div className="mp-portfolio-item-footer">
                  <span>{s.title}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
    </>
  );
}
