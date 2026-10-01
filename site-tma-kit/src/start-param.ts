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
