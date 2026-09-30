import { HtmlDocument } from '../../components/HtmlDocument';

/**
 * Юридические документы — одна (русская) редакция на все локали
 * интерфейса (см. middleware.ts, lib/i18n.ts), поэтому и `lang` у них
 * один. Корневой layout `<html>` не рисует (см. components/HtmlDocument.tsx).
 */
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <HtmlDocument locale="ru">{children}</HtmlDocument>;
}
