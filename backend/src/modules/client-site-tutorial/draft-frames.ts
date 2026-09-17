/**
 * Кадры предпросмотра черновика: путь в Blob и разбор `data:`-URL —
 * §5.2 (`/finish`), §6.3 ТЗ (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 113.
 *
 * ## Почему отдельный файл на три функции
 *
 * Обе задачи — сборка пути и разбор data-URL — ошибочны ровно один раз
 * и потом молча: путь, разошедшийся между `/finish`, `DELETE` и
 * админкой, оставляет файлы в Blob навсегда (§15 п.4 аудита ТЗ — ровно
 * эта находка), а неверный разбор data-URL кладёт в Blob «файл»,
 * который открывается как мусор, и видно это станет только на готовом
 * ролике. Ни то ни другое не требует ни БД, ни сети, значит должно
 * проверяться тестами без них.
 *
 * ## Почему путь ключуется `draftId`, а не `scenarioId`
 *
 * §5.2 ТЗ: у этого вида проекта нет строки `TutorialScenario` вообще.
 * Паттерн пути тот же, что у штатной обучалки
 * (`tutorial-video-frames/{owner}/{n}.jpg`), владелец другой — и это
 * сознательно: дальше по конвейеру оба вида кадров собирает один и тот
 * же внешний ffmpeg-api одной и той же командой.
 */

/** Общий префикс всех кадров одного черновика. Именно ПРЕФИКС, а не
 * список файлов: `/finish` обязан стереть то, что лежало здесь раньше,
 * включая «хвост» от прошлого, более длинного прогона (§15 п.4). */
export function draftFramePrefix(draftId: string): string {
  return `tutorial-video-frames/${draftId}/`;
}

export function draftFramePathname(draftId: string, index: number): string {
  return `${draftFramePrefix(draftId)}${index}.jpg`;
}

export class FrameDecodeError extends Error {}

/**
 * Разбирает `data:image/jpeg;base64,…` в байты.
 *
 * Строгий разбор, а не «отрезать всё до запятой»: содержимое приходит
 * из колонки БД, которую мог записать более старый код, и класть в Blob
 * неизвестно что под именем `.jpg` нельзя. Не-base64 и не-изображения
 * отклоняются с внятной ошибкой, а не превращаются в битый файл.
 */
export function decodeFrameDataUrl(dataUrl: string): {
  buffer: Buffer;
  contentType: string;
} {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(
    dataUrl ?? '',
  );
  if (!match) {
    throw new FrameDecodeError(
      'кадр предпросмотра не похож на data:image/...;base64 — залить его в хранилище нельзя',
    );
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) {
    throw new FrameDecodeError('кадр предпросмотра пуст');
  }
  return { buffer, contentType: match[1].toLowerCase() };
}
