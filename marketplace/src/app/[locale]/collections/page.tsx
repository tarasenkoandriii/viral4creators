import Link from 'next/link';
import { getCollections } from '../../../lib/api';
import { getDictionary } from '../../../lib/get-dictionary';
import type { Locale } from '../../../lib/i18n';

export default async function CollectionsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const dict = getDictionary(locale);
  const collections = await getCollections();

  return (
    <>
      <h1>{dict.collections.heading}</h1>
      {collections.length === 0 ? (
        <p className="mp-empty">{dict.collections.empty}</p>
      ) : (
        <div className="mp-grid">
          {collections.map((c) => (
            <Link key={c.tag} href={`/${locale}/collections/${encodeURIComponent(c.tag)}`} className="mp-creator-card">
              <span className="mp-creator-card-name">#{c.tag}</span>
              <span className="mp-creator-card-price">
                {c.itemCount} {dict.collections.itemsSuffix}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
