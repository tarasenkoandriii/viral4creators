/**
 * Мини-разбор HTML для проверок (без зависимостей): React отдаёт
 * хорошо сформированную разметку, этого хватает, чтобы вырезать элемент
 * вместе с вложенными по балансу одноимённых тегов.
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export interface Element {
  tag: string;
  open: string;
  outer: string;
}

/** Все элементы, открывающий тег которых подходит под `attrRe`. */
export function elementsWith(html: string, attrRe: RegExp): Element[] {
  const out: Element[] = [];
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    if (!attrRe.test(m[0])) continue;
    const tag = m[1].toLowerCase();
    const start = m.index;
    if (VOID.has(tag)) {
      out.push({ tag, open: m[0], outer: m[0] });
      continue;
    }
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = start + m[0].length;
    let depth = 1;
    let end = html.length;
    let t: RegExpExecArray | null;
    while ((t = re.exec(html)) !== null) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    out.push({ tag, open: m[0], outer: html.slice(start, end) });
  }
  return out;
}

export function attr(open: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(open);
  return m ? m[1] : null;
}

/** Атрибуты всех <link rel=...> / <meta ...> головы. */
export function headTags(html: string, tag: 'link' | 'meta'): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
}

/** Проверки утверждений на отрендеренном HTML; возвращает список нарушений. */
export function claimViolations(
  html: string,
  registry: Record<string, { status: string }>,
  soonLabel: string,
  where: string,
): string[] {
  const problems: string[] = [];
  for (const el of elementsWith(html, /\sdata-claim="/)) {
    const id = attr(el.open, 'data-claim')!;
    const status = attr(el.open, 'data-claim-status');
    const def = registry[id];
    if (!def) problems.push(`${where}: неизвестное утверждение ${id}`);
    else if (def.status === 'hidden') problems.push(`${where}: hidden-утверждение ${id} отрендерено`);
    else if (def.status !== status) problems.push(`${where}: ${id} рендерится как ${status}, в реестре ${def.status}`);
    if (status === 'soon') {
      if (!el.outer.includes('class="badge-soon"') || !el.outer.includes(`>${soonLabel}<`)) {
        problems.push(`${where}: soon-утверждение ${id} без метки «${soonLabel}»`);
      }
      if (/<a\b|<button\b[^>]*type="submit"|<form\b/i.test(el.outer)) {
        problems.push(`${where}: внутри soon-утверждения ${id} есть ссылка/кнопка — как будто фича доступна`);
      }
    }
  }
  return problems;
}

/**
 * JSON-LD страницы (§8.3, точка С0): каждый блок разбирается как JSON, и
 * в нём нет ни предложений и цен (`offers`, `Offer`, `price…` — оплаты нет
 * до Э4, разметка читалась бы как «можно купить»), ни рейтингов и отзывов
 * (`AggregateRating`, `review` — без реальных отзывов никогда).
 */
const FORBIDDEN_LD = /^(offers|aggregateRating|review|reviews|price|priceCurrency|priceSpecification|lowPrice|highPrice)$/;
const FORBIDDEN_LD_TYPES = /^(Offer|AggregateOffer|AggregateRating|Review|PriceSpecification|UnitPriceSpecification)$/;

export function jsonLdViolations(html: string, where: string): string[] {
  const problems: string[] = [];
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_LD.test(k)) problems.push(`${where}: JSON-LD ${at}.${k} — цены/оферты/рейтинги запрещены до Э4 и без отзывов`);
      if (k === '@type' && [x].flat().some((t) => typeof t === 'string' && FORBIDDEN_LD_TYPES.test(t))) problems.push(`${where}: JSON-LD ${at} — тип ${String(x)}`);
      walk(x, `${at}.${k}`);
    }
  };
  blocks.forEach((b, i) => {
    try {
      walk(JSON.parse(b), `#${i}`);
    } catch {
      problems.push(`${where}: JSON-LD #${i} не разбирается`);
    }
  });
  return problems;
}
