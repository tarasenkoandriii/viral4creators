import { TMA_URL } from '../../../lib/content';
import type { Dictionary } from '../../../lib/get-dictionary';
import {
  OPEN_OCCASION,
  greetingOccasionGroups,
} from '../../../lib/greeting-occasions';

type Landing = Dictionary['greetingsLanding'];

/**
 * Поводы, сгруппированные по регистру (§5.2 п.4 ТЗ Greeting 2.0).
 *
 * Замена плоской `components/GreetingOccasionGrid`: та выкладывала 24
 * плитки подряд и одной сноской объясняла, что три из них «ведутся
 * иначе». Теперь это объясняет сама группа — подпись под заголовком
 * обещает ровно то, что делает политика регистра на сервере
 * (`lib/greeting-occasions.ts`, там же — почему копия и чем закреплена).
 *
 * Подписи плиток — из `sharedVideo.occasion`, как и раньше: вторая копия
 * двадцати четырёх строк в пяти словарях разошлась бы с первой. Ссылка
 * плитки та же, что была: мастер с выбранным поводом и меткой источника.
 * Серверный компонент, без `'use client'`.
 */
export function OccasionGroups({
  occasions,
  labels,
}: {
  occasions: Landing['occasions'];
  labels: Dictionary['sharedVideo']['occasion'];
}) {
  const hrefOf = (code: string) =>
    `${TMA_URL}?entry=greetings&occasion=${code}#/projects/new`;
  return (
    <div className="occasion-groups">
      {greetingOccasionGroups().map((group) => {
        const copy = occasions.groups[group.id];
        return (
          /* `div role="group"`, а не элемент section: у общего
             `section:not(.hero)` в globals.css отступ 64px и линейка сверху —
             группа внутри секции получила бы их тоже (провалы по ~380px и
             съехавшая линейка «Деликатных»), а каждая группа стала бы
             отдельным ориентиром `region` для скринридера. */
          <div
            className={`occasion-group occasion-group-${group.id}`}
            key={group.id}
            role="group"
            aria-labelledby={`occasion-group-${group.id}`}
          >
            <h3 id={`occasion-group-${group.id}`}>{copy.title}</h3>
            <p className="occasion-group-text">{copy.text}</p>
            <ul className="occasion-grid">
              {group.codes.map((code) => (
                <li key={code}>
                  <a className="occasion-tile" href={hrefOf(code)}>
                    {labels[code]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {/* «Особый повод» — вне групп: его регистр выбирает человек, а
          описание может поднять его строже (см. lib/greeting-occasions.ts). */}
      <div
        className="occasion-group occasion-group-other"
        role="group"
        aria-labelledby="occasion-group-other"
      >
        <h3 id="occasion-group-other">{occasions.other.title}</h3>
        <p className="occasion-group-text">{occasions.other.text}</p>
        <ul className="occasion-grid">
          <li>
            <a className="occasion-tile" href={hrefOf(OPEN_OCCASION)}>
              {labels[OPEN_OCCASION]}
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
