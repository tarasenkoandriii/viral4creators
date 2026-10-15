/**
 * AI Publisher (P-G1) — чистые функции показа (проверяются
 * `scripts/publisher-view.test.ts` без React):
 *  - тон статуса: зелёный ТОЛЬКО для явно положительных значений; всё
 *    неизвестное/ожидающее — нейтральный или жёлтый (ТЗ §8.4: «никакого
 *    зелёного при неизвестном»);
 *  - гейт: зелёный только при `open && missing.length === 0`;
 *  - `Computable`: «не рассчитывается: причина» с исходными числами,
 *    `lowerBound` → «не менее …», `preliminary` → «предварительно»
 *    (AT-CORE-18);
 *  - деньги: `null` → «неизвестно», не 0.
 */

import type { Locale } from '../../kit/i18n';
import type { PublisherDict } from '../../i18n/publisher-ru';
import type { Completeness, Computable } from './decode';
import type { GateResult } from './core-api';
import { BRIEF_FORMATS, type BriefFormat } from './states';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** Явно положительные статусы — единственные зелёные. */
export const POSITIVE_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'verified',
  'connected',
  'published',
  'done',
  'pass',
  'supported',
  'ok',
  'active',
  'allowed',
  'ready',
  'confirmed',
  'selected',
  'resolved',
  'passed',
  'priced',
  'yes',
]);

/** Отрицательные/блокирующие — красные. */
export const NEGATIVE_STATUSES: ReadonlySet<string> = new Set([
  'rejected',
  'revoked',
  'failed',
  'fail',
  'unsupported',
  'blocked',
  'mismatch',
  'unreachable',
  'disconnected',
  'withdrawn',
  'expired',
  'schema_invalid',
  'refused',
  'budget_blocked',
  'unpriced_blocked',
  'not_evaluated',
  'disabled',
  'correction_required',
  'needs_human',
  'needs_resolution',
  'no',
]);

/** Требует внимания (жёлтый): ждёт, неизвестно, частично. */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set([
  'unknown',
  'pending',
  'running',
  'degraded',
  'needs_review',
  'unverified',
  'changes_requested',
  'submitted',
  'editorial_review',
  'restricted',
  'assumption',
  'not_checked',
  'stale',
  'partial',
  'open',
  'timeout',
  'unavailable',
  'unpriced',
  'not_run',
]);

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return 'warning';
  if (POSITIVE_STATUSES.has(status)) return 'success';
  if (NEGATIVE_STATUSES.has(status)) return 'danger';
  if (ATTENTION_STATUSES.has(status)) return 'warning';
  return 'neutral';
}

/** Гейт: зелёный только без пунктов; неизвестное (нет данных) — жёлтый. */
export function gateTone(
  g: Pick<GateResult, 'open' | 'missing'> | null | undefined
): Tone {
  if (!g) return 'warning';
  if (g.open && g.missing.length === 0) return 'success';
  return 'danger';
}

/** Краткий гейт продукта (`ProductView.gates`): то же правило. */
export function gateBriefTone(
  g: { open: boolean; missingCount: number } | null | undefined
): Tone {
  if (!g) return 'warning';
  return g.open && g.missingCount === 0 ? 'success' : 'danger';
}

export function completenessTone(c: Completeness | null | undefined): Tone {
  if (!c) return 'warning';
  return c.state === 'complete' && c.missing.length === 0
    ? 'neutral'
    : 'warning';
}

export function fmtText(
  tpl: string,
  vars: Record<string, string | number>
): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m
  );
}

const TAGS: Record<Locale, string> = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' };

export function fmtNumber(v: number, locale: Locale): string {
  return new Intl.NumberFormat(TAGS[locale], {
    maximumFractionDigits: 2,
  }).format(v);
}

/** Сумма из минимальных единиц (строка цифр) без потери точности. */
export function fmtMinor(
  minor: string | null | undefined,
  currency: string | null | undefined,
  locale: Locale,
  unknown: string
): string {
  if (minor === null || minor === undefined || !/^-?\d+$/.test(minor)) {
    return unknown;
  }
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  const cents = digits.slice(-2);
  const sep = locale === 'en' ? ',' : ' ';
  const dec = locale === 'en' ? '.' : ',';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${neg ? '−' : ''}${grouped}${dec}${cents}${currency ? ` ${currency}` : ''}`;
}

/** Микродоллары строкой → «$0.0123»; `null` — «неизвестно» (не ноль). */
export function fmtMicroUsd(
  micro: string | null | undefined,
  unknown: string
): string {
  if (micro === null || micro === undefined || !/^\d+$/.test(micro)) {
    return unknown;
  }
  const n = Number(micro) / 1_000_000;
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export function fmtDateTime(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat(TAGS[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(t));
}

export function fmtTime(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat(TAGS[locale], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(t));
}

export function fmtDate(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat(TAGS[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(t));
}

/**
 * Текст `Computable` (AT-CORE-18): неизвестное не превращается в ноль.
 * `format` печатает значение (число, деньги, доля).
 */
export function computableText<T>(
  c: Computable<T> | null | undefined,
  format: (v: T) => string,
  t: PublisherDict['computable'],
  unknown: string
): { text: string; tone: Tone; note: string | null } {
  if (!c) return { text: unknown, tone: 'warning', note: null };
  if (c.kind === 'not_computable') {
    const inputs = Object.entries(c.inputs)
      .map(([k, v]) => `${k}=${v === null ? unknown : String(v)}`)
      .join(', ');
    return {
      text: `${t.notComputable}: ${t.reasons[c.reason]}`,
      tone: 'warning',
      note: inputs ? fmtText(t.inputs, { list: inputs }) : null,
    };
  }
  const v = format(c.value);
  const parts: string[] = [];
  if (c.preliminary) parts.push(t.preliminary);
  if (c.unknownParts && c.unknownParts.length) {
    parts.push(
      fmtText(t.unknownParts, {
        list: c.unknownParts.map((x) => unknownPartLabel(x, t)).join(', '),
      })
    );
  }
  return {
    text: c.lowerBound ? fmtText(t.lowerBound, { v }) : v,
    tone: c.preliminary || c.lowerBound || parts.length ? 'warning' : 'neutral',
    note: parts.length ? parts.join(' · ') : null,
  };
}

/** Подпись статуса из словаря; незнакомый — как есть (не «пусто»). */
export function statusLabel(
  status: string | null | undefined,
  ...maps: Array<Record<string, string> | undefined>
): string {
  if (!status) return '—';
  for (const m of maps) {
    if (m && Object.prototype.hasOwnProperty.call(m, status)) return m[status];
  }
  return status;
}

/**
 * `member:abc` → «abc»-хвост для показа; `admin:<id>` (оператор Админки
 * платформы, P-R-ADM) — словами и хвостом id; системные актёры — как есть.
 */
export function actorLabel(
  actor: string | null | undefined,
  adminLabel = 'admin'
): string {
  if (!actor) return '—';
  const m = /^member:(.+)$/.exec(actor);
  if (m) return `…${m[1].slice(-6)}`;
  const a = /^admin:(.+)$/.exec(actor);
  return a ? `${adminLabel} …${a[1].slice(-6)}` : actor;
}

/** Раздел экрана для объекта задачи проверки (ссылка на связанную запись). */
export function objectSection(objectType: string): string | null {
  switch (objectType) {
    case 'content':
    case 'content_version':
      return 'materials';
    case 'source':
      return 'sources';
    case 'claim':
      return 'materials';
    case 'brand_fact':
    case 'offer_version':
      return 'brand';
    case 'brief':
      return 'briefs';
    case 'question':
    case 'question_group':
      return 'questions';
    case 'distribution_action':
      return 'calendar';
    case 'lead':
      return 'leads';
    case 'publication':
      return 'calendar';
    case 'placement':
      return 'purchases';
    case 'venue':
      return 'venues';
    case 'report':
      return 'reports';
    case 'reddit_project':
    case 'reddit_community':
    case 'reddit_rule_snapshot':
    case 'reddit_keyword':
    case 'reddit_opportunity':
    case 'reddit_brief':
      return 'reddit';
    default:
      return null;
  }
}

/** Баланс плана тем: по 2 брифа каждого формата (F03, §14.1 «plan»). */
export function planBalance(
  briefs: ReadonlyArray<{ format: BriefFormat; status: string }>
): { counts: Record<BriefFormat, number>; balanced: boolean } {
  const live = briefs.filter((b) => b.status !== 'rejected');
  const counts = Object.fromEntries(
    BRIEF_FORMATS.map((f) => [f, live.filter((b) => b.format === f).length])
  ) as Record<BriefFormat, number>;
  return { counts, balanced: BRIEF_FORMATS.every((f) => counts[f] === 2) };
}

/**
 * Состояние проверок версии для согласования — как `approvalBlockers` P-B1:
 * по каждому нужному виду берётся ПОСЛЕДНЯЯ проверка (по `checkedAt`);
 * нет её или итог не `pass` — «не хватает», `pass` с блокерами — блокер.
 * Нужны редакционная и техническая, у не-статьи — ещё «смысл адаптации».
 */
export function qaState(
  checks: ReadonlyArray<{
    kind: string;
    result: string;
    checkedAt: string;
    blockers: readonly unknown[];
  }>,
  adaptation: boolean
): {
  missing: Array<'editorial' | 'technical' | 'adaptation_meaning'>;
  blockers: number;
} {
  const need = adaptation
    ? (['editorial', 'technical', 'adaptation_meaning'] as const)
    : (['editorial', 'technical'] as const);
  const sorted = [...checks].sort(
    (a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt)
  );
  const missing: Array<'editorial' | 'technical' | 'adaptation_meaning'> = [];
  let blockers = 0;
  for (const k of need) {
    const last = sorted.find((c) => c.kind === k);
    if (!last || last.result !== 'pass') missing.push(k);
    else blockers += last.blockers.length;
  }
  return { missing, blockers };
}

/**
 * Тон закупки по её машине (§7.2): зелёный — только `verified_complete`
 * (размещение проверено); `published` — поставщик опубликовал, проверки
 * ещё нет → «внимание», не зелёный (ТЗ §8.4).
 */
export function placementTone(status: string): Tone {
  if (status === 'verified_complete') return 'success';
  if (status === 'published' || status === 'disputed') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

/**
 * Тон публикации (§7.5): зелёный — только `published` с проверкой
 * `verifyStatus='ok'`; опубликовано без проверки — «внимание».
 */
export function publicationTone(p: {
  status: string;
  verifyStatus: string;
}): Tone {
  if (p.status === 'published') {
    return p.verifyStatus === 'ok' ? 'success' : 'warning';
  }
  if (p.status === 'pending') return 'warning';
  if (p.status === 'failed' || p.status === 'withdrawn') return 'danger';
  return 'neutral';
}

const own = (m: Record<string, string>, k: string) =>
  Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;

/** Часть неизвестного (`unknownParts`) словами; незнакомая — как есть. */
export function unknownPartLabel(
  code: string,
  t: PublisherDict['computable']
): string {
  return own(t.parts, code) ?? code;
}

/**
 * Пункт неполноты (`completeness.missing[]`) словами: `integration:<вид>`,
 * `web_analytics_day:<дата>`, `placement:delivery_unconfirmed`.
 */
export function missingLabel(
  code: string,
  t: PublisherDict['completeness']
): string {
  const i = code.indexOf(':');
  const head = i < 0 ? code : code.slice(0, i);
  const tail = i < 0 ? '' : code.slice(i + 1);
  if (head === 'integration') {
    return fmtText(t.codes.integration, { kind: own(t.kinds, tail) ?? tail });
  }
  if (head === 'web_analytics_day') {
    return fmtText(t.codes.web_analytics_day, { date: tail });
  }
  if (code === 'placement:delivery_unconfirmed') {
    return t.codes.placement_delivery_unconfirmed;
  }
  return code;
}

/** `detail` пункта гейта словами (в т. ч. `pending_or_unknown:<n>`). */
export function gateDetailLabel(
  detail: string,
  t: PublisherDict,
  ...extra: Array<Record<string, string>>
): string {
  const m = /^pending_or_unknown:(\d+)$/.exec(detail);
  if (m) return fmtText(t.gates.details.pending_or_unknown, { n: m[1] });
  for (const map of [t.gates.details, ...extra, t.status]) {
    const v = own(map, detail);
    if (v) return v;
  }
  return detail;
}

/**
 * Варианты фильтра «ответственный» (ТЗ §8.4): любой, я, без
 * ответственного (если список это понимает), участники кабинета и текущее
 * значение из URL, если его нет в списке. Подписи «любой/я/без» даёт экран.
 */
export function ownerOptions(
  current: string,
  me: string,
  members: ReadonlyArray<{ memberId: string; label: string }>,
  withNone = false
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [
    { value: '', label: '' },
    { value: me, label: '' },
  ];
  if (withNone) out.push({ value: 'none', label: '' });
  for (const m of members) {
    if (m.memberId && !out.some((x) => x.value === m.memberId)) {
      out.push({ value: m.memberId, label: m.label });
    }
  }
  if (current && !out.some((x) => x.value === current)) {
    out.push({ value: current, label: current });
  }
  return out;
}

/**
 * Адрес для `href`: только http(s); `javascript:`, `data:` и прочее — `null`
 * (показывается текстом, не ссылкой).
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch {
    return null;
  }
}

/**
 * Пауза между взводом двухшагового подтверждения и подтверждающим
 * нажатием (аудит ui-3): второй щелчок двойного клика приходит раньше.
 */
export const CONFIRM_GUARD_MS = 500;

/**
 * Нажатие `ConfirmButton`: не взведена — взвести; взведена — подтвердить,
 * но только после паузы `CONFIRM_GUARD_MS` и не вторым щелчком серии
 * (`MouseEvent.detail > 1` — двойной/тройной клик). Клавиатура даёт
 * `detail = 0` и проходит по времени.
 */
export function confirmClick(
  armedAt: number | null,
  now: number,
  detail = 0
): 'arm' | 'ignore' | 'confirm' {
  if (armedAt === null) return 'arm';
  if (detail > 1 || now - armedAt < CONFIRM_GUARD_MS) return 'ignore';
  return 'confirm';
}
