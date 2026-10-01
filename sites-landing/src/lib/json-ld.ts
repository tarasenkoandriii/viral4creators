/**
 * JSON-LD — только через эту функцию (порт `landing/src/lib/json-ld.ts`,
 * ТЗ §0): `JSON.stringify` не экранирует `<`, и `</script>` в значении
 * обрывал бы тег `<script type="application/ld+json">` — XSS. `<`
 * превращается в `<`: для JSON-парсера это тот же символ, для
 * HTML-парсера последовательности `</script>` в исходнике нет.
 */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
