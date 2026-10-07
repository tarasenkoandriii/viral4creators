import type { Dictionary } from '../../../lib/get-dictionary';

type CompareTexts = Dictionary['greetingsLanding']['compare'];

/** Колонки альтернатив — в порядке шапки; `us` всегда первая. */
const ALTERNATIVES = ['template', 'person', 'generic'] as const;

/**
 * Секция «Сравнение» страницы поздравлений (§5.5 и В-8 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`; обзор рынка —
 * `docs-tz/OBZOR-Konkurentov-Greetings.md`).
 *
 * Сравнение с КАТЕГОРИЯМИ — «видео-открытка по шаблону», «заказ у
 * человека или знаменитости», «универсальный ИИ-генератор», — а не с
 * компаниями: названия и чужие цены в прямом сравнении требуют
 * юридического ревью и устаревают быстрее страницы. Компонент поэтому
 * не принимает ничего, кроме строк словаря. Утверждения о нас сверены с
 * кодом бэкенда (15 секунд, до 4 сцен, пять языков, голос с Standard) —
 * числа держит `scripts/greeting-compare.test.ts`.
 *
 * Последняя строка — наш проигрыш (отложенной доставки нет). Довод тот
 * же, что у `CompetitorComparisonTable`: таблица, где у нас всюду «да»,
 * читается как реклама, а не как аргумент.
 *
 * Своя таблица, а не `CompetitorComparisonTable`: там ровно две колонки
 * значений («мы» и «категория»), здесь — четыре. Классы — те же
 * `.compare-table` / `.compare-us` / `.compare-note`, включая карточную
 * раскладку на узком экране через `data-label`; правки под четыре
 * колонки — в `globals.css` под `.greeting-page .compare-table`.
 *
 * Серверный компонент, без `'use client'`: тексты `compare` вырезаны из
 * клиентского словаря (`clientDictionary`), и страница рисует секцию
 * только через `greetingSectionOrder()` — при выключенной
 * `COMPARE_SECTION_ENABLED` её нет в HTML вовсе.
 */
export function CompareSection({ texts }: { texts: CompareTexts }) {
  const { columns } = texts;
  return (
    <section className="compare" id="compare">
      <div className="wrap">
        <h2>{texts.title}</h2>
        <p className="section-lead">{texts.lead}</p>
        <table className="compare-table compare-table-wide">
          <caption className="sr-only">{texts.caption}</caption>
          <thead>
            <tr>
              <td />
              <th scope="col">{columns.us}</th>
              {ALTERNATIVES.map((key) => (
                <th scope="col" key={key}>
                  {columns[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {texts.rows.map((row) => (
              <tr key={row.feature}>
                <th scope="row">{row.feature}</th>
                <td data-label={columns.us} className="compare-us">
                  {row.us}
                </td>
                {ALTERNATIVES.map((key) => (
                  <td data-label={columns[key]} key={key}>
                    {row[key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="compare-note">{texts.note}</p>
      </div>
    </section>
  );
}
