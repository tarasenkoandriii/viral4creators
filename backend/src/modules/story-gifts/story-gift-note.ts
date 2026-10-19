import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export const STORY_SEGMENT_SEPARATOR = '\n\n';
export type StoryGiftNotePosition = 'beginning' | 'end';

/**
 * B-S3-7(2). Убирает одиночные (непарные) суррогаты UTF-16: такой текст
 * ломает `encodeURIComponent`, JSON у провайдеров TTS/STT и хеши (разный
 * результат у разных кодировщиков). Node 22 — `String.prototype.toWellFormed`
 * (заменяет на U+FFFD), иначе та же замена по `\p{Cs}`; затем U+FFFD
 * удаляется — произносить нечего. Парные суррогаты (эмодзи и т.п.) не
 * трогаются. Для любого текста, который уходит в синтез, субтитры или хеш.
 */
export function toWellFormedStoryText(value: string): string {
  const native = (value as { toWellFormed?: () => string }).toWellFormed;
  const wellFormed =
    typeof native === 'function'
      ? native.call(value)
      : value.replace(/\p{Cs}/gu, '\uFFFD');
  return wellFormed.replace(/\uFFFD/g, '');
}

/**
 * Нормализация произносимой вставки (реплика о подарке; WP4 — преамбула):
 * без одиночных суррогатов (`toWellFormedStoryText`), NFC,
 * управляющие/невидимые/двунаправленные символы → пробел, любые
 * пробелы и переводы строк → один пробел, обрезка краёв. После неё в
 * тексте нет `\n\n`, поэтому разделитель сегментов однозначен.
 */
export function normalizeStorySpeechText(value: string, max: number): string {
  const text = toWellFormedStoryText(value)
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max)
    throw new BadRequestException(`Текст — до ${max} символов`);
  return text;
}

/**
 * Формат для WP4 (видео-сегменты). Хранится в `StoryGift.narrationLayout`
 * (JSONB) у подарков, созданных после WP3; `text` по-прежнему содержит
 * склейку «реплика + \n\n + сказка» (или наоборот) — это вход аудиоверсии
 * Nova, её резерв, хеш `textHash` и сверка Soniox не менялись.
 *
 * - `unit: 'utf16'` — смещения в единицах JS-строки (`text.slice(start, end)`),
 *   НЕ в кодовых точках Postgres `char_length`;
 * - `main` — точный текст выбранной редакции (заголовок + главы), без
 *   реплики; `sha256` — хеш именно этого фрагмента (ключ кэша основной
 *   речи видео: смена реплики не должна пересинтезировать сказку);
 * - `giftNote` — отдельный сегмент со своей позицией; null — реплики нет;
 * - видео: сегмент реплики ставится до (`beginning`) или после (`end`)
 *   основного сегмента, основная речь синтезируется из `main`.
 * Старые строки (`narrationLayout = null`) — `storyNarrationParts` выводит
 * то же самое из `text`/`giftNote`/`giftNotePosition` и сверяет склейку.
 */
export type StoryNarrationLayout = {
  version: 1;
  unit: 'utf16';
  separator: '\n\n';
  main: { start: number; end: number; sha256: string };
  giftNote: null | {
    position: StoryGiftNotePosition;
    start: number;
    end: number;
    sha256: string;
  };
};

export function composeStoryNarration(
  main: string,
  note: string | null,
  position: StoryGiftNotePosition,
): { text: string; layout: StoryNarrationLayout } {
  const sep = STORY_SEGMENT_SEPARATOR;
  if (!note) {
    return {
      text: main,
      layout: {
        version: 1,
        unit: 'utf16',
        separator: sep,
        main: { start: 0, end: main.length, sha256: sha(main) },
        giftNote: null,
      },
    };
  }
  const text =
    position === 'beginning' ? `${note}${sep}${main}` : `${main}${sep}${note}`;
  const mainStart = position === 'beginning' ? note.length + sep.length : 0;
  const noteStart = position === 'beginning' ? 0 : main.length + sep.length;
  return {
    text,
    layout: {
      version: 1,
      unit: 'utf16',
      separator: sep,
      main: {
        start: mainStart,
        end: mainStart + main.length,
        sha256: sha(main),
      },
      giftNote: {
        position,
        start: noteStart,
        end: noteStart + note.length,
        sha256: sha(note),
      },
    },
  };
}

export type StoryNarrationParts = {
  main: string;
  giftNote: null | { text: string; position: StoryGiftNotePosition };
  layout: StoryNarrationLayout;
  /** true — строка до WP3, раскладка восстановлена из склейки. */
  legacy: boolean;
};

/**
 * Для WP4: разложить сохранённый подарок на основной текст и отдельный
 * сегмент реплики. Бросает Error, если раскладка не сходится с `text`
 * (повреждение данных — не угадывать, остановить сборку).
 */
export function storyNarrationParts(row: {
  text: string;
  giftNote?: string | null;
  giftNotePosition?: string | null;
  narrationLayout?: unknown;
}): StoryNarrationParts {
  const stored = row.narrationLayout as StoryNarrationLayout | null | undefined;
  if (stored && stored.version === 1) {
    const main = row.text.slice(stored.main.start, stored.main.end);
    if (sha(main) !== stored.main.sha256)
      throw new Error('Story narration layout does not match text');
    if (!stored.giftNote)
      return { main, giftNote: null, layout: stored, legacy: false };
    const note = row.text.slice(stored.giftNote.start, stored.giftNote.end);
    if (sha(note) !== stored.giftNote.sha256)
      throw new Error('Story gift note layout does not match text');
    return {
      main,
      giftNote: { text: note, position: stored.giftNote.position },
      layout: stored,
      legacy: false,
    };
  }
  const note = row.giftNote || null;
  const position: StoryGiftNotePosition =
    row.giftNotePosition === 'beginning' ? 'beginning' : 'end';
  const sep = STORY_SEGMENT_SEPARATOR;
  let main = row.text;
  if (note) {
    if (position === 'beginning' && row.text.startsWith(`${note}${sep}`))
      main = row.text.slice(note.length + sep.length);
    else if (position === 'end' && row.text.endsWith(`${sep}${note}`))
      main = row.text.slice(0, row.text.length - note.length - sep.length);
    else throw new Error('Legacy story text does not contain the gift note');
  }
  const rebuilt = composeStoryNarration(main, note, position);
  if (rebuilt.text !== row.text)
    throw new Error('Legacy story text layout is ambiguous');
  return {
    main,
    giftNote: note ? { text: note, position } : null,
    layout: rebuilt.layout,
    legacy: true,
  };
}
