import type { Metadata } from 'next';
import Link from 'next/link';
import { dict } from '@/lib/dict';
import { NOINDEX } from '@/lib/indexing';

export const metadata: Metadata = { title: dict.meta.notFoundTitle, robots: NOINDEX };

export default function NotFound() {
  return (
    <article className="page">
      <h1>{dict.meta.notFoundTitle}</h1>
      <p>{dict.errors.notFound}</p>
      <p className="links">
        <Link href="/">{dict.errors.toHome}</Link> · <Link href="/materials">{dict.errors.toMaterials}</Link>
      </p>
    </article>
  );
}
