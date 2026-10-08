'use client';

import dynamic from 'next/dynamic';

/**
 * Э-С Ш5, аудит лендинга: переключатель консультанта (`lib/assist-widget.ts`)
 * выбирает ОДИН из двух виджетов, но при статическом импорте в серверной
 * странице оба клиентских компонента попадали в First Load JS страницы:
 * в режиме `platform` — весь чат `AssistantWidget`, в `legacy` —
 * загрузчик `PlatformAssist`. Через `next/dynamic` каждый — отдельный
 * чанк, и браузер скачивает только тот, что страница действительно
 * отрисовала.
 *
 * Без SSR: плавающая кнопка и загрузчик платформы — фиксированное
 * позиционирование / скрытый узел, в раскладку страницы не входят, и
 * серверная отрисовка им ничего не даёт.
 *
 * Только для главной. На how-it-works `next/dynamic` нет:
 *  - встроенная панель (`variant="embedded"`) стоит в сетке страницы и
 *    подключается через `EmbeddedAssistant.tsx` — выбор ветки по
 *    константе сборки: в `legacy` синхронно, как раньше (без лишнего
 *    запроса чанка, конфиг запрашивается на круг раньше; в HTML сервера
 *    панели нет в обоих режимах — до конфига она `null`), в `platform` —
 *    `React.lazy`, чат не в First Load JS
 *    (107,3 → 103,2 КБ gzip; legacy 107,3 → 107,4 КБ). `ssr: false` здесь
 *    нельзя: в `<aside>` остался бы шаблон BAILOUT_TO_CLIENT_SIDE_RENDERING,
 *    `.how-it-works-assistant:empty` не сработал бы, а сам `next/dynamic`
 *    (+~0,8 КБ рантайма) лёг бы в чанк страницы и в `legacy`;
 *  - `PlatformAssist` — статический: ленивый по замеру `next build`
 *    дороже (+~0,3 КБ: рантайм next/dynamic весит больше самого
 *    загрузчика).
 */
export const FloatingAssistantWidget = dynamic(
  () => import('./AssistantWidget').then((m) => m.AssistantWidget),
  { ssr: false },
);

export const LazyPlatformAssist = dynamic(
  () => import('./PlatformAssist').then((m) => m.PlatformAssist),
  { ssr: false },
);
