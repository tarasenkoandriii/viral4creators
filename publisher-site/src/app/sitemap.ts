import type { MetadataRoute } from 'next';
import { listPublished } from '@/lib/api';
import { absoluteUrl } from '@/lib/site-url';

/** sitemap.xml (§13.3): `/`, `/materials`, опубликованные материалы с `lastModified = updatedAt`. */
export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const items = await listPublished();
  const latest = items
    .map((i) => i.updatedAt ?? i.publishedAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();
  return [
    { url: absoluteUrl('/') },
    { url: absoluteUrl('/materials'), ...(latest ? { lastModified: latest } : {}) },
    ...items.map((i) => ({
      url: absoluteUrl(`/materials/${i.slug}`),
      ...((i.updatedAt ?? i.publishedAt) ? { lastModified: (i.updatedAt ?? i.publishedAt) as string } : {}),
    })),
  ];
}
