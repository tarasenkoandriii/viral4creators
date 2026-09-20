/**
 * Копия landing/src/lib/json-ld.ts — та же уязвимость применима здесь:
 * JSON.stringify не экранирует `<`, значит и `</script>` в пользовательских
 * полях (title работы, bio исполнителя) может оборвать тег раньше времени.
 * См. оригинальный комментарий в landing для полного разбора.
 */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
