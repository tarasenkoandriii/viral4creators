import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCreatorPortfolio, getCreatorProfile } from '../../../lib/api';
import { defaultLocale } from '../../../lib/i18n';
import '../../globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

/**
 * Встраиваемый виджет портфолио (ТЗ §20 №5) — вне [locale] намеренно
 * (см. lib/i18n.ts §20 №15): усложнять сниппет для вставки на чужой сайт
 * ради локали не стоит, сам виджет — минимальная карточка почти без
 * текста. Исходящие ссылки на полноценные страницы ведут на defaultLocale
 * явно, а не через редирект middleware (на один хоп быстрее).
 */
export default async function EmbedPage({ params }: { params: { id: string } }) {
  const profile = await getCreatorProfile(params.id);
  if (!profile) notFound();
  const portfolio = await getCreatorPortfolio(params.id);

  return (
    <div className="wrap" style={{ padding: '16px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <strong>{profile.displayName ?? 'Portfolio'}</strong>
        <a
          href={`${SITE_URL}/${defaultLocale}/creator/${profile.slug ?? profile.id}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: 'var(--muted)' }}
        >
          viral4creators →
        </a>
      </div>
      {portfolio.length === 0 ? (
        <p className="mp-empty">—</p>
      ) : (
        <div className="mp-portfolio-grid">
          {portfolio.slice(0, 6).map((item) => (
            <Link
              key={item.id}
              href={`/${defaultLocale}/item/${item.id}`}
              target="_blank"
              className="mp-portfolio-item"
              style={{ textDecoration: 'none' }}
            >
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- превью без звука, как остальные превью проекта */}
              <video src={item.videoUrl} muted playsInline poster={item.thumbnailUrl ?? undefined} />
              <div className="mp-portfolio-item-footer">
                <span>{item.title}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
