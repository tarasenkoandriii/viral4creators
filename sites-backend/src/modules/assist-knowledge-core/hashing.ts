/**
 * Хеши фрагментов — K2 (§4-тер.2): contentHash — SHA-256 нормализованного
 * текста (пробелы, NFC; регистр не трогаем — «ABC» и «abc» в артикуле
 * разные); digitsMaskedHash — то же с заменой каждой последовательности
 * цифр (включая 1 200,50 / 1.200 / 12:30 / 1 200 ₴) на один маркер —
 * «изменились только числа» → вектор не пересчитывается.
 */
import { createHash } from 'crypto';

/** NFC + любые пробелы (в т.ч. неразрывные) → один пробел, обрезка краёв. */
export function normalizeChunkText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\s   ]+/gu, ' ')
    .trim();
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function contentHash(text: string): string {
  return sha256(normalizeChunkText(text));
}

/**
 * Число целиком — цифры с разделителями разрядов/дробей/времени между
 * ними: «1 200,50», «1.200», «12:30», «2026-10-01» → один маркер. Знаки
 * вокруг (₴, $, %) остаются: «70 грн» → «# грн» и «80 грн» → «# грн».
 */
const NUMBER_RUN = /\d(?:[\d\s  .,:'’/-]*\d)?/gu;

export function maskDigits(text: string): string {
  return normalizeChunkText(text).replace(NUMBER_RUN, '#');
}

export function digitsMaskedHash(text: string): string {
  // Префикс — чтобы хеш маскированного текста без цифр не совпадал с
  // contentHash того же текста (это разные пространства значений).
  return sha256(`digits:${maskDigits(text)}`);
}
