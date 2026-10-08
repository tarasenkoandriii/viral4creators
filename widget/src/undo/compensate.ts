/**
 * Компенсация объявленной пары (Э6-тер (и), ТЗ §5-бис.15 п.6, п.8, п.13
 * п.2–4, 7) — ленивый чанк `comp.js`: его берёт `undo.js` по команде своего
 * iframe `ui-undo` с полем `comp` (рядом, тот же выпуск). act.js (9 КБ) и
 * загрузчик не растут; undo.js — на одну строку.
 *
 * ЧТО нажать решил сервер (пара — только объявленная: стандартная разметка
 * `remove-from-*` или «Как отменить» карты; по тексту — никогда) и уже
 * записал `dispatched` (один раз, ДО действия). Здесь — только:
 *  - `go` — переход на страницу отмены (путь того же origin; флаг «план
 *    идёт», чтобы iframe поднялся на новой странице и продолжил);
 *  - поиск обратной цели ТОЛЬКО по `data-assist-id` — в строке ТОГО ЖЕ
 *    товара: ближайший `li`/`tr`/`[role=row|listitem]`/`[data-assist-row]`
 *    (≤ 8 предков) с ровно одной такой целью, в тексте строки — описание
 *    товара и варианты (по словам). Ни одной — `gone`; две строки с тем же
 *    описанием — `failed` («уберите сами», без угадывания), 0 кликов;
 *  - те же запреты по НАСТОЯЩЕЙ цели, что у исполнителя (`liveRefusal`):
 *    `data-assist="never"`, denylist/зоны кабинета, наши корни и отзывы,
 *    недоступна, жест, чужой origin, страница оплаты, стоп-лист по тексту,
 *    скрытой подписи и разметке. Исключения стоп-листа — только те, что
 *    прислал сервер для ЭТОЙ разметки: «удаление» своей строки (`remove`) и
 *    отписка от бесплатной подписки (`unsubscribe`); оплата — никогда;
 *  - (заход 9) `show` + `sid` — режим `degraded`: только подсветка 6 с
 *    найденной обратной цели, ни клика, ни ответа (без `id` — старый чанк
 *    из кеша такую команду не исполнит);
 *  - подсветка 600 мс, клик синтетическими событиями + нативный `click()`,
 *    проверка: строки с описанием больше нет — `done`; не исчезла за ~4 с —
 *    `unknown` («проверьте корзину», не «вернул»); отказ — подсветка 6 с.
 * Наружу — только итог по номеру шага (`ui-undone`), без текста страницы.
 * Правила загрузчика: ни одного HTML-приёмника, стили — CSSOM.
 */
import type { ActHost } from '../act/index';
import { closestDeep, deepQuery, excluded, visible } from '../act/snapshot';
import { NEVER_PATTERNS, paymentPath } from '../shared/ui-plan';

const PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSIST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Путь того же origin: `/…`, не `//host`. */
const PATH =
  /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@][A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$|^\/$/;
const ROW = /^(LI|TR)$/;

export type CompResult = 'done' | 'failed' | 'unknown' | 'gone';

/** Слова текста (регистр, ё/е, без знаков) — сверка строки по целым словам. */
const words = (s: string) =>
  ' ' +
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ') +
  ' ';

const strs = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x == 'string' && x.length <= len)
        .slice(0, max)
    : [];

/** Строка товара цели: ближайшая «строка» с РОВНО одной такой целью. */
export function rowOf(el: Element, id: string): Element | null {
  let cur = el.parentElement;
  for (let k = 0; cur && k < 8; k++, cur = cur.parentElement) {
    const role = cur.getAttribute('role');
    if (
      ROW.test(cur.tagName) ||
      role == 'row' ||
      role == 'listitem' ||
      cur.hasAttribute('data-assist-row')
    )
      return cur.querySelectorAll(`[data-assist-id="${id}"]`).length == 1
        ? cur
        : null;
  }
  return null;
}

/** Видимый текст цели (кнопка-поле — её value). */
const textOf = (el: Element) =>
  (el as HTMLInputElement).tagName == 'INPUT'
    ? (el as HTMLInputElement).value || ''
    : (el as HTMLElement).innerText || el.textContent || '';

/**
 * Запреты по живой цели (порт `Runner.liveRefusal` без лишних фактов
 * снимка): true — не нажимать. `allow` — исключения стоп-листа, которые
 * сервер дал этой разметке.
 */
export function compRefused(
  el: Element,
  allow: string[],
  deny: string[],
  zones: string[]
): boolean {
  if (closestDeep(el, '[data-assist="never"]') || excluded(el, deny, zones))
    return true;
  const x = el as HTMLButtonElement;
  if (x.disabled || el.getAttribute('aria-disabled') == 'true') return true;
  // Жест: новая вкладка, скачивание, файл, буфер обмена — «нажмите сами».
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  const tg = a ? (a.getAttribute('target') || '_self').toLowerCase() : '';
  const lab = el.closest('label') as HTMLLabelElement | null;
  if (
    (a && (!/^_(self|top|parent)$/.test(tg) || a.hasAttribute('download'))) ||
    el.hasAttribute('data-clipboard-text') ||
    (lab && lab.control && (lab.control as HTMLInputElement).type == 'file')
  )
    return true;
  if (a) {
    const u = new URL(a.getAttribute('href') || '', location.href);
    if (u.origin != location.origin || paymentPath(u.pathname)) return true;
  }
  // Скрытая подпись — как `hiddenLabel` снимка: aria-label, aria-labelledby, title.
  let hidden = el.getAttribute('aria-label') || '';
  const root = el.getRootNode() as Document;
  for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
    const n = id && root.getElementById ? root.getElementById(id) : null;
    if (n) hidden += ' ' + (n.textContent || '');
  }
  const probe = [
    textOf(el),
    hidden,
    el.getAttribute('title') || '',
    (el.getAttribute('data-assist-id') || '').replace(/[-_.:]+/g, ' '),
  ]
    .join(' ')
    .slice(0, 300);
  for (const re of NEVER_PATTERNS)
    if (
      re.test(probe) &&
      !(allow.indexOf('remove') >= 0 && re.test('видалити')) &&
      !(allow.indexOf('unsubscribe') >= 0 && re.test('unsubscribe'))
    )
      return true;
  return false;
}

/** Совпадения обратной цели: элемент и его строка (row null — без строк). */
export function findReverse(
  id: string,
  row: string | null,
  variant: string[],
  live: boolean,
  deny: string[],
  zones: string[]
): Element[] {
  const want = row ? words(row) : '';
  const vs = variant.map(words);
  return deepQuery(document, `[data-assist-id="${id}"]`).filter((e) => {
    if (live && (excluded(e, deny, zones) || !visible(e))) return false;
    if (!row) return true;
    const r = rowOf(e, id);
    const t = r
      ? words((r as HTMLElement).innerText || r.textContent || '')
      : '';
    return !!r && t.indexOf(want) >= 0 && vs.every((v) => t.indexOf(v) >= 0);
  });
}

function ring(host: ActHost, el: Element, ms: number) {
  const N = host.N;
  const d = N.el('div');
  d.setAttribute('data-v4c-highlight', '');
  d.setAttribute('aria-hidden', 'true');
  const r = el.getBoundingClientRect();
  const css = `position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:3px solid #2563eb;border-radius:8px;top:${r.top - 6}px;left:${r.left - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`;
  for (const x of css.split(';')) {
    const i = x.indexOf(':');
    d.style.setProperty(x.slice(0, i), x.slice(i + 1), 'important');
  }
  (document.body || document.documentElement).appendChild(d);
  N.later(() => d.remove(), ms);
}

const sleep = (host: ActHost, ms: number) =>
  new Promise<void>((r) => host.N.later(r, ms));

export async function runComp(
  host: ActHost,
  c: {
    id: string;
    row: string | null;
    variant: string[];
    allow: string[];
    deny: string[];
    zones: string[];
  }
): Promise<CompResult> {
  const list = findReverse(c.id, c.row, c.variant, true, c.deny, c.zones);
  // Ни одной — «уберите сами»; две строки с тем же описанием — без угадывания.
  if (list.length != 1) return list.length ? 'failed' : 'gone';
  const el = list[0];
  try {
    el.scrollIntoView({ block: 'center' });
  } catch {
    /* старый браузер — без прокрутки */
  }
  if (compRefused(el, c.allow, c.deny, c.zones)) {
    ring(host, el, 6000);
    return 'failed';
  }
  ring(host, el, 600);
  await sleep(host, 600);
  // Цель могли подменить за время подсветки — проверка ещё раз.
  if (!el.isConnected || compRefused(el, c.allow, c.deny, c.zones))
    return 'failed';
  const before = textOf(el);
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
    el.dispatchEvent(
      new MouseEvent(t, { bubbles: true, cancelable: true, composed: true })
    );
  const click = host.N.click;
  if (click && el instanceof HTMLElement) click.call(el);
  else (el as HTMLElement).click();
  // Корзины обновляются фрагментами AJAX: проверка каждые 250 мс до ~4 с.
  for (let k = 0; k < 17; k++) {
    await sleep(host, 250);
    const gone = c.row
      ? !findReverse(c.id, c.row, c.variant, false, [], []).length
      : !el.isConnected || textOf(el) != before;
    if (gone) return 'done';
  }
  ring(host, el, 6000);
  return 'unknown';
}

/** Команда iframe `ui-undo` с полем `comp` (разбор строгий). */
export function comp(raw: Record<string, unknown>, host: ActHost): void {
  const c = raw.comp as Record<string, unknown> | null;
  const planId = raw.planId;
  if (typeof planId != 'string' || !PLAN_ID.test(planId) || !c) return;
  if (typeof c.go == 'string') {
    // Переход на страницу отмены — только путь своего origin.
    if (c.go.length <= 200 && PATH.test(c.go)) {
      host.mark(true);
      location.assign(c.go);
    }
    return;
  }
  // Заход 9 (§5-бис.15 п.8, аудит P2-3): `degraded` — только подсветка
  // обратной цели (тот же поиск), без клика и без ответа iframe. Цель — в
  // поле `sid`, НЕ `id`: старый comp.js из кеша CDN такую команду отвергнет
  // (нет `id`) и ничего не нажмёт.
  if (c.show) {
    const sid = c.sid;
    if (
      typeof sid != 'string' ||
      !ASSIST_ID.test(sid) ||
      (c.row !== null && (typeof c.row != 'string' || c.row.length > 80))
    )
      return;
    const one = findReverse(
      sid,
      c.row as string | null,
      strs(c.variant, 2, 40),
      true,
      strs(c.deny, 50, 300),
      strs(c.zones, 50, 300)
    );
    if (one.length == 1) {
      try {
        one[0].scrollIntoView({ block: 'center' });
      } catch {
        /* без прокрутки */
      }
      ring(host, one[0], 6000);
    }
    return;
  }
  const i = c.i;
  if (
    typeof i != 'number' ||
    !Number.isInteger(i) ||
    i < 0 ||
    i > 20 ||
    typeof c.id != 'string' ||
    !ASSIST_ID.test(c.id) ||
    (c.row !== null && (typeof c.row != 'string' || c.row.length > 80))
  )
    return;
  void runComp(host, {
    id: c.id,
    row: c.row as string | null,
    variant: strs(c.variant, 2, 40),
    allow: strs(c.allow, 2, 20),
    deny: strs(c.deny, 50, 300),
    zones: strs(c.zones, 50, 300),
  }).then((result) => {
    // Страница отмены открыта переходом — флаг «план идёт» больше не нужен.
    if (c.nav) host.mark(false);
    host.post({ type: 'ui-undone', planId, results: [{ i, result }] });
  });
}
