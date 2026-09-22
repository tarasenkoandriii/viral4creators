/**
 * Каналы вручения поздравления — фича №26 компаньон-ТЗ
 * (`TZ-Greeting-Video-Upgrade-40-Features.md`), этап 4 плана
 * `docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md`.
 *
 * Зачем это первым в этапе, а не №19 «отложенная доставка», как
 * пронумеровано: находка 1.8 аудита — доставлять сегодня НЕКУДА. Канал
 * связи с получателем появляется здесь; без него отложенная доставка
 * означает «ролик лежит и ждёт», без адресата.
 *
 * Что именно отправляется — решение, а не деталь. Ссылка на сам
 * видеофайл (`generatedVideo.downloadUrl`), НЕ публичная страница
 * `/video/:id`: та требует одобрения оператором (`SharedVideoPage`
 * PENDING → PUBLISHED), а поздравление бабушке не может ждать
 * модератора. Ссылка постоянная: сессию с готовым роликом TTL-уборка не
 * трогает с этапа 88.1 (`SessionService.cleanupExpiredSessions`,
 * `generationStatus: { not: 'complete' }`), то есть завтра она не
 * умрёт.
 *
 * Цена этого решения названа в интерфейсе прямым текстом, а не спрятана:
 * ссылку откроет ЛЮБОЙ, кому она попадёт. Для поздравления с именем
 * получателя в кадре это не мелочь (та же забота о третьем лице, что уже
 * заставила `snapshotFromSession` не выносить имя в публичный заголовок).
 *
 * Здесь — только чистая сборка адресов, без React: её видно и её можно
 * проверить. Ровно тот же приём, что у `landing-entry.ts`.
 */

/** Максимум, который переживает переход через `t.me/share/url`. */
const TELEGRAM_TEXT_LIMIT = 200;

/**
 * Текст, который поедет вместе со ссылкой.
 *
 * Имя получателя подставляется, имя отправителя — только если оно
 * заполнено (в брифе оно необязательное). Повод в текст НЕ попадает:
 * подпись повода живёт в словаре на пяти языках, а сообщение уходит
 * человеку, чей язык нам неизвестен, — угадывать хуже, чем не писать.
 */
export function deliveryMessage(
  template: string,
  recipientName: string,
  senderName?: string | null
): string {
  const from = (senderName ?? '').trim();
  const text = template
    .replace('{recipient}', recipientName.trim())
    .replace('{sender}', from)
    // Шаблон без отправителя оставляет «от » с висящим предлогом —
    // убираем хвост целиком, а не подставляем пустую строку.
    .replace(/\s*\(\s*\)\s*$/, '')
    .trim();
  return text.length > TELEGRAM_TEXT_LIMIT
    ? `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`
    : text;
}

/**
 * Пересылка в Telegram. Официальный адрес шаринга Telegram; внутри
 * Mini App его нужно открывать через `openTelegramLink`, иначе клиент
 * откроет его во ВНУТРЕННЕМ webview поверх нашего же приложения.
 */
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/**
 * WhatsApp. `api.whatsapp.com/send` работает и в вебе, и на телефоне, в
 * отличие от схемы `whatsapp://`, которая на десктопе без клиента даёт
 * пустую вкладку. Ссылка кладётся в тот же параметр `text`: отдельного
 * поля под адрес у WhatsApp нет.
 */
export function whatsappShareUrl(url: string, text: string): string {
  return `https://api.whatsapp.com/send?text=${encodeURIComponent(`${text} ${url}`)}`;
}

/**
 * Почта. `mailto:` без адресата — получателя выберет сам отправитель в
 * своём почтовом клиенте: адреса получателя у нас нет и запрашивать его
 * ради одной кнопки значило бы собирать персональные данные третьего
 * лица без нужды.
 */
export function mailtoUrl(subject: string, text: string, url: string): string {
  const body = `${text}\n\n${url}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Напоминание отправителю на следующий год — фича №25, в том виде, в
 * котором её переформулировал аудит (находка 1.10).
 *
 * В компаньон-ТЗ фича называлась «интеграция с календарём ПОЛУЧАТЕЛЯ».
 * Такого доступа у сервиса нет и быть не может, а кнопка «добавить в
 * календарь» на странице просмотра добавила бы получателю его
 * собственный день рождения — то есть ничего. Полезная версия —
 * файл для ОТПРАВИТЕЛЯ, в его же кабинете, сразу после того, как ролик
 * готов.
 *
 * Дата — ровно год от сегодняшнего дня, и это ДОПУЩЕНИЕ, а не факт:
 * настоящей даты повода в брифе нет (там повод-категория и имя, без
 * числа). Поздравление обычно делают в сам день или накануне, поэтому
 * год от создания — лучшее, что известно. Интерфейс говорит об этом
 * прямо и предлагает поправить дату в календаре, а не делает вид, что
 * знает её.
 *
 * Напоминание — за неделю (`TRIGGER:-P7D`): ролик надо успеть собрать,
 * а не узнать о поводе в день его наступления.
 *
 * Формат — минимальный валидный VCALENDAR: переносы строк CRLF (так
 * требует RFC 5545, и Outlook на `\n` действительно спотыкается),
 * экранирование запятых и точек с запятой в тексте, `UID` из даты и
 * имени, чтобы повторное добавление не плодило дубли.
 */
export function reminderIcs(opts: {
  summary: string;
  description: string;
  /** Дата напоминания; обычно «год от сегодня». */
  date: Date;
}): string {
  const yyyymmdd = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
      d.getUTCDate()
    ).padStart(2, '0')}`;
  const esc = (s: string) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  const day = yyyymmdd(opts.date);
  const next = new Date(opts.date);
  next.setUTCDate(next.getUTCDate() + 1);
  const uid = `greeting-${day}-${Math.abs(hash(opts.summary))}@viral4creators`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//viral4creators//greeting//RU',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${day}T000000Z`,
    // Событие на весь день: у повода нет времени, и ставить условные
    // 12:00 значило бы придумать ещё и час.
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${yyyymmdd(next)}`,
    `SUMMARY:${esc(opts.summary)}`,
    `DESCRIPTION:${esc(opts.description)}`,
    'BEGIN:VALARM',
    'TRIGGER:-P7D',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(opts.summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/** Год от указанной даты — в UTC, чтобы 29 февраля не уехало на день. */
export function oneYearLater(from: Date): Date {
  const d = new Date(
    Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), from.getUTCDate())
  );
  return d;
}

/** Небольшой стабильный хеш для UID — не криптография, а уникальность. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
