/**
 * Съёмка персоны камерой (ТЗ Greeting 2.0 §4.1 п.2, §4.3) — чистая часть:
 * можно ли снимать в этом окружении, формат ролика живости, подсказка
 * «поверните голову» по времени, фраза согласия голоса.
 *
 * Только камера, без галереи — намеренно (§4.3): загрузка готового фото
 * пропускала бы чужое лицо мимо проверки живости. Поэтому здесь нет и не
 * должно появиться выбора файла.
 */

/** Длина ролика живости — 3 с (§4.1 п.2). */
export const LIVENESS_MS = 3000;

/**
 * Что умеет окружение. Проверка по признакам, а не по user-agent:
 * WebView Telegram на части Android отдаёт `mediaDevices` без
 * `getUserMedia`, а на старом iOS — вовсе без `mediaDevices`; и там, и
 * там единственная честная дорога — веб-версия (§4.3).
 */
export type CameraSupport = 'ok' | 'no-camera' | 'insecure' | 'no-recorder';

export function cameraSupport(env: {
  secureContext: boolean;
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
}): CameraSupport {
  // getUserMedia вне HTTPS браузер не даёт вовсе — сказать об этом
  // отдельно: «откройте веб-версию» тут не поможет, если она тоже http.
  if (!env.secureContext) return 'insecure';
  if (!env.hasGetUserMedia) return 'no-camera';
  // Фото без ролика бесполезно: проверка живости обязательна.
  if (!env.hasMediaRecorder) return 'no-recorder';
  return 'ok';
}

/**
 * Форматы ролика — первый, который умеет браузер (тот же приём, что
 * `pickRecorderMime` в voice-listen.ts). Safari пишет только mp4, Chrome
 * и Android WebView — webm.
 */
export const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
] as const;

/** `null` — ни один не подтверждён: `MediaRecorder` без `mimeType`. */
export function pickVideoMime(
  isSupported: (mime: string) => boolean
): string | null {
  for (const c of VIDEO_MIME_CANDIDATES) if (isSupported(c)) return c;
  return null;
}

/**
 * Форматы образца голоса — только те, что принимает `POST /voices/upload-url`
 * (`ALLOWED_MIME_TYPES` в user-voices.dto.ts). В отличие от прослушивания
 * (voice-listen.ts) здесь нет ogg: сервер образцов его не принимает, и
 * Firefox с ogg получил бы 400 уже после записи фразы согласия.
 */
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;

export function pickAudioMime(
  isSupported: (mime: string) => boolean
): string | null {
  for (const c of AUDIO_MIME_CANDIDATES) if (isSupported(c)) return c;
  return null;
}

/**
 * Тип без параметров кодека: `audio/webm;codecs=opus` → `audio/webm`.
 * Серверные DTO сверяют `mimeType` со списком голых типов (`@IsIn`), и
 * запись с кодеком получала бы 400 на выдаче адреса загрузки.
 */
export function baseMime(
  mime: string | null | undefined,
  fallback: string
): string {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  return m || fallback;
}

/**
 * Подсказка по ходу трёх секунд: прямо → влево → вправо. Трети, а не
 * «сначала повернуть, потом вернуть» — модели нужно видеть и анфас, и
 * оба профиля, чтобы отличить живую голову от листа бумаги (§4.3).
 */
export type HeadTurnCue = 'straight' | 'left' | 'right' | 'done';

export function headTurnCue(
  elapsedMs: number,
  totalMs = LIVENESS_MS
): HeadTurnCue {
  if (elapsedMs >= totalMs) return 'done';
  const third = totalMs / 3;
  if (elapsedMs < third) return 'straight';
  if (elapsedMs < 2 * third) return 'left';
  return 'right';
}

/** Оставшиеся целые секунды для счётчика — «3, 2, 1», не «2.4». */
export function secondsLeft(elapsedMs: number, totalMs = LIVENESS_MS): number {
  return Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
}

/**
 * Адрес веб-версии этого же экрана. Та же сборка раздаётся и как Mini
 * App, и с Vercel (router.ts) — значит, достаточно открыть текущий адрес
 * во внешнем браузере; хеш — на экран персоны, query (initData
 * Telegram) не переносим: вне Telegram он не действует, вход там свой.
 */
export function webVersionUrl(
  loc: { origin: string; pathname: string },
  hashRoute: string
): string {
  const path = hashRoute.startsWith('/') ? hashRoute : `/${hashRoute}`;
  return `${loc.origin}${loc.pathname}#${path}`;
}

/**
 * Фраза согласия голоса с именем человека (§4.6: «Я, <имя>, разрешаю…»).
 * Сервер отдаёт шаблон с `{name}` (или `{{name}}` / `<имя>`),
 * а может — уже готовую фразу; без имени вставка убирается вместе с
 * запятыми вокруг, а не остаётся «Я, , разрешаю».
 */
export function consentPhraseWithName(
  phrase: string,
  name: string | null | undefined
): string {
  const n = (name ?? '').trim();
  // `{name}` — вставка сервера (PERSONA_VOICE_NAME_PLACEHOLDER); прочие
  // формы — на случай, если редакцию фразы перепишут.
  const slot = /\{\{\s*name\s*\}\}|\{\s*name\s*\}|<[^<>]{1,20}>/;
  if (!slot.test(phrase)) return phrase;
  if (n) return phrase.replace(slot, n);
  return phrase
    .replace(new RegExp(`,\\s*(?:${slot.source})\\s*,`), '')
    .replace(slot, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Типы, под которые сервер подписывает ссылки загрузки (зеркало
 * `PERSONA_LIVENESS_MIME_TYPES` в persona-rules.ts). Chrome иногда
 * называет свой webm-контейнер `video/x-matroska` — это тот же файл.
 */
export const LIVENESS_UPLOAD_MIMES = [
  'video/webm',
  'video/mp4',
  'video/quicktime',
] as const;

export function livenessUploadMime(
  recorded: string | null | undefined
): string {
  const m = baseMime(recorded, 'video/webm');
  return (LIVENESS_UPLOAD_MIMES as readonly string[]).includes(m)
    ? m
    : 'video/webm';
}
