import type { Metadata } from 'next';
import { PUBLISHER_BRAND } from '@/brand';
import { getSiteConfig } from './api';
import { dict } from './dict';
import { isIndexable, robotsMeta } from './indexing';
import { publisherEnv } from './server-env';
import { absoluteUrl } from './site-url';

/**
 * Метаданные страницы (§13.3, AT-CORE-01): title/description, canonical =
 * `SITE_URL + путь` (абсолютный), robots по двум ключам индексации.
 */
export async function pageMetadata(
  path: string,
  title: string | null,
  description: string,
  extra: Metadata = {},
): Promise<Metadata> {
  const cfg = await getSiteConfig();
  const indexable = isIndexable(cfg, publisherEnv().indexingOn);
  const url = absoluteUrl(path);
  const image = {
    url: absoluteUrl('/og/publisher-uk.png'),
    width: 1200,
    height: 630,
    alt: dict.meta.socialImageAlt,
  };
  const fullTitle = title
    ? `${title} — ${PUBLISHER_BRAND.name}`
    : `${PUBLISHER_BRAND.name} — ${PUBLISHER_BRAND.positioning}`;
  return {
    title: title ?? { absolute: fullTitle },
    description,
    alternates: { canonical: url },
    robots: robotsMeta(indexable),
    openGraph: {
      type: 'website',
      url,
      title: fullTitle,
      description,
      siteName: PUBLISHER_BRAND.name,
      locale: 'uk_UA',
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description, images: [image] },
    ...extra,
  };
}

/** Простой текст из markdown-строки для description (≤ 160 символов). */
export function plainExcerpt(md: string | null | undefined, max = 160): string | null {
  if (!md) return null;
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}
