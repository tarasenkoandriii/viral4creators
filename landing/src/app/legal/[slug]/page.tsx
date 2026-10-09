import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { LEGAL_DOCS } from '../../../lib/legal-content';
import { LegalArticle } from '../../../components/LegalArticle';

/** Обе страницы — статика: /legal/offer и /legal/terms-of-use. */
export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  return {
    title: doc ? `${doc.title} — viral4creators` : 'Документ не найден',
    robots: { index: true, follow: true },
  };
}

export default async function LegalPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  if (!doc) notFound();
  const other = LEGAL_DOCS.filter((d) => d.slug !== doc.slug);
  return (
    <main className="wrap legal-page">
      <p className="legal-back">
        <Link href="/">← На главную</Link>
      </p>
      <LegalArticle doc={doc} />
      <nav className="legal-links">
        {other.map((d) => (
          <Link key={d.slug} href={`/legal/${d.slug}`}>
            {d.title}
          </Link>
        ))}
      </nav>
    </main>
  );
}
