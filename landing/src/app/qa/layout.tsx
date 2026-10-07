import type { Metadata } from 'next';
import { HtmlDocument } from '../../components/HtmlDocument';
import { appBuildMetaOther } from '../../lib/app-build';

/**
 * Служебный полигон вне `[locale]` (см. middleware.ts) — переводить его
 * незачем, язык тот же, что был у него всегда. Корневой layout `<html>` не
 * рисует (см. components/HtmlDocument.tsx).
 *
 * `<meta name="app-build">` — только здесь, а не в корне: съёмка обучалки
 * ходит лишь на `/qa/*` (маршруты раннера — только `/qa/`), а HTML
 * маркетинговых страниц ради неё менять незачем (`lib/app-build.ts`).
 * Страницы `/qa/*` своё `other` не задают — значение доходит до них
 * слиянием метаданных Next.
 */
export const metadata: Metadata = {
  other: appBuildMetaOther(),
};

export default function QaLayout({ children }: { children: React.ReactNode }) {
  return <HtmlDocument locale="ru">{children}</HtmlDocument>;
}
