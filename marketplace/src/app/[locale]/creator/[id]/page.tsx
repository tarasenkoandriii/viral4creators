import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getCreatorPortfolio, getCreatorProfile, getSimilarCreators } from '../../../../lib/api';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { LikeButton } from '../../../../components/LikeButton';
import { ViewPing } from '../../../../components/ViewPing';
import { ShareButtons } from '../../../../components/ShareButtons';
import { QrCode } from '../../../../components/QrCode';
import { EmbedSnippet } from '../../../../components/EmbedSnippet';
import { jsonLdScript } from '../../../../lib/json-ld';

/**
 * Публичная страница профиля Creator/Agency (ТЗ §9) — визитка для
 * внешнего трафика, доступна без входа. Плюс §20: vanity-ссылка (id ИЛИ
 * slug принимаются одним маршрутом), счётчик просмотров, шеринг/QR/embed,
 * похожие исполнители, deep-link в Telegram-бота, structured data,
 * мультиязычность (№15).
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';
const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

export async function generateMetadata({
  params,
}: {
  params: { locale: Locale; id: string };
}): Promise<Metadata> {
  const profile = await getCreatorProfile(params.id);
  if (!profile) return {};
  const dict = getDictionary(params.locale);
  return {
    title: `${profile.displayName ?? dict.catalog.noName} — ${dict.profile.portfolioHeading}`,
    description: profile.bio ?? profile.niches.join(', '),
    alternates: { canonical: `${SITE_URL}/${params.locale}/creator/${profile.slug ?? profile.id}` },
    openGraph: { title: profile.displayName ?? dict.catalog.noName, description: profile.bio ?? undefined },
  };
}

export default async function CreatorProfilePage({
  params,
}: {
  params: { locale: Locale; id: string };
}) {
  const { locale, id } = params;
  const dict = getDictionary(locale);
  const profile = await getCreatorProfile(id);
  if (!profile) notFound();

  const [portfolio, similar] = await Promise.all([getCreatorPortfolio(id), getSimilarCreators(profile.id)]);

  const pageUrl = `${SITE_URL}/${locale}/creator/${profile.slug ?? profile.id}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.displayName ?? undefined,
    description: profile.bio ?? undefined,
    url: pageUrl,
    sameAs: profile.socialLinks.map((l) => l.url),
  };

  return (
    <>
      <ViewPing kind="creator" id={profile.id} />

      <div className="mp-profile-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 className="mp-profile-name" style={{ margin: 0 }}>
            {profile.displayName ?? dict.catalog.noName}
          </h1>
          {profile.isFeatured && <span className="mp-pill" style={{ color: 'var(--mp-accent)' }}>{dict.profile.featuredBadge}</span>}
        </div>
        <span className="mp-creator-card-niches">
          {profile.niches.map((n) => (
            <span key={n} className="mp-pill">
              {n}
            </span>
          ))}
        </span>
        {profile.bio && <p className="mp-profile-bio">{profile.bio}</p>}
        {(profile.priceRangeMin != null || profile.priceRangeMax != null) && (
          <p className="mp-creator-card-price">
            {dict.profile.priceRangeLabel}: {profile.priceRangeMin ?? '?'}–{profile.priceRangeMax ?? '?'}
          </p>
        )}
        <p className="mp-hint">
          {profile.viewCount} {dict.profile.viewsSuffix}
        </p>
        {profile.socialLinks.length > 0 && (
          <div className="mp-profile-links">
            {profile.socialLinks.map((l) => (
              <a key={l.id} className="mp-cta-secondary" href={l.url} target="_blank" rel="noreferrer">
                {l.platform}
              </a>
            ))}
            {profile.contactHandle && (
              <a className="mp-cta" href={`https://t.me/${profile.contactHandle.replace(/^@/, '')}`}>
                {dict.profile.contactButton}
              </a>
            )}
            {BOT_USERNAME && (
              <a className="mp-cta-secondary" href={`https://t.me/${BOT_USERNAME}?start=creator_${profile.id}`}>
                {dict.profile.botDeepLinkButton}
              </a>
            )}
          </div>
        )}
        {!profile.isAcceptingOrders && <p className="mp-hint">{dict.profile.notAcceptingOrders}</p>}

        <div style={{ marginTop: 8 }}>
          <ShareButtons url={pageUrl} title={profile.displayName ?? dict.profile.portfolioHeading} />
        </div>
      </div>

      <details style={{ margin: '16px 0' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{dict.profile.qrEmbedSummary}</summary>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12 }}>
          <QrCode data={pageUrl} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <EmbedSnippet creatorId={profile.id} />
          </div>
        </div>
      </details>

      <h2>{dict.profile.portfolioHeading}</h2>
      {portfolio.length === 0 ? (
        <p className="mp-empty">{dict.profile.emptyPortfolio}</p>
      ) : (
        <div className="mp-portfolio-grid">
          {portfolio.map((item) => (
            <div key={item.id} className="mp-portfolio-item">
              <Link href={`/${locale}/item/${item.id}`}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- пользовательский UGC-ролик, как у остальных плееров проекта */}
                <video src={item.videoUrl} controls playsInline poster={item.thumbnailUrl ?? undefined} />
              </Link>
              <div className="mp-portfolio-item-footer">
                <Link href={`/${locale}/item/${item.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  {item.title}
                </Link>
                <LikeButton itemId={item.id} initialCount={item.likeCount} initialLiked={item.likedByViewer} />
              </div>
            </div>
          ))}
        </div>
      )}

      {similar.length > 0 && (
        <>
          <h2>{dict.profile.similarHeading}</h2>
          <div className="mp-grid">
            {similar.map((c) => (
              <Link key={c.id} href={`/${locale}/creator/${c.id}`} className="mp-creator-card">
                <span className="mp-creator-card-name">{c.displayName ?? dict.catalog.noName}</span>
                <span className="mp-creator-card-niches">
                  {c.niches.map((n) => (
                    <span key={n} className="mp-pill">
                      {n}
                    </span>
                  ))}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      <p className="mp-hint">
        <Link href={`/${locale}/creator/${profile.slug ?? profile.id}/print`}>{dict.profile.printLink}</Link>
      </p>

      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
    </>
  );
}
