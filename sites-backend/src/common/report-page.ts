/**
 * Общий каркас публичных страниц-отчётов для разработчика сайта (заход 9
 * хвост, Р-З10-11): отчёт мастера голосового управления
 * (`assist-site-voice-control/share/dev-report*`, `/w/v1/vc-report/:token`)
 * и отчёт голосовой карты (`assist-site-voice-map/dev-report*`,
 * `/assist/sites/:id/voice-map/site/dev-report/:token`). ЧИСТЫЙ модуль.
 *
 * Здесь — то, что у двух страниц обязано совпадать (раньше — две копии):
 * экранирование HTML, CSP без скриптов и встраивания, заголовки
 * «не кэшировать, не индексировать, без Referer», один ответ 404 на все
 * отказы (не оракул) и фильтр «HEAD и боты превью ссылок — не просмотр».
 * Семантика отчётов прежняя (Р-З9-9 — одноразовый токен с кнопкой POST;
 * Р-З9-34 — многоразовая ссылка карты со счётчиком просмотров): тексты,
 * стили и разметка остаются в модулях.
 */

/** Экранирование для текста и атрибутов HTML (`null`/`undefined` — пусто). */
export function escHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * CSP страницы отчёта: ни скриптов, ни ресурсов, ни встраивания; стили —
 * только встроенные. `form-action` — `'self'`, если на странице есть
 * кнопка POST (одноразовый отчёт мастера), иначе `'none'`.
 */
export function reportPageCsp(formAction: "'self'" | "'none'"): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action ${formAction}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Заголовки любого ответа страницы отчёта (и HTML, и JSON, и 404). */
export const REPORT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

interface HtmlSink extends HeaderSink {
  status(code: number): unknown;
  end(body: string): unknown;
}

export function setReportPageHeaders(res: HeaderSink, csp: string): void {
  for (const [k, v] of Object.entries(REPORT_PAGE_HEADERS)) {
    res.setHeader(k, v);
  }
  res.setHeader('Content-Security-Policy', csp);
}

/** HTML-ответ страницы отчёта: статус, тип, тело (заголовки — выше). */
export function sendReportHtml(
  res: HtmlSink,
  status: number,
  html: string,
): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

/** Боты превью ссылок в мессенджерах и поисковики — не «просмотр». */
export const PREVIEW_BOT_RE =
  /TelegramBot|Slackbot|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|WhatsApp|Discordbot|SkypeUriPreview|vkShare|Viber|redditbot|Googlebot|bingbot|Applebot|Embedly|Iframely|Pinterest|YandexBot|Google-InspectionTool/i;

/**
 * Считается ли запрос просмотром отчёта: только GET (HEAD — нет) и не бот
 * превью. Без запроса (вызов из кода) — просмотр.
 */
export function isReportView(req?: {
  method?: string;
  headers?: Record<string, unknown>;
}): boolean {
  return (
    (req?.method ?? 'GET') === 'GET' &&
    !PREVIEW_BOT_RE.test(String(req?.headers?.['user-agent'] ?? ''))
  );
}

/** Оболочка страницы: язык, заголовок, встроенные стили, тело. */
export function reportPageHtml(p: {
  lang: string;
  title: string;
  style: string;
  body: string;
  /** `<meta name="referrer" content="no-referrer">` (страница с формой). */
  referrerMeta?: boolean;
}): string {
  return [
    '<!doctype html>',
    `<html lang="${p.lang}">`,
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    ...(p.referrerMeta ? ['<meta name="referrer" content="no-referrer">'] : []),
    `<title>${escHtml(p.title)}</title>`,
    `<style>${p.style}</style></head>`,
    `<body>${p.body}</body></html>`,
    '',
  ].join('\n');
}
