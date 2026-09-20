import { ImageResponse } from 'next/og';
import { getCreatorProfile } from '../../../../lib/api';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImage({ params }: { params: { locale: Locale; id: string } }) {
  const profile = await getCreatorProfile(params.id);
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
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 28, color: '#ff9f5a', marginBottom: 16 }}>{dict.og.profileTag}</div>
        <div style={{ display: 'flex', fontSize: 56 }}>{profile?.displayName ?? dict.og.profileFallback}</div>
        <div style={{ display: 'flex', fontSize: 30, color: '#9a9a9a', marginTop: 12 }}>
          {(profile?.niches ?? []).join(' · ')}
        </div>
      </div>
    ),
    { ...size },
  );
}
