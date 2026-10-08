/**
 * «Отчёт для разработчика» мастера Т-2 по одноразовой ссылке (заход 9,
 * Р-З9-9; ТЗ §5-бис.13 п.7: «ссылка на отчёт — для передачи разработчику»)
 * — ЧИСТЫЙ модуль: что из отчёта мастера уходит по ссылке и как это
 * выглядит.
 *
 * Только то, что нужно разработчику сайта, и без ПД: итог и коды пунктов с
 * числами, страница и хост, факты разметки (теги, CSS-селекторы), список 1
 * (маскированные подписи + коды причин), список 2 с решениями владельца,
 * селекторы «запретить», обратные цели компенсаций, готовый фрагмент
 * разметки. НЕ уходят: команды сухого прогона и прогона с нажатием (текст
 * посетителя/владельца), «запреты без звука» (подписи целей), окружение
 * браузера, id планов; id исходного отчёта (`src`) хранится только для
 * замены прежней ссылки и на страницу не выводится.
 *
 * HTML — статический, без скриптов; всё из отчёта — через `esc`. Страница
 * ссылки (GET) показывает только кнопку «Відкрити звіт»: превью ссылок в
 * мессенджерах (GET без формы) одноразовый токен не тратят; отчёт — ответ
 * на POST этой формы (токен гасится тем же условным UPDATE).
 */
import { maskLabel } from '../../assist-ui-core/snapshot';
import type { WizardReport } from '../api-types';

/** Путь публичной страницы ссылки на origin виджета (rewrite `/w/v1/*`). */
export const DEV_REPORT_PATH = '/w/v1/vc-report';

export const DEV_REPORT_LIMITS = {
  /**
   * Срок ссылки — 72 ч (а не 30 мин ссылки мастера): владелец пересылает её
   * разработчику, который откроет не сразу; ссылка одноразовая (первое
   * открытие гасит её), содержимое — без ПД.
   */
  ttlMs: 72 * 60 * 60_000,
  /** Пунктов каждого списка в отчёте по ссылке. */
  listItems: 50,
} as const;

/** Строка теста-ссылки: `kind`, origin-заглушка (обмен мастера невозможен). */
export const DEV_REPORT_KIND = 'dev_report';
export const DEV_REPORT_ORIGIN = 'dev-report:none';

export interface DevReport {
  v: 1;
  /** id исходного отчёта мастера — только для замены прежней ссылки. */
  src: string;
  lang: 'uk' | 'ru' | 'en';
  host: string;
  page: string;
  reportedAt: string | null;
  result: string;
  items: Array<{
    step: number;
    level: string;
    code: string;
    data: Record<string, number | string>;
  }>;
  markup: {
    total: number;
    withId: number;
    unnamed: Array<{ tag: string; selector: string }>;
    closedShadow: number;
    extIframes: number;
    duplicates: Array<{ name: string; count: number }>;
  };
  never: Array<{ text: string; reason: string }>;
  suspicious: Array<{
    why: string;
    tag: string;
    label: string;
    selector: string;
    decision: 'deny' | 'safe' | null;
  }>;
  denySuggestions: string[];
  undo: Array<{ text: string; reverse: string; problem: string }>;
  fragment: string;
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : '';
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Срез отчёта мастера для ссылки (строго: отчёт — JSON из базы). */
export function devReportOf(
  r: WizardReport,
  meta: { src: string; reportedAt: Date | null },
): DevReport {
  const N = DEV_REPORT_LIMITS.listItems;
  const arr = <T>(v: unknown): T[] =>
    (Array.isArray(v) ? v : []).slice(0, N) as T[];
  return {
    v: 1,
    src: meta.src,
    lang: r.lang === 'ru' || r.lang === 'en' ? r.lang : 'uk',
    host: str(r.host, 200),
    page: str(r.page, 300),
    reportedAt: meta.reportedAt?.toISOString() ?? null,
    result: str(r.result, 10),
    items: arr<WizardReport['items'][number]>(r.items).map((i) => {
      const data: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(i.data ?? {}))
        if (/^[a-z]{1,10}$/i.test(k))
          data[k] = typeof v === 'number' ? v : str(v, 40);
      return {
        step: num(i.step),
        level: str(i.level, 10),
        code: str(i.code, 40),
        data,
      };
    }),
    markup: {
      total: num(r.markup?.total),
      withId: num(r.markup?.withId),
      unnamed: arr<{ tag: string; selector: string }>(r.markup?.unnamed).map(
        (u) => ({ tag: str(u.tag, 30), selector: str(u.selector, 200) }),
      ),
      closedShadow: num(r.markup?.closedShadow),
      extIframes: num(r.markup?.extIframes),
      duplicates: arr<{ name: string; count: number }>(
        r.markup?.duplicates,
      ).map((d) => ({ name: str(d.name, 80), count: num(d.count) })),
    },
    never: arr<{ text: string; reason: string }>(r.never).map((n) => ({
      text: str(n.text, 120),
      reason: str(n.reason, 30),
    })),
    suspicious: arr<WizardReport['suspicious'][number]>(r.suspicious).map(
      (s) => {
        const d = r.reviewed?.[s.key];
        return {
          why: str(s.why, 30),
          tag: str(s.tag, 30),
          label: str(s.label, 120),
          selector: str(s.selector, 200),
          decision: d === 'deny' || d === 'safe' ? d : null,
        };
      },
    ),
    denySuggestions: arr<string>(r.denySuggestions).map((x) => str(x, 200)),
    undo: arr<{ text: string; reverse: string; problem: string }>(
      r.undo?.unresolved,
    ).map((u) => ({
      // Текст цели со страницы — маской (телефон/e-mail в подписи кнопки).
      text: maskLabel(str(u.text, 120)),
      reverse: str(u.reverse, 64),
      problem: str(u.problem, 20),
    })),
    fragment: str(r.fragment, 20_000),
  };
}

const T = {
  uk: {
    title: 'Звіт перевірки голосового керування — для розробника',
    open: 'Відкрити звіт',
    once: 'Посилання одноразове: звіт відкриється один раз. Збережіть сторінку, якщо потрібно.',
    gone: 'Посилання недійсне, прострочене або вже відкрите. Попросіть власника сайту надіслати нове.',
    result: 'Підсумок',
    items: 'Пункти перевірки (коди)',
    unnamed: 'Кнопки без доступного імені',
    duplicates: 'Однакові підписи',
    never: 'Помічник не натисне ніколи (список 1)',
    suspicious: 'Схоже на небезпечне (список 2) і рішення власника',
    deny: 'Додати в «Заборонені елементи» або data-assist="never"',
    undo: 'Обернені цілі компенсацій, які не знайдено',
    fragment: 'Готовий фрагмент розмітки',
    page: 'Сторінка',
  },
  ru: {
    title: 'Отчёт проверки голосового управления — для разработчика',
    open: 'Открыть отчёт',
    once: 'Ссылка одноразовая: отчёт откроется один раз. Сохраните страницу, если нужно.',
    gone: 'Ссылка недействительна, просрочена или уже открыта. Попросите владельца сайта прислать новую.',
    result: 'Итог',
    items: 'Пункты проверки (коды)',
    unnamed: 'Кнопки без доступного имени',
    duplicates: 'Одинаковые подписи',
    never: 'Помощник не нажмёт никогда (список 1)',
    suspicious: 'Похоже на опасное (список 2) и решения владельца',
    deny: 'Добавить в «Запрещённые элементы» или data-assist="never"',
    undo: 'Обратные цели компенсаций, которые не найдены',
    fragment: 'Готовый фрагмент разметки',
    page: 'Страница',
  },
  en: {
    title: 'Voice control check report — for the developer',
    open: 'Open the report',
    once: 'This link works once: the report opens a single time. Save the page if needed.',
    gone: 'The link is invalid, expired or already opened. Ask the site owner for a new one.',
    result: 'Result',
    items: 'Check items (codes)',
    unnamed: 'Buttons without an accessible name',
    duplicates: 'Duplicate labels',
    never: 'The assistant will never click (list 1)',
    suspicious: 'Looks dangerous (list 2) and the owner’s decisions',
    deny: 'Add to “Forbidden elements” or data-assist="never"',
    undo: 'Compensation reverse targets not found',
    fragment: 'Ready-made markup fragment',
    page: 'Page',
  },
} as const;

export type DevLang = keyof typeof T;

/** Экранирование для текста и атрибутов HTML. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:860px;padding:16px;color:#111;background:#fff}' +
  'h1{font-size:20px}h2{font-size:16px;margin-top:24px}table{border-collapse:collapse;width:100%}' +
  'td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top;font-size:13px}' +
  'code,pre{font:12px/1.4 ui-monospace,monospace;background:#f5f5f5}pre{padding:8px;overflow:auto;white-space:pre-wrap}' +
  'button{font:inherit;padding:8px 16px}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}code,pre{background:#222}td,th{border-color:#444}}';

/** CSP страницы ссылки: без скриптов; форма — только на себя. */
export const DEV_REPORT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function page(lang: DevLang, body: string): string {
  return [
    '<!doctype html>',
    `<html lang="${lang}">`,
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(T[lang].title)}</title>`,
    `<style>${STYLE}</style></head>`,
    `<body>${body}</body></html>`,
    '',
  ].join('\n');
}

const langOf = (v: unknown): DevLang => (v === 'ru' || v === 'en' ? v : 'uk');

/** GET: только кнопка (токен не тратится — превью мессенджеров безопасны). */
export function devReportLanding(token: string, lang?: unknown): string {
  const l = langOf(lang);
  return page(
    l,
    `<h1>${esc(T[l].title)}</h1><p>${esc(T[l].once)}</p>` +
      `<form method="post" action="${esc(`${DEV_REPORT_PATH}/${encodeURIComponent(token)}`)}">` +
      `<button type="submit">${esc(T[l].open)}</button></form>`,
  );
}

/** Ссылка недействительна/истекла/открыта — один ответ на все случаи. */
export function devReportGone(lang?: unknown): string {
  const l = langOf(lang);
  return page(l, `<h1>${esc(T[l].title)}</h1><p>${esc(T[l].gone)}</p>`);
}

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return '<p>—</p>';
  return (
    `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` +
    rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('') +
    '</table>'
  );
}

/** POST: сам отчёт (одноразово). */
export function devReportHtml(r: DevReport): string {
  const l = langOf(r.lang);
  const t = T[l];
  const code = (v: unknown) => `<code>${esc(v)}</code>`;
  const parts: string[] = [
    `<h1>${esc(t.title)}</h1>`,
    `<p>${esc(t.page)}: ${code(`${r.host}${r.page}`)} · ${esc(r.reportedAt ?? '')}</p>`,
    `<p>${esc(t.result)}: <b>${esc(r.result)}</b></p>`,
    `<h2>${esc(t.items)}</h2>`,
    table(
      ['#', 'level', 'code', 'data'],
      r.items.map((i) => [
        esc(i.step),
        esc(i.level),
        code(i.code),
        esc(
          Object.entries(i.data)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
        ),
      ]),
    ),
    `<h2>${esc(t.unnamed)}</h2>`,
    table(
      ['tag', 'selector'],
      r.markup.unnamed.map((u) => [code(u.tag), code(u.selector)]),
    ),
    `<h2>${esc(t.duplicates)}</h2>`,
    table(
      ['label', 'n'],
      r.markup.duplicates.map((d) => [esc(d.name), esc(d.count)]),
    ),
    `<h2>${esc(t.never)}</h2>`,
    table(
      ['text', 'reason'],
      r.never.map((n) => [esc(n.text), code(n.reason)]),
    ),
    `<h2>${esc(t.suspicious)}</h2>`,
    table(
      ['why', 'tag', 'label', 'selector', 'owner'],
      r.suspicious.map((s) => [
        code(s.why),
        code(s.tag),
        esc(s.label),
        code(s.selector),
        esc(s.decision ?? '—'),
      ]),
    ),
    `<h2>${esc(t.deny)}</h2>`,
    r.denySuggestions.length
      ? `<pre>${esc(r.denySuggestions.join('\n'))}</pre>`
      : '<p>—</p>',
    `<h2>${esc(t.undo)}</h2>`,
    table(
      ['text', 'data-assist-id', 'problem'],
      r.undo.map((u) => [esc(u.text), code(u.reverse), code(u.problem)]),
    ),
    `<h2>${esc(t.fragment)}</h2>`,
    `<pre>${esc(r.fragment)}</pre>`,
  ];
  return page(l, parts.join('\n'));
}
