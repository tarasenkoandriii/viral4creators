// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/delimiter-buffer.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Потоковый буфер разделителя блока действий (ТЗ лендинга §5.4).
 *
 * Модель заканчивает ответ разделителем и JSON с кнопками; разделитель
 * никогда не должен попасть посетителю в стрим. Он может прийти разрезанным
 * на любые куски, поэтому неотправленным держится хвост длиной до
 * `delimiter.length - 1` символов, пока не станет ясно, что это не начало
 * разделителя — стандартный приём потокового поиска подстроки на границе
 * чанков. Чистый модуль (см. шапку `protocol.ts`).
 */

/** Разделитель блока действий в ответе модели. */
export const ACTIONS_DELIMITER = '<<<actions>>>';

/** Не длиннее разделителя — столько символов максимум держит буфер (плюс один). */
export const ACTIONS_DELIMITER_MAX_PREFIX = ACTIONS_DELIMITER.length;

/** С какой длины начало разделителя в конце ответа считается его обрывком. */
export const ACTIONS_DELIMITER_MIN_DANGLING = 3;

/**
 * Длина самого длинного собственного начала `delimiter`, которым кончается
 * `tail` (0 — нет или короче `minLength`).
 */
export function danglingDelimiterPrefix(
  tail: string,
  delimiter: string = ACTIONS_DELIMITER,
  minLength: number = ACTIONS_DELIMITER_MIN_DANGLING,
): number {
  const max = Math.min(tail.length, delimiter.length - 1);
  for (let k = max; k >= Math.max(1, minLength); k--) {
    if (tail.endsWith(delimiter.slice(0, k))) return k;
  }
  return 0;
}

export interface SplitResult {
  /** Текст ДО разделителя — то, что видит посетитель. */
  text: string;
  /** Всё, что было после разделителя (сырой JSON) — `null`, если разделителя не было вовсе. */
  rawActionsJson: string | null;
}

/** Режет уже собранный полный текст ответа по разделителю (не потоково). */
export function splitActionsBlock(
  fullText: string,
  delimiter: string = ACTIONS_DELIMITER,
): SplitResult {
  const idx = fullText.indexOf(delimiter);
  if (idx === -1) return { text: fullText, rawActionsJson: null };
  return {
    text: fullText.slice(0, idx),
    rawActionsJson: fullText.slice(idx + delimiter.length),
  };
}

/**
 * Копит текст стрима и отдаёт наружу только ту часть, которая точно не
 * относится к разделителю. После разделителя наружу не уходит ничего:
 * остальное — блок действий, его разбирают на собранном тексте.
 */
export class DelimiterStreamBuffer {
  private text = '';
  private emittedLength = 0;
  private found = false;

  constructor(private readonly delimiter: string = ACTIONS_DELIMITER) {
    // Пустой разделитель «находится» в позиции 0 и молча съел бы весь
    // ответ — это ошибка вызывающего кода, а не ответа модели.
    if (!delimiter) throw new Error('разделитель не может быть пустым');
  }

  /** Весь накопленный текст, включая разделитель и блок действий. */
  get fullText(): string {
    return this.text;
  }

  get delimiterFound(): boolean {
    return this.found;
  }

  /** Добавляет кусок стрима; возвращает текст, который можно отдать сейчас ('' — нечего). */
  push(piece: string): string {
    if (!piece) return '';
    this.text += piece;
    if (this.found) return '';

    const idx = this.text.indexOf(this.delimiter);
    if (idx !== -1) {
      this.found = true;
      return this.emitUpTo(idx);
    }
    const safeLen = Math.max(
      this.emittedLength,
      this.text.length - (this.delimiter.length - 1),
    );
    return this.emitUpTo(safeLen);
  }

  /**
   * Конец стрима: хвост, придержанный на случай начала разделителя.
   * Если разделитель был — отдавать нечего, всё после него не для глаз.
   *
   * Хвост, который сам — начало разделителя не короче
   * `ACTIONS_DELIMITER_MIN_DANGLING` (`<<<`, `<<<acti`…), не отдаётся:
   * так кончается ответ, оборванный потолком (`MAX_TOKENS`) посреди
   * разделителя, и посетитель увидел бы служебный обрывок. Обычный текст
   * так не кончается; одиночные `<` и `<<` отдаются как есть.
   */
  flush(): string {
    if (this.found) return '';
    const end =
      this.text.length -
      danglingDelimiterPrefix(
        this.text.slice(this.emittedLength),
        this.delimiter,
      );
    const out = this.emitUpTo(end);
    this.emittedLength = this.text.length;
    return out;
  }

  private emitUpTo(end: number): string {
    if (end <= this.emittedLength) return '';
    const out = this.text.slice(this.emittedLength, end);
    this.emittedLength = end;
    return out;
  }
}
