import { TMA_URL } from '../lib/content';
import type { Dictionary } from '../lib/get-dictionary';

/**
 * Плитка поводов (§4 п.3 docs-tz/TZ-Greeting-Video-Landing.md).
 *
 * Подписи берутся из `dict.sharedVideo.occasion` — той же карты, что
 * уже подписывает повод на публичной странице ролика. Заводить вторую
 * копию из двадцати четырёх строк в пяти словарях значило бы завести
 * место, где они разойдутся; ТЗ предлагало импортировать словарь
 * фронтенда, но это невозможно по причинам из находки 1.5 аудита.
 *
 * Клик ведёт в мастер с уже выбранным поводом (`?occasion=`) и меткой
 * источника (`?entry=greetings`) — параметр воронки из §4 п.1 ТЗ.
 * Порядок плиток задаёт словарь: сперва частые праздники, в конце
 * чувствительные поводы и «другой».
 */
export function GreetingOccasionGrid({
  occasions,
  sensitiveNote,
}: {
  occasions: Dictionary['sharedVideo']['occasion'];
  sensitiveNote: string;
}) {
  const codes = Object.keys(occasions) as Array<keyof typeof occasions>;
  return (
    <>
      <ul className="occasion-grid">
        {codes.map((code) => (
          <li key={code}>
            <a
              className="occasion-tile"
              href={`${TMA_URL}?entry=greetings&occasion=${code}#/projects/new`}
            >
              {occasions[code]}
            </a>
          </li>
        ))}
      </ul>
      <p className="occasion-note">{sensitiveNote}</p>
    </>
  );
}
