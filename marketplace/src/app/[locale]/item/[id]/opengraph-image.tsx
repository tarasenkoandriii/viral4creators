import { ImageResponse } from 'next/og';
import { getPortfolioItem } from '../../../../lib/api';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';

/**
 * Автогенерация OG-превью для карточки портфолио (ТЗ §20 №3) — встроенный
 * `next/og` (Next.js 13.3+), никакой новой зависимости. Next сам находит
 * этот файл по соглашению об именах (`opengraph-image`) и подставляет
 * его в <meta property="og:image"> страницы рядом — то есть автоматически
 * с правильным префиксом локали, так как файл лежит в том же сегменте
 * [locale]/item/[id], что и сама страница (§20 №15).
 */

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImage({ params }: { params: { locale: Locale; id: string } }) {
  const item = await getPortfolioItem(params.id);
  const dict = getDictionary(params.locale);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          background: 'linear-gradient(135deg, #0b0b0d 0%, #1a0f04 100%)',
          padding: 60,
          color: '#ececec',
          fontSize: 48,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 28, color: '#ff9f5a', marginBottom: 16 }}>{dict.og.itemTag}</div>
        <div style={{ display: 'flex' }}>{item?.title ?? dict.og.itemFallback}</div>
      </div>
    ),
    { ...size },
  );
}
