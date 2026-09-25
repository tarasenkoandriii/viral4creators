/**
 * Тикет тестировщика — разбор входящего из бота (этап 157,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3).
 *
 * Здесь только решения, которые можно принять, ничего не спрашивая у
 * мира: что это за вложение, влезает ли оно, склеивать ли сообщение с
 * предыдущим, что ответить при переборе частоты. Всё, что ходит в
 * Telegram, в хранилище и в базу, — в `telegram-bot/tester-tickets`.
 */

/**
 * Статусы строками, а не Prisma-енумом, — тем же решением и по той же
 * причине, что у `WizardExperienceCandidate`: набор статусов у очереди
 * разбора меняется чаще, чем стоит миграции.
 *
 * `ANSWERED` отделён от `IN_PROGRESS` намеренно: «мы спросили уточнение
 * и ждём тестировщика» и «мы чиним» — разные положения, и в первом
 * очередь ждёт ЕГО. Без различия оператор не видит, где мяч на чужой
 * стороне.
 */
export const TICKET_STATUSES = [
  'NEW',
  'IN_PROGRESS',
  'ANSWERED',
  'FIXED',
  'REJECTED',
  'DUPLICATE',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function isTicketStatus(value: unknown): value is TicketStatus {
  return (
    typeof value === 'string' &&
    (TICKET_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Окно склейки. Скриншот и подпись к нему приезжают двумя сообщениями
 * подряд, и двумя находками в очереди они означали бы двойной разбор
 * одной работы.
 */
export const MERGE_WINDOW_MS = 2 * 60 * 1000;

/** Своё ограничение, не платформенное: больше пяти — это уже переписка. */
export const MAX_ATTACHMENTS = 5;

/**
 * Потолок Bot API на скачивание, а НЕ наше решение: обычный Bot API
 * отдаёт файлы не больше 20 МБ, снимается это только своим
 * Bot API-сервером. Практическое следствие — минутная запись экрана не
 * влезет, и сказать об этом человеку обязательно: молча потерянное
 * вложение он считает отправленным.
 */
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;

/** Сообщений в час на тестировщика. */
export const RATE_LIMIT = 30;
export const RATE_WINDOW_SEC = 60 * 60;

export type AttachmentKind = 'PHOTO' | 'VIDEO' | 'DOCUMENT' | 'VOICE' | 'AUDIO';

/** Что нашлось в сообщении: ещё не файл, а заявка на него. */
export interface AttachmentClaim {
  fileId: string;
  kind: AttachmentKind;
  /** `undefined` — Telegram размера не прислал; это не повод отказывать. */
  size?: number;
  fileName?: string;
  mimeType?: string;
}

/** Сообщение Telegram в объёме, который нужен разбору вложений. */
export interface IncomingMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id?: string; file_size?: number }>;
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: { file_id?: string; mime_type?: string; file_size?: number };
  animation?: { file_id?: string; mime_type?: string; file_size?: number };
  video_note?: { file_id?: string; file_size?: number };
  voice?: { file_id?: string; mime_type?: string; file_size?: number };
  audio?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  reply_to_message?: { message_id?: number };
}

/**
 * Вложения сообщения.
 *
 * `photo` приходит лестницей размеров одного и того же снимка —
 * берётся САМЫЙ БОЛЬШОЙ: мелкий превью-размер как доказательство бага
 * бесполезен, на нём не видно того, ради чего скриншот и прислали.
 *
 * Одно сообщение несёт не больше одного файла — Telegram так устроен, —
 * но перечислены все виды, потому что пропущенный вид означает молча
 * потерянное вложение, а это худший исход из возможных.
 */
export function attachmentsOf(message: IncomingMessage): AttachmentClaim[] {
  const claims: AttachmentClaim[] = [];

  const photo = [...(message.photo ?? [])]
    .filter((p) => p.file_id)
    .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
    .pop();
  if (photo?.file_id) {
    claims.push({
      fileId: photo.file_id,
      kind: 'PHOTO',
      size: photo.file_size,
      mimeType: 'image/jpeg',
    });
  }

  const simple: Array<
    [AttachmentKind, IncomingMessage[keyof IncomingMessage]]
  > = [
    ['VIDEO', message.video],
    ['VIDEO', message.animation],
    ['VIDEO', message.video_note],
    ['VOICE', message.voice],
    ['AUDIO', message.audio],
    ['DOCUMENT', message.document],
  ];
  for (const [kind, raw] of simple) {
    const file = raw as
      | {
          file_id?: string;
          file_name?: string;
          mime_type?: string;
          file_size?: number;
        }
      | undefined;
    if (!file?.file_id) continue;
    claims.push({
      fileId: file.file_id,
      kind,
      size: file.file_size,
      fileName: file.file_name,
      mimeType: file.mime_type,
    });
  }

  return claims.slice(0, MAX_ATTACHMENTS);
}

/** Не влезет в Bot API. Размер неизвестен — считаем, что влезет. */
export function tooBig(claim: AttachmentClaim): boolean {
  return (claim.size ?? 0) > TELEGRAM_FILE_LIMIT;
}

/** Текст сообщения: подпись к файлу — такой же текст находки. */
export function textOf(message: IncomingMessage): string {
  return (message.text ?? message.caption ?? '').trim();
}

/**
 * Приклеить ли это сообщение к предыдущему тикету.
 *
 * Только к САМОМУ свежему и только внутри окна. Намеренно не «к
 * последнему открытому»: человек, вернувшийся через час, пишет про
 * другое, и подклеить это к вчерашней находке значит потерять обе.
 */
export function mergesInto(
  previous: { lastMessageAt: Date | null } | null,
  now: Date,
  windowMs: number = MERGE_WINDOW_MS,
): boolean {
  if (!previous?.lastMessageAt) return false;
  // От последнего сообщения ТЕСТИРОВЩИКА, а не от создания тикета и не
  // от `updatedAt`.
  //
  // Не от создания — цепочка «скриншот → подпись → второй скриншот» не
  // должна рваться посередине только потому, что первое сообщение
  // отправлено давно.
  //
  // И не от `updatedAt` (аудит этапа 157): его двигает ЛЮБАЯ правка
  // строки — ответ оператора, смена статуса, дописанный
  // `botMessageIds`. Оператор ответил на вчерашний тикет, тестировщик
  // через минуту прислал новую, ни с чем не связанную находку — и она
  // молча уехала бы в тот вчерашний тикет. Окно склейки меряет паузу в
  // речи ЧЕЛОВЕКА, и опираться оно обязано только на его сообщения.
  return now.getTime() - previous.lastMessageAt.getTime() <= windowMs;
}

export type RateVerdict = 'allow' | 'warn' | 'silence';

/**
 * Что делать с сообщением при переборе частоты.
 *
 * Отказ ОДИН раз, дальше молчание: бот, отвечающий «слишком часто» на
 * каждое из тридцати следующих сообщений, сам становится спамом — и
 * ровно в тот момент, когда человек и так раздражён.
 */
export function rateVerdict(
  count: number,
  limit: number = RATE_LIMIT,
): RateVerdict {
  if (count <= limit) return 'allow';
  return count === limit + 1 ? 'warn' : 'silence';
}

/**
 * Склейка текста. Пустое сообщение (один файл без подписи) не добавляет
 * пустых строк — иначе тикет из трёх скриншотов состоит из переносов.
 */
export function mergeText(previous: string, addition: string): string {
  const next = addition.trim();
  if (!next) return previous;
  return previous.trim() ? `${previous.trim()}\n\n${next}` : next;
}

/**
 * Статусы, которые нельзя поставить молча (§5.1 ТЗ).
 *
 * «Отклонено» и «дубль» — это ответ человеку, который потратил время;
 * без причины он читается как «нам всё равно». Остальные переходы —
 * рабочее состояние очереди, объяснять их некому и незачем.
 */
export const STATUSES_NEEDING_REASON: readonly TicketStatus[] = [
  'REJECTED',
  'DUPLICATE',
];

export function needsReason(status: TicketStatus): boolean {
  return STATUSES_NEEDING_REASON.includes(status);
}

/** Открытые статусы — те, где очередь ждёт НАС. */
export const OPEN_STATUSES: readonly TicketStatus[] = [
  'NEW',
  'IN_PROGRESS',
  'ANSWERED',
];

interface EnvLike {
  surface?: unknown;
  osFamily?: unknown;
  osVersion?: unknown;
  deviceKind?: unknown;
  screen?: unknown;
  viewport?: unknown;
  appBuild?: unknown;
  uiLocale?: unknown;
}

const DEVICE_WORDS: Record<string, string> = {
  PHONE: 'телефон',
  TABLET: 'планшет',
  DESKTOP: 'компьютер',
};

/**
 * Окружение одной строкой для списка и шапки карточки (§5.1):
 * `TMA · iOS 18 · телефон · 390×844 · uk · сборка 2026.09.25-a1b2c3d`.
 *
 * Пропущенные поля выпадают целиком, а не превращаются в «—»: строка
 * читается взглядом, и прочерки в ней занимают место, ничего не
 * сообщая. Полный список с прочерками раскрывается отдельно — там они
 * как раз к месту, потому что отвечают на вопрос «а это вы знаете?».
 *
 * Размер берётся от ВИДИМОЙ области, а не от экрана: «не влезло»
 * меряют по ней. Экран остаётся в раскрытом списке.
 */
export function envSummary(env: unknown): string {
  if (typeof env !== 'object' || env === null) return '';
  const e = env as EnvLike;
  const parts: string[] = [];

  const surface = str(e.surface);
  if (surface) parts.push(surface === 'TMA' ? 'Telegram' : 'браузер');

  const os = str(e.osFamily);
  if (os && os !== 'unknown') {
    const version = str(e.osVersion);
    parts.push(version ? `${osLabel(os)} ${version}` : osLabel(os));
  }

  const device = str(e.deviceKind);
  if (device && DEVICE_WORDS[device]) parts.push(DEVICE_WORDS[device]);

  const size = sizeOf(e.viewport);
  if (size) parts.push(size);

  const locale = str(e.uiLocale);
  if (locale) parts.push(locale);

  const build = str(e.appBuild);
  if (build && build !== 'unknown') parts.push(`сборка ${build}`);

  return parts.join(' · ');
}

const OS_LABELS: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

function osLabel(family: string): string {
  return OS_LABELS[family] ?? family;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sizeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { w, h } = value as { w?: unknown; h?: unknown };
  return typeof w === 'number' && typeof h === 'number' ? `${w}×${h}` : null;
}
