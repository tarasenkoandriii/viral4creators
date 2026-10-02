'use client';

import { useEffect } from 'react';
import { track } from '../lib/track';
import { assistCall, injectLoader, scheduleWidget, type LoaderTag } from '../lib/widget-loader';

/**
 * Живой виджет нашего помощника (Л2, §4.1): настоящий продукт, наш сайт —
 * обычный клиент. Ничего не рисует сам: только отложенно вставляет тег
 * загрузчика (см. `lib/widget-loader.ts`) и подписывается на события
 * виджета для воронки §10 (наружу виджет отдаёт только тип события).
 */
export function LiveWidget(tag: LoaderTag) {
  const { src, pk, lang } = tag;
  useEffect(
    () =>
      scheduleWidget(() => {
        assistCall('on', 'open', () => track('widget_open', { place: 'widget' }));
        injectLoader({ src, pk, lang });
      }),
    [src, pk, lang],
  );
  return null;
}
