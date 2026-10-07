/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/start-param.ts */
/**
 * Реестр префиксов `startapp` — общий для TMA Помощника и QA (ТЗ помощника
 * §4.16, §3.2): одно место, чтобы префиксы двух приложений не столкнулись.
 * В Э0 экран читает только `inv_` (приглашение); остальные разбираются,
 * чтобы следующие этапы не изобретали формат заново.
 */

export const START_PREFIXES = {
  inv: 'inv_', // приглашение участника (одноразовое, 7 дней)
  lp: 'lp_', // кампания лендинга → онбординг
  wd: 'wd_', // черновик вида виджета с лендинга
  pl: 'pl_', // выбранный тариф
  sb: 'sb_', // перенос песочницы лендинга
  st: 'st_', // экран «Статистика» сайта
  // Ш1-хвост: «подтвердить ЭТОТ хост» из обучалки генератора —
  // `vh-<base64url(хост)>` (контракт с backend `SITES_VERIFY_URL`).
  vh: 'vh-',
} as const;

export type StartKind = keyof typeof START_PREFIXES;
export type StartParam = { kind: StartKind; value: string } | null;

/** Значение — только безопасные символы `startapp` (A–Z a–z 0–9 _ -), ≤ 64. */
const VALUE_RE = /^[A-Za-z0-9_-]{1,60}$/;

export function parseStartParam(raw: string | null | undefined): StartParam {
  if (!raw || raw.length > 64) return null;
  for (const kind of Object.keys(START_PREFIXES) as StartKind[]) {
    const prefix = START_PREFIXES[kind];
    if (raw.startsWith(prefix)) {
      const value = raw.slice(prefix.length);
      return VALUE_RE.test(value) ? { kind, value } : null;
    }
  }
  return null;
}

/**
 * Хост из `vh-<base64url(хост)>` — строго: base64url без `=` в КАНОНИЧЕСКОЙ
 * записи (повторное кодирование совпадает), ASCII, и это уже нормальная
 * форма хоста (нижний регистр, punycode, без схемы/порта/пути/точки в
 * конце, не IP, не одна метка) — то же, что `parseHostInput` отдал бы для
 * него самого. Иначе `null`: экран ничего не предзаполняет. Подтверждение
 * хоста всё равно — только кнопкой человека и проверкой сервера.
 */
export function verifyHostFromStartParam(
  raw: string | null | undefined
): string | null {
  const p = parseStartParam(raw);
  if (p?.kind !== 'vh') return null;
  const host = decodeBase64Url(p.value);
  if (host === null || encodeBase64Url(host) !== p.value) return null;
  return isCanonicalHost(host) ? host : null;
}

/** `vh-<base64url(хост)>` — для тестов и сверки с генератором. */
export function verifyHostStartParam(host: string): string | null {
  if (!isCanonicalHost(host)) return null;
  const raw = `${START_PREFIXES.vh}${encodeBase64Url(host)}`;
  return parseStartParam(raw)?.kind === 'vh' ? raw : null;
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Хост в нормальной форме (см. `verifyHostFromStartParam`). */
export function isCanonicalHost(host: string): boolean {
  if (host.length < 3 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) {
    return false;
  }
  // Последняя метка — не число: IPv4 и IP-подобные записи — не хост.
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeBase64Url(ascii: string): string {
  let out = '';
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : -1;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : -1;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
    if (b >= 0) out += B64[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
    if (c >= 0) out += B64[c & 63];
  }
  return out;
}

/** base64url → ASCII (печатные 0x21–0x7e) или `null`. */
function decodeBase64Url(v: string): string | null {
  if (v.length % 4 === 1) return null;
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const ch of v) {
    const n = B64.indexOf(ch);
    if (n < 0) return null;
    acc = ((acc << 6) | n) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const code = (acc >> bits) & 0xff;
      if (code < 0x21 || code > 0x7e) return null;
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** Параметр веб-ссылки приглашения: `https://<кабинет>/?invite=inv_…`. */
export const WEB_INVITE_PARAM = 'invite';

/**
 * Токен приглашения из запуска: `start_param` в Telegram
 * (`t.me/<бот>?startapp=inv_<токен>`) или `?invite=` в веб-кабинете.
 * В вебе принимаем и `inv_<токен>`, и голый токен — ссылку могли
 * переслать как угодно. `start_param` важнее: в TMA query-строки нет.
 * Возвращает токен без префикса или `null`.
 */
export function inviteTokenFromLaunch(
  startParam: string | null | undefined,
  search: string | null | undefined
): string | null {
  const fromStart = parseStartParam(startParam);
  if (fromStart?.kind === 'inv') return fromStart.value;
  if (!search) return null;
  const raw = new URLSearchParams(search).get(WEB_INVITE_PARAM);
  if (!raw) return null;
  const withPrefix = raw.startsWith(START_PREFIXES.inv)
    ? raw
    : `${START_PREFIXES.inv}${raw}`;
  const p = parseStartParam(withPrefix);
  return p?.kind === 'inv' ? p.value : null;
}

/** Адрес без `?invite=` — после попытки принять ссылку не повторяется. */
export function stripInviteParam(href: string): string {
  const u = new URL(href);
  u.searchParams.delete(WEB_INVITE_PARAM);
  return u.pathname + u.search + u.hash;
}
