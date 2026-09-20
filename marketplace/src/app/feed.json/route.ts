import { NextResponse } from 'next/server';
import { getPortfolioFeed, PROFILE_REVALIDATE_SECONDS } from '../../lib/api';
import { defaultLocale } from '../../lib/i18n';

/** JSON-версия ленты (ТЗ §20 №11) — формат jsonfeed.org, проще RSS для машинного разбора. */

export const revalidate = PROFILE_REVALIDATE_SECONDS;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

export async function GET() {
  const items = await getPortfolioFeed(50);

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'viral4creators — новые работы',
    home_page_url: SITE_URL,
    feed_url: `${SITE_URL}/feed.json`,
    items: items.map((item) => ({
      id: item.id,
      url: `${SITE_URL}/${defaultLocale}/item/${item.id}`,
      title: item.title,
      date_published: item.createdAt,
      tags: item.niches,
      author: item.creatorDisplayName ? { name: item.creatorDisplayName } : undefined,
      image: item.thumbnailUrl ?? undefined,
    })),
  };

  return NextResponse.json(feed);
}
