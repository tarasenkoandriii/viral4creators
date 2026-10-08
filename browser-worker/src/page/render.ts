/**
 * «Очищенный» HTML отрисованной страницы для знаний «Сайта» (Ш3 (20),
 * Р-З10-20) — исполняется В БРАУЗЕРЕ через `page.evaluate`, функция
 * САМОДОСТАТОЧНА (Playwright сериализует её текст).
 *
 * Зачем HTML, а не готовый текст: блоки, путь заголовков, UGC, FAQ,
 * noindex и canonical разбирает на сервере ТОТ ЖЕ извлекатель, что у
 * обычного обхода (`site-crawl/extract/extractor.ts`) — две разные логики
 * «что есть основной текст» однажды разошлись бы молча. Воркер только
 * отдаёт то, что видит человек:
 *  - видимое: `display:none`, `visibility:hidden`, `hidden`, `aria-hidden` —
 *    по ВЫЧИСЛЕННЫМ стилям; `opacity:0` — только ИНЛАЙН-стилем, как у
 *    извлекателя обхода (аудит P2-3: класс анимации появления «reveal on
 *    scroll» — не скрытие; перед сбором страница прокручивается до низа);
 *  - строка — корректный UTF-16 (одиночный суррогат → U+FFFD, обрезка не
 *    режет пару): иначе Postgres не примет JSON результата (аудит P2-2);
 *  - без скриптов, стилей, медиа, полей ввода и их значений, форм,
 *    `data-assist="never"`; без атрибутов, кроме тех, что нужны
 *    извлекателю (роль, микроразметка, классы-маркеры обвязки и отзывов);
 *  - шапка, подвал, навигация и боковые колонки вне `main`/`article` —
 *    вон (извлекатель их всё равно выкидывает; место в лимите — тексту);
 *  - ссылки своего хоста — отдельным списком (обход идёт по ним дальше:
 *    меню SPA рисуется скриптом, обычный обход его не видел);
 *  - ПД третьих лиц: в отзывах и комментариях (UGC) e-mail и телефоны —
 *    маской (публичный текст самого сайта — как у обычного обхода).
 * Только чтение DOM: ни одного события, ни одного изменения страницы.
 */

export interface RenderedPage {
  html: string;
  links: string[];
}

export function collectRenderedHtml(limits: {
  htmlChars: number;
  links: number;
}): RenderedPage {
  const DROP = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'math',
    'iframe',
    'frame',
    'frameset',
    'canvas',
    'object',
    'embed',
    'video',
    'audio',
    'map',
    'img',
    'picture',
    'source',
    'link',
    'meta',
    'form',
    'input',
    'select',
    'option',
    'textarea',
    'button',
    'label',
    'dialog',
    'head',
    'title',
  ]);
  const CHROME = new Set(['header', 'footer', 'nav', 'aside']);
  const VOID = new Set(['br', 'hr', 'wbr']);
  const KEEP_ATTRS = ['role', 'itemprop', 'itemtype', 'itemscope', 'colspan'];
  /** Классы/id, которые читает извлекатель (обвязка, отзывы, «скрыто»). */
  const MARKER =
    /(^|[-_])(breadcrumbs?|navbar|sidebar|site-header|site-footer|skip-link|main-menu|mobile-menu|nav-menu|top-menu|pagination|share|social|social-links|newsletter|popup|modal|cookie\w*|consent|gdpr|cookiebot|onetrust|cc-banner|cc-window|reviews?|comments?|commentlist|testimonials?|feedbacks?|отзыв\w*|відгук\w*)($|[-_])/i;
  const UGC_RE =
    /(^|[-_])(reviews?|comments?|commentlist|testimonials?|feedbacks?|отзыв\w*|відгук\w*)($|[-_])/i;
  const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE = /(?:\+?\d[\s().-]?){7,}\d/g;
  const LONE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const esc = (s: string) =>
    s
      .replace(LONE, '\uFFFD')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');

  const hidden = (el: Element): boolean => {
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('data-assist') === 'never') return true;
    const cs = getComputedStyle(el);
    return (
      cs.display === 'none' ||
      cs.visibility === 'hidden' ||
      cs.visibility === 'collapse' ||
      /(^|;)\s*opacity\s*:\s*0(\.0*)?\s*(!important)?\s*(;|$)/i.test(
        el.getAttribute('style') ?? '',
      )
    );
  };
  const markers = (el: Element): string[] => {
    const raw = `${el.getAttribute('class') ?? ''} ${el.id ?? ''}`
      .split(/\s+/)
      .filter((t) => t && MARKER.test(t));
    return [...new Set(raw)].slice(0, 4);
  };
  const isUgc = (el: Element): boolean => {
    if (el.hasAttribute('data-assist-ugc') || el.hasAttribute('data-ugc'))
      return true;
    const ip = (el.getAttribute('itemprop') ?? '').toLowerCase();
    if (/\b(review|comment)\b/.test(ip)) return true;
    return `${el.getAttribute('class') ?? ''} ${el.id ?? ''}`
      .split(/\s+/)
      .some((t) => t && UGC_RE.test(t));
  };

  const de = document.documentElement;
  const lang = (de.getAttribute('lang') ?? '').slice(0, 20);
  const head: string[] = [];
  const title = (document.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (title) head.push(`<title>${esc(title)}</title>`);
  const robots = document.querySelector('meta[name="robots" i]');
  const rc = robots?.getAttribute('content');
  if (rc)
    head.push(`<meta name="robots" content="${escAttr(rc.slice(0, 120))}">`);
  const canon = document.querySelector(
    'link[rel~="canonical" i]',
  ) as HTMLLinkElement | null;
  if (canon?.href && /^https?:/.test(canon.href) && canon.href.length <= 2000)
    head.push(`<link rel="canonical" href="${escAttr(canon.href)}">`);
  const headLen = head.join('').length + lang.length;
  // Бюджет — за вычетом уже собранной головы и обёртки документа.
  let budget = Math.max(0, limits.htmlChars - headLen - 120);
  let full = false;
  const emit = (el: Element, inMain: boolean, ugc: boolean): string => {
    if (full) return '';
    const tag = el.tagName.toLowerCase();
    // Пространства имён (`svg:…`) и прочая экзотика — вон.
    if (DROP.has(tag) || !/^[a-z][a-z0-9-]*$/.test(tag)) return '';
    if (hidden(el)) return '';
    const role = (el.getAttribute('role') ?? '').toLowerCase();
    if (
      !inMain &&
      (CHROME.has(tag) ||
        ['navigation', 'banner', 'contentinfo', 'complementary'].includes(role))
    )
      return '';
    const main =
      inMain || tag === 'main' || tag === 'article' || role === 'main';
    const u = ugc || isUgc(el);
    if (VOID.has(tag)) return tag === 'br' ? '<br>' : '';
    let inner = '';
    const kids: Node[] = [];
    // Открытый shadow DOM (веб-компоненты SPA) — тоже видимый текст.
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) sr.childNodes.forEach((n) => kids.push(n));
    el.childNodes.forEach((n) => kids.push(n));
    for (const n of kids) {
      if (full) break;
      if (n.nodeType === 3) {
        let t = (n.nodeValue ?? '').replace(/\s+/g, ' ');
        if (!t.trim()) {
          if (t) inner += ' ';
          continue;
        }
        if (u) t = t.replace(EMAIL, '[e-mail]').replace(PHONE, '[тел.]');
        const out = esc(t);
        if (out.length > budget) {
          full = true;
          break;
        }
        budget -= out.length;
        inner += out;
      } else if (n.nodeType === 1) {
        inner += emit(n as Element, main, u);
      }
    }
    if (!inner.replace(/<[^>]*>/g, '').trim()) return '';
    // Пользовательские теги (веб-компоненты) — как `div`.
    const name = /^[a-z][a-z0-9]*$/.test(tag) ? tag : 'div';
    let attrs = '';
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null && v.length <= 120) attrs += ` ${a}="${escAttr(v)}"`;
    }
    const m = markers(el);
    if (m.length) attrs += ` class="${escAttr(m.join(' '))}"`;
    if ((el.id ?? '').toLowerCase() === 'comments') attrs += ' id="comments"';
    if (el.hasAttribute('data-assist-ugc')) attrs += ' data-assist-ugc=""';
    const open = `<${name}${attrs}>`;
    const close = `</${name}>`;
    budget -= open.length + close.length;
    if (budget < 0) full = true;
    return `${open}${inner}${close}`;
  };

  const body = document.body ? emit(document.body, false, false) : '';
  const html = `<!doctype html><html${
    lang ? ` lang="${escAttr(lang)}"` : ''
  }><head>${head.join('')}</head>${body || '<body></body>'}</html>`;

  const links: string[] = [];
  const seen = new Set<string>();
  document.querySelectorAll('a[href]').forEach((a) => {
    if (links.length >= limits.links) return;
    try {
      const u = new URL((a as HTMLAnchorElement).href, location.href);
      if (u.origin !== location.origin) return;
      if (u.username || u.password) return;
      u.hash = '';
      const s = u.toString();
      if (s.length > 2000 || seen.has(s)) return;
      seen.add(s);
      links.push(s);
    } catch {
      /* пропуск */
    }
  });
  // Обрезка не режет суррогатную пару.
  let cut = html.slice(0, limits.htmlChars);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { html: cut, links };
}
