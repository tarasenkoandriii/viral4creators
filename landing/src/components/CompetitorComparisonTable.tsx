/**
 * Сравнение с категорией — не с конкретным конкурентом.
 *
 * Правая колонка обобщает («типичный инструмент категории») намеренно,
 * а не из вежливости: §8 ТЗ лендинга
 * (`docs-tz/TZ-Client-Site-Tutorial-Landing.md`) запрещает называть
 * конкурентов по имени в прямом сравнении «мы против них», потому что
 * это требует отдельного юридического ревью, которого не было. Компонент
 * поэтому не принимает ни логотипов, ни названий — только строки
 * словаря.
 *
 * Таблица показывает и то, где мы ПРОИГРЫВАЕМ (аналитика вовлечённости,
 * встраиваемый виджет). Это не самокритика ради честности вообще:
 * аудитория этой страницы (§1 ТЗ) сравнивает инструменты таблицами
 * перед покупкой и проверяет заявления. Таблица, в которой у нас всюду
 * «да», для такого читателя — признак рекламы, а не аргумент.
 *
 * Разметка — настоящая `<table>` с `<th scope>`, не сетка из `<div>`:
 * это именно табличные данные, и скринридер должен объявлять «строка
 * такая-то, колонка такая-то». На узком экране та же таблица
 * перерисовывается карточками средствами CSS (`.compare-table` в
 * globals.css), без второй копии разметки.
 */

import type { RowVerdict, Verdict } from '../lib/compare-verdicts';

/**
 * Знак «есть»/«нет» перед значением (этап C ТЗ
 * `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * `aria-hidden` — не забывчивость: слово «Да»/«Нет» уже стоит в самой
 * ячейке текстом, и озвучивать его вторым знаком значило бы читать
 * строку дважды. Знак существует только для глаза.
 *
 * Цвета — акцент и приглушённый серый, НЕ зелёный с красным: красный
 * читается как «ошибка», и две строки, где мы честно проигрываем,
 * превратились бы из аргумента в извинение.
 *
 * Для `'none'` рисуется пустой слот той же ширины: без него ячейки со
 * знаком и без знака встали бы с разным отступом слева, и колонка
 * пошла бы лесенкой.
 */
function VerdictMark({ verdict }: { verdict: Verdict }) {
  if (verdict === 'none') {
    return <span className="verdict verdict-none" aria-hidden="true" />;
  }
  return (
    <span className={`verdict verdict-${verdict}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="15" height="15" focusable="false">
        <circle
          cx="8"
          cy="8"
          r="7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        {verdict === 'yes' ? (
          <path
            d="M4.9 8.3l2.1 2.2 4.2-4.7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          /* Черта, а не крестик: крестик — это «неверно», а здесь
             «такого нет». Диагональная штриховка, которую предлагало
             ТЗ, на пятнадцати пикселях превращается в грязь. */
          <path
            d="M5 8h6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        )}
      </svg>
    </span>
  );
}

interface ComparisonRow {
  feature: string;
  us: string;
  them: string;
}

export function CompetitorComparisonTable({
  caption,
  ourColumn,
  theirColumn,
  rows,
  verdicts,
}: {
  caption: string;
  ourColumn: string;
  theirColumn: string;
  rows: readonly ComparisonRow[];
  /** Параллелен `rows`; см. `lib/compare-verdicts.ts`. */
  verdicts?: readonly RowVerdict[];
}) {
  /* Расхождение длин означает, что в словарь добавили строку, а таблицу
     вердиктов — нет. Знаки тогда встали бы не у тех строк, то есть
     таблица начала бы врать; без знаков она просто беднее. Выбор
     очевиден. Тест `scripts/compare-verdicts.test.ts` не даст этому
     доехать до прода незамеченным. */
  const marks = verdicts?.length === rows.length ? verdicts : undefined;
  return (
    <table className="compare-table">
      {/* `<caption>` визуально скрыт (тот же `.sr-only`, что у подписи
          переключателя языка): заголовок раздела над таблицей человек
          и так видит, а скринридер объявляет таблицу отдельно от него и
          без подписи читает «таблица, 3 колонки» без единого слова о
          том, что в ней (находка Ф-6 аудита). */}
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <td />
          <th scope="col">{ourColumn}</th>
          <th scope="col">{theirColumn}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.feature}>
            <th scope="row">{row.feature}</th>
            {/* `data-label` дублирует заголовок колонки: в карточной
                раскладке на телефоне шапка таблицы не видна, и без
                подписи две ячейки подряд читаются как два ответа без
                вопроса. */}
            <td data-label={ourColumn} className="compare-us">
              {marks && <VerdictMark verdict={marks[index].us} />}
              {row.us}
            </td>
            <td data-label={theirColumn}>
              {marks && <VerdictMark verdict={marks[index].them} />}
              {row.them}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
