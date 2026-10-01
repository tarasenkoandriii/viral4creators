import type { ReactNode } from 'react';
import { Analytics } from '@vercel/analytics/next';
import { WebVitals } from './WebVitals';

/**
 * Единственное место, где рисуются `<html>`/`<body>` (приём `landing/`):
 * корневой layout языка не знает, `<html lang>` рисуют layout'ы, которые
 * знают его на сборке — `[locale]` (из сегмента), `legal` (uk), корневой
 * 404 (en). `lang` в серверном HTML, а не клиентской правкой.
 *
 * Vercel Web Analytics (§10, до продукта — единственная аналитика) —
 * только в сборке на Vercel (`VERCEL=1`): вне Vercel скрипта
 * `/_vercel/insights/script.js` нет, и он сыпал бы 404 в консоль
 * (локальный Lighthouse и CI). Без cookie, скрипт с того же origin.
 */
export function HtmlDocument({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <html lang={lang} dir="ltr">
      <body>
        {children}
        <WebVitals />
        {process.env.VERCEL === '1' && <Analytics />}
      </body>
    </html>
  );
}
