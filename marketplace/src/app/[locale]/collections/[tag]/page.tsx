import Link from 'next/link';
import type { Metadata } from 'next';
import { getCollectionItems } from '../../../../lib/api';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; tag: string }>;
}): Promise<Metadata> {
  const { tag } = await params;
  return { title: `#${decodeURIComponent(tag)} — viral4creators` };
}

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ locale: Locale; tag: string }>;
}) {
  const { locale, tag: rawTag } = await params;
  const dict = getDictionary(locale);
  const tag = decodeURIComponent(rawTag);
  const items = await getCollectionItems(tag);

  return (
    <>
      <p className="mp-hint">
        <Link href={`/${locale}/collections`}>{dict.collections.backLink}</Link>
      </p>
      <h1>#{tag}</h1>
      {items.length === 0 ? (
        <p className="mp-empty">{dict.collections.emptyCollection}</p>
      ) : (
        <div className="mp-portfolio-grid">
          {items.map((item) => (
            <Link key={item.id} href={`/${locale}/item/${item.id}`} className="mp-portfolio-item" style={{ textDecoration: 'none' }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- превью без звука, как остальные превью проекта */}
              <video src={item.videoUrl} muted playsInline poster={item.thumbnailUrl ?? undefined} />
              <div className="mp-portfolio-item-footer">
                <span>{item.title}</span>
                <span>{item.likeCount}❤️</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
