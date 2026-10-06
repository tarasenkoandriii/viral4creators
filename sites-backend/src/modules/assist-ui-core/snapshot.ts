/**
 * Снимок интерактивных элементов страницы (§5-бис.3 п.2, аудит 1.2) —
 * строгий разбор того, что прислал iframe (а ему — загрузчик со страницы
 * заказчика: данные НЕДОВЕРЕННЫЕ, §4.6 п.5).
 *
 * Второй слой защиты ПД: загрузчик уже маскировал подписи (порт
 * `maskSensitiveEcho`) и выкинул поля пароля/карты/кода/файла, `never`-зоны,
 * denylist и собственный корень; здесь подписи маскируются ещё раз, поля
 * чувствительных типов отбрасываются ещё раз, подписи чистятся от
 * управляющих символов и разметки (они пойдут в промпт блоком данных).
 * Снимок НЕ сохраняется нигде — ни в базу, ни в кэш, ни в журнал (в
 * журнал идёт только описание цели шага).
 */
import { maskSensitiveEcho } from '../../shared/assist-chat-core/post-filter';
import {
  UI_GESTURES,
  UI_ROLES,
  type UiGesture,
  type UiRole,
  type UiSnapElement,
  type UiSnapshot,
} from './types';

export const SNAPSHOT_LIMITS = {
  elements: 150,
  text: 80,
  options: 12,
  href: 300,
  url: 2000,
  title: 200,
  /** Тело снимка целиком (JSON) — граница разбора до работы. */
  bodyChars: 60_000,
} as const;

/** Подписи маскируются тем же словарём, что журнал (метки — нейтральные). */
const MASK_LABELS = { email: '[e-mail]', phone: '[тел.]', token: '[ключ]' };
/**
 * Длинные цифровые последовательности (номера карт, счетов, ID, телефоны
 * без «+») — §5-бис.3 п.2: 9+ цифр, между цифрами — до двух разделителей
 * из пробела, дефиса и скобок. Аудит тестов: «(67) 123-45-67» (скобка и
 * пробел подряд) раньше проходил открытым — словарь телефонов чата его не
 * ловит, а прежнее правило допускало один разделитель.
 */
const LONG_DIGITS = /\(?\d(?:[\s()-]{0,2}\d){8,}/g;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/** Маскирование подписи: e-mail, телефоны, ключи, длинные цифры. */
export function maskLabel(raw: string): string {
  return maskSensitiveEcho(raw, MASK_LABELS).replace(LONG_DIGITS, '[№]');
}

/**
 * Маски ПД в ПУТИ страницы (аудит Э6-бис): `/account/ivan@x.com`,
 * `/u/+380501234567`, `/orders/1234 5678 9012` — адрес уходит в промпт,
 * план и журнал. Маски — латиницей, как параметры маршрута (`:email`,
 * `:phone`, `:token`, `:n`), чтобы адрес оставался адресом. Даты
 * (`2026-10-03`) и короткие номера не трогаются: телефон — с `+` или 9+
 * цифр подряд (тот же порог, что «длинные цифры» подписей).
 */
const PATH_EMAIL = /[^\s/@]+@[^\s/@]+\.[A-Za-z]{2,}/g;
const PATH_TOKEN = /\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g;
const PATH_PHONE = /\+\d(?:[\s().-]?\d){6,}/g;

function maskPathSegment(seg: string): string {
  let d = seg;
  try {
    d = decodeURIComponent(seg);
  } catch {
    d = seg;
  }
  const m = d
    .replace(PATH_EMAIL, ':email')
    .replace(PATH_TOKEN, ':token')
    .replace(PATH_PHONE, ':phone')
    .replace(LONG_DIGITS, ':n');
  return m === d ? seg : m;
}

/**
 * Путь (`/u/ivan@x.com`) с теми же масками ПД, что у адреса страницы, —
 * для пути ссылки в дескрипторе голосовой карты (аудит Э6-тер (3)):
 * замаскированный сегмент — в percent-кодировке (`:` — как есть), чтобы путь
 * оставался ASCII-путём; маскирование идемпотентно (`/u/:email` → тот же).
 * Пикер редактора маскирует путь тем же правилом
 * (`widget/src/shared/editor-protocol.ts`, `maskHrefPath`).
 */
export function maskPagePath(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      const m = maskPathSegment(seg);
      return m === seg ? seg : encodeURIComponent(m).replace(/%3A/gi, ':');
    })
    .join('/');
}

/** Адрес страницы (`origin` + путь) с масками ПД в пути; не адрес — как есть. */
export function maskPageUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  return `${u.origin}${u.pathname.split('/').map(maskPathSegment).join('/')}`;
}

/** Подпись: строка ≤ max, без управляющих и `<>`, маскированная; иначе null. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = maskLabel(
    raw
      .normalize('NFKC')
      .replace(CONTROL, '')
      .replace(/[<>`]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** `data-assist-id`: латиница, цифры и `-_.:`, ≤ 64. */
export const ASSIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const SNAP_REF_RE = /^e([1-9]\d{0,2})$/;

/**
 * Поля, которые не попадают в снимок никогда (§5-бис.5): пароль, карта,
 * одноразовый код, файл. Загрузчик их уже выкинул — проверка повторная.
 */
const SENSITIVE_INPUT = new Set(['password', 'file', 'hidden']);

/** Адрес ссылки: http(s), без query и фрагмента, ≤ 300; иначе null. */
export function cleanHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > SNAPSHOT_LIMITS.url) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const out = `${u.origin}${u.pathname}`;
  return out.length <= SNAPSHOT_LIMITS.href ? out : null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Один элемент; мусор и чувствительное — null. */
export function cleanElement(raw: unknown): UiSnapElement | null {
  if (!isObj(raw)) return null;
  const ref = raw.ref;
  if (typeof ref !== 'string' || !SNAP_REF_RE.test(ref)) return null;
  if (
    typeof raw.role !== 'string' ||
    !(UI_ROLES as readonly string[]).includes(raw.role)
  )
    return null;
  const tag = ['a', 'button', 'input', 'select', 'textarea'].includes(
    raw.tag as string,
  )
    ? (raw.tag as UiSnapElement['tag'])
    : 'other';
  const inputType =
    typeof raw.inputType === 'string' && /^[a-z-]{1,20}$/.test(raw.inputType)
      ? raw.inputType
      : null;
  if (inputType && SENSITIVE_INPUT.has(inputType)) return null;
  // autocomplete пароля/карты/кода загрузчик помечает `sensitive` — вон.
  if (raw.sensitive === true) return null;
  const text = cleanText(raw.text, SNAPSHOT_LIMITS.text) ?? '';
  const hidden = cleanText(raw.hiddenLabel, SNAPSHOT_LIMITS.text);
  const assistId =
    typeof raw.assistId === 'string' && ASSIST_ID_RE.test(raw.assistId)
      ? raw.assistId
      : null;
  // Без видимого текста, имени и разметки модели нечего назвать.
  if (!text && !hidden && !assistId) return null;
  const options = Array.isArray(raw.options)
    ? raw.options
        .slice(0, SNAPSHOT_LIMITS.options)
        .map((o) => cleanText(o, SNAPSHOT_LIMITS.text))
        .filter((o): o is string => !!o)
    : [];
  const gesture =
    typeof raw.gesture === 'string' &&
    (UI_GESTURES as readonly string[]).includes(raw.gesture)
      ? (raw.gesture as UiGesture)
      : null;
  return {
    ref,
    role: raw.role as UiRole,
    tag,
    text,
    hiddenLabel: hidden && hidden !== text ? hidden : null,
    assistId,
    inputType,
    href: tag === 'a' || raw.role === 'link' ? cleanHref(raw.href) : null,
    disabled: raw.disabled === true,
    checked: typeof raw.checked === 'boolean' ? raw.checked : null,
    selected: cleanText(raw.selected, SNAPSHOT_LIMITS.text),
    options,
    heading: cleanText(raw.heading, SNAPSHOT_LIMITS.text),
    submit: raw.submit === true,
    inForm: raw.inForm === true,
    confirmZone: raw.confirmZone === true,
    pd: raw.pd === true,
    toggle: raw.toggle === true,
    gesture,
    inView: raw.inView === true,
  };
}

/**
 * Снимок больше `SNAPSHOT_LIMITS.bodyChars` (JSON) — отказ ДО разбора и
 * любой работы (тело маршрута целиком режет ещё раньше потолок
 * `VOICE_CONTROL_DEFAULTS.maxBodyBytes` в app.setup.ts).
 */
export function snapshotTooLarge(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return true;
  }
  return (json?.length ?? 0) > SNAPSHOT_LIMITS.bodyChars;
}

/** Снимок целиком: адрес страницы, заголовок, ≤ 150 элементов, ref без дублей. */
export function parseSnapshot(raw: unknown): UiSnapshot | null {
  if (!isObj(raw)) return null;
  const href = cleanHref(raw.url);
  if (!href || !Array.isArray(raw.elements)) return null;
  // Путь страницы с ПД (`/account/ivan@…`) — маской: адрес идёт в промпт,
  // план и журнал (ссылки элементов — нет: по ним исполнитель сверяет цель).
  const url = maskPageUrl(href);
  const elements: UiSnapElement[] = [];
  const seen = new Set<string>();
  for (const e of raw.elements.slice(0, SNAPSHOT_LIMITS.elements)) {
    const el = cleanElement(e);
    if (!el || seen.has(el.ref)) continue;
    seen.add(el.ref);
    elements.push(el);
  }
  return {
    url,
    title: cleanText(raw.title, SNAPSHOT_LIMITS.title) ?? '',
    elements,
  };
}
