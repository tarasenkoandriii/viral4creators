/**
 * Титульная карточка и закрывающая подпись поздравления — фичи №38 и
 * №39 компаньон-ТЗ.
 *
 * ## Почему `.ass`, а не `drawtext`
 *
 * Текст поверх кадра в ffmpeg рисуют двумя способами. `drawtext`
 * требует шрифт на стороне ffmpeg-сервиса — либо файлом по пути, либо
 * именем через fontconfig; ни того, ни другого мы про чужой хостед-
 * сервис не знаем, а кириллица без подходящего шрифта превращается в
 * квадраты. `subtitles=` (libass) в этом конвейере УЖЕ работает —
 * субтитры выпускаются в прод, — и значит кириллица там уже
 * отрисовывается. Строить второй, непроверенный путь ради тех же букв
 * незачем.
 *
 * Отсюда же формат: не `.srt`, как у субтитров, а `.ass` — только он
 * несёт стиль вместе с текстом, а карточке нужен свой размер, своя
 * подложка и своё положение в кадре, не те, что у субтитров.
 *
 * ## Почему карточка — плашка, а не полный экран
 *
 * Поздравление живёт пятнадцать секунд. Полноэкранная заставка
 * съедает из них две, то есть седьмую часть ролика, ради строки
 * текста. Плашка поверх кадра не отнимает ни секунды: картинка идёт
 * своим чередом.
 *
 * ## Спойлер
 *
 * Титульная карточка называет получателя в первую же секунду. Для
 * сюрприза это ровно то, чего делать нельзя (см. «сюрприз без
 * спойлера» на лендинге), поэтому она НЕ включена по умолчанию —
 * решение принимает отправитель, и он же видит предупреждение.
 */

import { GreetingCards } from './types/greeting.types';

export type { GreetingCards };

/** Сколько секунд висит каждая карточка. */
export const CARD_SECONDS = 2;
/** Насколько раньше конца начинается закрывающая подпись. */
const CLOSING_TAIL_SECONDS = CARD_SECONDS + 0.2;
export const MAX_CARD_TEXT_LENGTH = 70;

export interface CardRenderOptions {
  /** Длительность ролика — от неё считается конец. */
  totalDurationSeconds: number;
  /** Формат кадра, `W:H`. Нужен только чтобы выбрать `PlayRes`. */
  aspectRatio?: string | null;
  /**
   * Обязательное упоминание автора музыки (CC-BY и родственные).
   *
   * Рисуется отдельной мелкой строкой внизу в последние секунды и НЕ
   * трогает текст, который написал отправитель. Так и должно быть:
   * это не его подпись, а наше обязательство перед автором трека, и
   * отказаться от него он не может — как и мы.
   *
   * Почему в самом ролике, а не в описании: ролик уходит из продукта
   * файлом и пересылается дальше, а описание остаётся у нас.
   * Упоминание, которое не едет вместе с файлом, обязательства не
   * закрывает.
   */
  credit?: string | null;
}

/** Разрешение, в котором libass считает размеры. Кадр к нему масштабируется. */
function playRes(aspectRatio: string | null | undefined): {
  x: number;
  y: number;
} {
  const [w, h] = (aspectRatio ?? '9:16').split(':').map((n) => Number(n));
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { x: 1080, y: 1920 };
  }
  // Короткая сторона всегда 1080 — так кегль ниже означает одно и то
  // же в любом формате, а не «в 16:9 вдвое мельче».
  return w >= h
    ? { x: Math.round((1080 * w) / h), y: 1080 }
    : { x: 1080, y: Math.round((1080 * h) / w) };
}

/**
 * Экранирование для строки Dialogue.
 *
 * `{` и `}` в `.ass` открывают блок команд — незакрытый или чужой блок
 * либо съест текст, либо применит к нему что попало. Переводы строк
 * обязаны стать `\N`: одна реплика — одна строка файла, и живой
 * перенос разорвал бы формат.
 */
export function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n?|\n/g, '\\N');
}

/** `0:00:01.50` — время в том виде, в котором его читает libass. */
export function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function normalize(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (!text) return null;
  return text.slice(0, MAX_CARD_TEXT_LENGTH);
}

/** Есть ли что рисовать вообще. */
export function hasCards(
  cards: GreetingCards | null | undefined,
  credit?: string | null,
): boolean {
  return !!(
    normalize(cards?.title) ||
    normalize(cards?.closing) ||
    credit?.trim()
  );
}

/**
 * `.ass`-файл с карточками. Пустая строка — рисовать нечего,
 * вызывающий не должен создавать вход задачи.
 */
export function buildCardsAss(
  cards: GreetingCards | null | undefined,
  opts: CardRenderOptions,
): string {
  const title = normalize(cards?.title);
  const closing = normalize(cards?.closing);
  // Кредит не обрезаем по `MAX_CARD_TEXT_LENGTH`: имя автора и
  // название трека не наш текст, и укоротить их значит исказить
  // упоминание. Ограничение всё же есть, но щедрое.
  const credit = opts.credit?.trim().replace(/\s+/g, ' ').slice(0, 160) || null;
  if (!title && !closing && !credit) return '';

  const res = playRes(opts.aspectRatio);
  const total = Math.max(CARD_SECONDS, opts.totalDurationSeconds);

  const events: string[] = [];
  if (title) {
    // Титульная — в верхней трети: там её не перекроют субтитры, и
    // лицо ведущего в центре кадра остаётся видно.
    events.push(dialogue('title', 0, Math.min(CARD_SECONDS, total / 2), title));
  }
  if (closing) {
    // Закрывающая — в последние секунды, и всегда после титульной,
    // даже на совсем коротком ролике.
    const start = Math.max(
      title ? Math.min(CARD_SECONDS, total / 2) : 0,
      total - CLOSING_TAIL_SECONDS,
    );
    events.push(dialogue('closing', start, total, closing));
  }
  if (credit) {
    // Висит ровно столько же, сколько закрывающая подпись, и в самом
    // низу: заметно, но не спорит с поздравлением.
    events.push(
      dialogue(
        'credit',
        Math.max(0, total - CLOSING_TAIL_SECONDS),
        total,
        credit,
      ),
    );
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${res.x}`,
    `PlayResY: ${res.y}`,
    // Перенос по словам с выравниванием строк — заголовок в две
    // строки не должен выглядеть как обрывок.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // `BorderStyle=3` — та самая полупрозрачная плашка за текстом,
    // что и у темы субтитров `minimal`; `BackColour=&H99000000` —
    // чёрный с прозрачностью 0x99 (в ASS первый байт это АЛЬФА, и
    // больше значит прозрачнее). Alignment 8 — верх по центру, 2 —
    // низ по центру.
    `Style: title,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,3,0,0,8,80,80,${Math.round(
      res.y * 0.12,
    )},1`,
    `Style: closing,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H99000000,0,0,0,0,100,100,0,0,3,0,0,2,80,80,${Math.round(
      res.y * 0.1,
    )},1`,
    // Кредит мельче подписи и прижат к самому низу: он обязателен, но
    // это не часть поздравления.
    `Style: credit,Arial,28,&H00E0E0E0,&H000000FF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,${Math.round(
      res.y * 0.03,
    )},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

function dialogue(
  style: string,
  start: number,
  end: number,
  text: string,
): string {
  // Появление и уход плавные: резко возникшая плашка читается как
  // сбой кодирования, а не как приём.
  return `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,{\\fad(250,250)}${escapeAssText(text)}`;
}
