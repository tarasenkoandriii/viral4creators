/**
 * Постер и пропорции плеера справки (i) по ответу `GET /tutorial-help`
 * (TODO L6171). Отдельный модуль без зависимостей, а не дополнение
 * `services/tutorial-help-api.ts`: тот тянет HTTP-клиент с
 * `import.meta.env`, а это правило проверяется скриптом под `tsx`
 * (`scripts/tutorial-help-video.test.ts`).
 */

import type { TutorialHelpView } from '../services/tutorial-help-api';

/** Холст плеера справки: постер и пропорции до загрузки ролика. */
export interface TutorialHelpVideoFrame {
  /** Первый кадр, если он есть и это http(s)-адрес; иначе без постера. */
  poster: string | undefined;
  /** Вертикальный ролик (выше, чем шире) — ограничивается по высоте. */
  portrait: boolean;
  style: {
    aspectRatio?: string;
    width: string;
    height?: string;
    maxWidth: string;
    maxHeight: string;
    objectFit: 'contain';
  };
}

/** Доля высоты экрана под плеер: лист справки — не полноэкранный плеер,
 *  текст над роликом и кнопка закрытия должны оставаться видны. */
export const HELP_VIDEO_MAX_VH = 60;

function pixels(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function posterOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Постер и пропорции плеера справки по ответу API.
 *
 * - Размер — парой или никак (как на бэкенде): половина пары, ноль, дробь
 *   — без `aspect-ratio`, плеер ведёт себя как раньше.
 * - Горизонтальный ролик — во всю ширину листа, высота по пропорции.
 * - Вертикальный — по высоте (`HELP_VIDEO_MAX_VH`), ширина из пропорции,
 *   по центру: во всю ширину он вытянул бы лист за край экрана. Если
 *   ширины всё же не хватит, `max-width: 100%` сжимает рамку, а
 *   `object-fit: contain` вписывает кадр в неё — ролик не обрезается
 *   ни в каком случае (`cover` здесь запрещён: обучалка без краёв экрана
 *   прячет ровно ту кнопку, ради которой снята).
 */
export function tutorialHelpVideoFrame(
  view: Pick<TutorialHelpView, 'width' | 'height' | 'posterUrl'>
): TutorialHelpVideoFrame {
  const width = pixels(view.width);
  const height = pixels(view.height);
  const poster = posterOf(view.posterUrl);
  const maxHeight = `${HELP_VIDEO_MAX_VH}vh`;
  if (width === null || height === null) {
    return {
      poster,
      portrait: false,
      style: {
        width: '100%',
        maxWidth: '100%',
        maxHeight,
        objectFit: 'contain',
      },
    };
  }
  const portrait = height > width;
  return {
    poster,
    portrait,
    style: portrait
      ? {
          aspectRatio: `${width} / ${height}`,
          width: 'auto',
          height: maxHeight,
          maxWidth: '100%',
          maxHeight,
          objectFit: 'contain',
        }
      : {
          aspectRatio: `${width} / ${height}`,
          width: '100%',
          maxWidth: '100%',
          maxHeight,
          objectFit: 'contain',
        },
  };
}
