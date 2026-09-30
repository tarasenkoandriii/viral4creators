/**
 * Порядок секций страницы поздравлений (§5.2 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`) и выключатель
 * секции «Вы в кадре».
 *
 * ## Зачем порядок вынесен из разметки
 *
 * Ради одной секции — «Вы в кадре» (§5.2 п.5). Режим «Я в кадре» в коде
 * есть (этапы E–G), но в проде закрыт флагом `PERSONA_ENABLED` и до
 * юридического шлюза людям не открывается. Главное правило страницы —
 * ни одного обещания, которого нет в проде, — значит, секции не должно
 * быть в разметке вовсе, а не «спрятана стилем».
 *
 * Включается она ОДНОЙ константой, тем же приёмом, что
 * `GREETING_REAL_FRAME_LOCALES` у кадров: не человек по чек-листу, а
 * одно место. Страница строит секции по `greetingSectionOrder()`, и
 * пока константа `false`, идентификатора `persona` в списке нет —
 * проверяет `scripts/greeting-sections.test.ts`.
 *
 * Включать — в том же релизе, что и `PERSONA_ENABLED` на проде (правило
 * очерёдности §5.4: текст о возможности не раньше самой возможности), и
 * только вместе с разметкой секции и её текстами в пяти словарях: тест
 * не даст включить константу, пока у страницы нет отрисовки секции и
 * раздела `persona` в словаре.
 */

/** Секция «Вы в кадре». Выключена: `PERSONA_ENABLED` в проде выключен. */
export const PERSONA_SECTION_ENABLED: boolean = false;

/**
 * Все секции в порядке §5.2. Hero первым, финальный призыв последним;
 * футер — не секция `<main>`, он вне списка.
 */
export const GREETING_SECTIONS = [
  'hero',
  'samples',
  'how',
  'occasions',
  'persona',
  'features',
  'audience',
  'privacy',
  'price',
  'faq',
  'finalCta',
] as const;

export type GreetingSectionId = (typeof GREETING_SECTIONS)[number];

/** Секции, которые страница рисует сейчас. Параметр — для теста. */
export function greetingSectionOrder(
  personaEnabled: boolean = PERSONA_SECTION_ENABLED,
): GreetingSectionId[] {
  return GREETING_SECTIONS.filter((id) => id !== 'persona' || personaEnabled);
}
