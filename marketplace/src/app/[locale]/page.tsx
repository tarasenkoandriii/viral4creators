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
  params: { locale: Locale };
  searchParams: { niche?: string; priceMax?: string; cursor?: string };
}) {
  const { locale } = params;
  const dict = getDictionary(locale);
  const catalog = await getCreatorCatalog({
    niche: searchParams.niche,
    priceMax: searchParams.priceMax ? Number(searchParams.priceMax) : undefined,
    cursor: searchParams.cursor,
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
          defaultValue={searchParams.niche}
        />
        <input
          className="mp-filter-input"
          type="number"
          name="priceMax"
          placeholder={dict.catalog.budgetPlaceholder}
          defaultValue={searchParams.priceMax}
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
              ...(searchParams.niche ? { niche: searchParams.niche } : {}),
              ...(searchParams.priceMax ? { priceMax: searchParams.priceMax } : {}),
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
