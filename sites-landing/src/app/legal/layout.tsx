import { HtmlDocument } from '../../components/HtmlDocument';

/** Юридические черновики — одна украинская редакция (см. lib/legal-docs.ts). */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <HtmlDocument lang="uk">{children}</HtmlDocument>;
}
