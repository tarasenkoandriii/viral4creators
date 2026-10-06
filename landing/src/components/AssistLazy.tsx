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
 * Только для главной. how-it-works остаётся на статических импортах:
 * встроенная панель (`variant="embedded"`) стоит в сетке страницы, а
 * колонку сворачивает `.how-it-works-assistant:empty` — отрисовка только
 * на клиенте дала бы сдвиг раскладки после гидратации; а ленивый
 * `PlatformAssist` там по замеру `next build` дороже статического
 * (+~0,3 КБ: рантайм next/dynamic весит больше самого загрузчика).
 */
export const FloatingAssistantWidget = dynamic(
  () => import('./AssistantWidget').then((m) => m.AssistantWidget),
  { ssr: false },
);

export const LazyPlatformAssist = dynamic(
  () => import('./PlatformAssist').then((m) => m.PlatformAssist),
  { ssr: false },
);
