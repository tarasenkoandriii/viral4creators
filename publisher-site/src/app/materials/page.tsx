import type { Metadata } from 'next';
import Link from 'next/link';
import { listPublished } from '@/lib/api';
import { dict, formatDate } from '@/lib/dict';
import { pageMetadata } from '@/lib/page-meta';

/** Список опубликованных материалов (§13.2), SSG + ISR 300 с. */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata('/materials', dict.meta.materialsTitle, dict.meta.materialsDescription);
}

export default async function Materials() {
  const items = await listPublished();
  const t = dict.materials;
  return (
    <article className="page">
      <h1>{dict.meta.materialsTitle}</h1>
      <p className="lead">{t.intro}</p>
      {items.length ? (
        <ul className="material-list">
          {items.map((m) => {
            const pub = formatDate(m.publishedAt);
            const upd = m.updatedAt && m.updatedAt !== m.publishedAt ? formatDate(m.updatedAt) : null;
            return (
              <li key={m.slug} className="card">
                <h2>
                  <Link href={`/materials/${m.slug}`}>{m.title ?? m.slug}</Link>
                </h2>
                {m.description ? <p>{m.description}</p> : null}
                <p className="meta">
                  {pub ? (
                    <>
                      {t.published}: <time dateTime={m.publishedAt ?? undefined}>{pub}</time>
                    </>
                  ) : null}
                  {upd ? (
                    <>
                      {pub ? ' · ' : ''}
                      {t.updated}: <time dateTime={m.updatedAt ?? undefined}>{upd}</time>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pending">{t.empty}</p>
      )}
    </article>
  );
}
