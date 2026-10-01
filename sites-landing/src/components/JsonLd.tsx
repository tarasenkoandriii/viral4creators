import { jsonLdScript } from '../lib/json-ld';

/** Структурированные данные — только через `jsonLdScript()` (экранирование `<`, §0). */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />;
}
