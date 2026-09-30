import { HtmlDocument } from '../../components/HtmlDocument';

/**
 * Служебный полигон вне `[locale]` (см. middleware.ts) — переводить его
 * незачем, язык тот же, что был у него всегда. Корневой layout `<html>` не
 * рисует (см. components/HtmlDocument.tsx).
 */
export default function QaLayout({ children }: { children: React.ReactNode }) {
  return <HtmlDocument locale="ru">{children}</HtmlDocument>;
}
