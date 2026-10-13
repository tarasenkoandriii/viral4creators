import type { MetadataRoute } from 'next';
import { getSiteConfig } from '@/lib/api';
import { isIndexable } from '@/lib/indexing';
import { publisherEnv } from '@/lib/server-env';
import { absoluteUrl } from '@/lib/site-url';

/**
 * robots.txt (§13.3): без `Disallow` в любом режиме — робот должен увидеть
 * noindex страниц; строка `Sitemap` — только у индексируемой сборки.
 */
export const revalidate = 300;

export default async function robots(): Promise<MetadataRoute.Robots> {
  const indexable = isIndexable(await getSiteConfig(), publisherEnv().indexingOn);
  return indexable
    ? { rules: [{ userAgent: '*', allow: '/' }], sitemap: absoluteUrl('/sitemap.xml') }
    : { rules: [{ userAgent: '*', allow: '/' }] };
}
