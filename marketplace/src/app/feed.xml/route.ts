import { NextResponse } from 'next/server';
import { getPortfolioFeed, PROFILE_REVALIDATE_SECONDS } from '../../lib/api';
import { defaultLocale } from '../../lib/i18n';

/**
 * Открытая RSS-лента новых опубликованных работ (ТЗ §20 №11) — для
 * агрегаторов и партнёрских сайтов. escapeXml — та же логика, что в
 * landing/src/lib/rss.ts (отдельная копия: marketplace/ и landing/ —
 * независимые приложения монорепо, без общего пакета для этого).
 */

export const revalidate = PROFILE_REVALIDATE_SECONDS;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const items = await getPortfolioFeed(50);

  const xmlItems = items
    .map((item) => {
      const itemUrl = `${SITE_URL}/${defaultLocale}/item/${item.id}`;
      return `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${itemUrl}</link>
      <guid isPermaLink="true">${itemUrl}</guid>
      <pubDate>${new Date(item.createdAt).toUTCString()}</pubDate>
      ${item.niches.map((n) => `<category>${escapeXml(n)}</category>`).join('')}
      <description>${escapeXml(item.creatorDisplayName ?? 'Исполнитель')}</description>
    </item>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>viral4creators — новые работы</title>
    <link>${SITE_URL}</link>
    <description>Свежие опубликованные UGC-работы на витрине исполнителей</description>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />${xmlItems}
  </channel>
</rss>`;

  return new NextResponse(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
