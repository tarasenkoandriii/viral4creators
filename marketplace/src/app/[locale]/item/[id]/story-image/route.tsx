import { ImageResponse } from 'next/og';
import { getCreatorProfile, getPortfolioItem } from '../../../../../lib/api';
import { getDictionary } from '../../../../../lib/get-dictionary';
import type { Locale } from '../../../../../lib/i18n';

/**
 * Готовый шаблон для Stories Instagram/TikTok (ТЗ §20 №12) — 1080×1920,
 * с названием работы, именем исполнителя и ссылкой; человек скачивает
 * PNG и публикует в Stories вручную (те же ограничения, что у
 * CrossPostPanel — публичного веб-интента для Stories не существует).
 */

export const runtime = 'edge';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

export async function GET(_req: Request, { params }: { params: { locale: Locale; id: string } }) {
  const item = await getPortfolioItem(params.id);
  const creator = item ? await getCreatorProfile(item.creatorProfileId) : null;
  const dict = getDictionary(params.locale);
  const link = `${SITE_URL}/${params.locale}/item/${params.id}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: 'linear-gradient(180deg, #0b0b0d 0%, #1a0f04 100%)',
          padding: 80,
          color: '#ececec',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 40, color: '#ff9f5a' }}>viral4creators</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', fontSize: 64, lineHeight: 1.2 }}>{item?.title ?? dict.og.itemFallback}</div>
          <div style={{ display: 'flex', fontSize: 36, color: '#9a9a9a' }}>{creator?.displayName ?? ''}</div>
        </div>
        <div style={{ display: 'flex', fontSize: 28, color: '#9a9a9a' }}>{link}</div>
      </div>
    ),
    { width: 1080, height: 1920 },
  );
}
