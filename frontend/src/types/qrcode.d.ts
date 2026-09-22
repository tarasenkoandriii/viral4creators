/**
 * Минимальное объявление `qrcode` — ровно то, чем пользуется
 * `GreetingQrCode.tsx` (фича №21).
 *
 * Почему не `@types/qrcode`, который есть в npm: тот пакет объявляет
 * серверную часть API (`toFileStream`, `toBuffer`) и ради неё зависит от
 * `@types/node`. Его установка подняла `@types/node` на верхний уровень
 * `node_modules/@types`, откуда TypeScript подхватывает типы
 * автоматически, — и `setTimeout` во ВСЁМ проекте стал возвращать
 * `NodeJS.Timeout` вместо `number`. Сборка упала в
 * `src/hooks/useWorkflow.ts`, которого правка не касалась вовсе.
 *
 * Браузерная часть библиотеки — одна функция, и объявить её здесь
 * дешевле, чем тащить в браузерный проект типы серверной платформы.
 */
declare module 'qrcode' {
  export interface QrCodeToDataUrlOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }

  /** Возвращает `data:image/png;base64,…`. */
  export function toDataURL(
    text: string,
    options?: QrCodeToDataUrlOptions
  ): Promise<string>;
}
