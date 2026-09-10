import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/** Сгенерированный favicon — тот же акцентный цвет, что и у остального
 * лендинга (--accent в globals.css), без внешнего файла/зависимости. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#6c8cff',
          borderRadius: 7,
          color: '#06060a',
          fontSize: 20,
          fontWeight: 700,
          fontFamily: 'sans-serif',
        }}
      >
        v2
      </div>
    ),
    { ...size },
  );
}
