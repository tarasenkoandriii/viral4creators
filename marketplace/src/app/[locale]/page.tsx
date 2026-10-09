import Link from 'next/link';
import { getCreatorCatalog } from '../../lib/api';
import { getDictionary } from '../../lib/get-dictionary';
import type { Locale } from '../../lib/i18n';

/**
 * Витрина/каталог исполнителей (ТЗ §9, §19–§20) — публично, без входа.
 * searchParams вместо клиентского состояния: страница остаётся Server
 * Component, фильтры работают через обычную навигацию по ссылке.
 */
export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ niche?: string; priceMax?: string; cursor?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  const dict = getDictionary(locale);
  const catalog = await getCreatorCatalog({
    niche: query.niche,
    priceMax: query.priceMax ? Number(query.priceMax) : undefined,
    cursor: query.cursor,
  });

  return (
    <>
      <h1>{dict.catalog.title}</h1>
      <p className="mp-hint">
        {dict.catalog.hintPrefix} <Link href={`/${locale}/brief`}>{dict.catalog.hintLink}</Link>.
      </p>

      <form className="mp-catalog-filters" method="get">
        <input
          className="mp-filter-input"
          type="text"
          name="niche"
          placeholder={dict.catalog.nichePlaceholder}
          defaultValue={query.niche}
        />
        <input
          className="mp-filter-input"
          type="number"
          name="priceMax"
          placeholder={dict.catalog.budgetPlaceholder}
          defaultValue={query.priceMax}
        />
        <button className="mp-cta-secondary" type="submit">
          {dict.catalog.searchButton}
        </button>
      </form>

      {catalog.items.length === 0 ? (
        <p className="mp-empty">{dict.catalog.emptyState}</p>
      ) : (
        <div className="mp-grid">
          {catalog.items.map((creator) => (
            <Link key={creator.id} href={`/${locale}/creator/${creator.slug ?? creator.id}`} className="mp-creator-card">
              {creator.portfolioPreview.length > 0 && (
                <div className="mp-creator-card-preview">
                  {creator.portfolioPreview.map((p) => (
                    // eslint-disable-next-line jsx-a11y/media-has-caption -- превью без звука/субтитров, как остальные плееры проекта
                    <video key={p.id} src={p.videoUrl} muted playsInline poster={p.thumbnailUrl ?? undefined} />
                  ))}
                </div>
              )}
              <span className="mp-creator-card-name">
                {creator.isFeatured && '★ '}
                {creator.displayName ?? dict.catalog.noName}
              </span>
              <span className="mp-creator-card-niches">
                {creator.niches.map((n) => (
                  <span key={n} className="mp-pill">
                    {n}
                  </span>
                ))}
              </span>
              {(creator.priceRangeMin != null || creator.priceRangeMax != null) && (
                <span className="mp-creator-card-price">
                  {dict.catalog.priceFrom} {creator.priceRangeMin ?? '?'} {dict.catalog.priceTo} {creator.priceRangeMax ?? '?'}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      {catalog.nextCursor && (
        <p style={{ textAlign: 'center', margin: '24px 0' }}>
          <Link
            className="mp-cta-secondary"
            href={`/${locale}?${new URLSearchParams({
              ...(query.niche ? { niche: query.niche } : {}),
              ...(query.priceMax ? { priceMax: query.priceMax } : {}),
              cursor: catalog.nextCursor,
            }).toString()}`}
          >
            {dict.catalog.showMore}
          </Link>
        </p>
      )}
    </>
  );
}
