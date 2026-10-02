import type { ReactNode } from 'react';
import { assistEnv, eventsEndpoint } from '../lib/assist-env';
import type { LoaderTag } from '../lib/widget-loader';
import { LiveWidget } from './LiveWidget';
import { Telemetry } from './Telemetry';
import { VercelAnalytics } from './VercelAnalytics';
import { WebVitals } from './WebVitals';

/**
 * Единственное место, где рисуются `<html>`/`<body>` (приём `landing/`):
 * корневой layout языка не знает, `<html lang>` рисуют layout'ы, которые
 * знают его на сборке — `[locale]` (из сегмента), `legal` (uk), корневой
 * 404 (en). `lang` в серверном HTML, а не клиентской правкой.
 *
 * Vercel Web Analytics — только в сборке на Vercel (`VERCEL=1`): вне
 * Vercel скрипта `/_vercel/insights/script.js` нет, и он сыпал бы 404 в
 * консоль (локальный Lighthouse и CI). Без cookie, скрипт с того же origin;
 * адрес просмотра — без query и якоря (`VercelAnalytics`: адрес сайта из
 * `/try?url=` и utm третьей стороне не уходят).
 *
 * Л2: события §10 (`Telemetry`, first-party, без cookie) — на всех
 * страницах; живой виджет — только там, где его передал layout
 * (страницы локалей; юр-страницы и 404 — без виджета).
 */
export function HtmlDocument({ lang, children, widget = null }: { lang: string; children: ReactNode; widget?: LoaderTag | null }) {
  const events = eventsEndpoint(assistEnv());
  return (
    <html lang={lang} dir="ltr">
      <body>
        {children}
        <WebVitals />
        <Telemetry endpoint={events} />
        {widget && <LiveWidget src={widget.src} pk={widget.pk} lang={widget.lang} />}
        {process.env.VERCEL === '1' && <VercelAnalytics />}
      </body>
    </html>
  );
}
