import type { ReactNode } from 'react';
import { LOCALE_DIR, type Locale } from '../lib/i18n';

/**
 * Единственное место, где лендинг рисует `<html>`/`<body>`.
 *
 * Корневой `app/layout.tsx` локали не знает: у него нет `params.locale`,
 * а читать её из заголовка, выставленного middleware, значит позвать
 * `headers()` — и тогда каждая страница под корнем (все пять локалей,
 * блог, `/greetings`, `/site-tutorial`) из статики на сборке становится
 * динамической. Поэтому корень теперь только пропускает детей, а
 * `<html>` рисует тот layout, который язык знает на сборке:
 *
 *  - `app/[locale]/layout.tsx` — `lang` из сегмента URL (и на поддоменах
 *    тоже: middleware переписывает `/<locale>` в `/<locale>/<slug>`, то
 *    есть сегмент там тот же);
 *  - `app/legal`, `app/qa` — `ru`, у них одна редакция на всех;
 *  - `app/video/[id]` — локаль снимка страницы, `app/r/[code]` — cookie
 *    переключателя (обе страницы и так рендерятся по запросу/ISR);
 *  - `app/not-found.tsx` — `ru`, последний резерв вне `[locale]`.
 *
 * Раньше язык правил клиентский `SetHtmlLang` уже после гидратации, и в
 * серверном HTML на всех пяти локалях стояло `lang="ru"` — ровно то, что
 * видят поисковик, переводчик браузера и скринридер до скриптов.
 */
export function HtmlDocument({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <html lang={locale} dir={LOCALE_DIR[locale]}>
      <body>{children}</body>
    </html>
  );
}
