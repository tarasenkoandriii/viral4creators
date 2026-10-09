/**
 * Рендер страниц App Router в unit-скриптах (Next 15).
 *
 * С Next 15 `params` страницы — Promise, а сама страница — async-функция.
 * `react-dom/server` async-компоненты не рендерит (это умеет только
 * RSC-рендер Next), поэтому страница вызывается как функция, и
 * `renderToStaticMarkup` получает уже её результат — синхронное дерево.
 */
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export type AsyncPage<P> = (props: { params: Promise<P> }) => Promise<React.ReactElement>;

export async function renderPage<P>(page: AsyncPage<P>, params: P): Promise<string> {
  return renderToStaticMarkup(await page({ params: Promise.resolve(params) }));
}

/** Сообщение ошибки `notFound()` в Next 15 (в Next 14 было `NEXT_NOT_FOUND`). */
export const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;
