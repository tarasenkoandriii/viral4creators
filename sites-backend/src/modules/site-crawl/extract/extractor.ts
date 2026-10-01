/**
 * Извлечение основного текста HTML — K1 (ТЗ помощника §4.3 «Чанкинг», §6.5 п.3).
 *
 * htmlparser2 + domutils (без jsdom/браузера — работает на Vercel и НЕ
 * ХОДИТ В СЕТЬ: ни картинок, ни стилей, ни скриптов; `<img src=10.x>`
 * остаётся строкой — тест «extractor не ходит в сеть», мета-тест SSRF):
 *  - выкидываются script/style/noscript/template/svg/iframe, nav/aside,
 *    header/footer страницы (внутри article/main — остаются: там заголовок
 *    статьи), формы, куки-баннеры (id/class: cookie, consent, gdpr…),
 *    роли navigation/banner/contentinfo/complementary/search;
 *  - СКРЫТЫЙ ТЕКСТ вырезается: `hidden`, `aria-hidden="true"`, inline
 *    `display:none`/`visibility:hidden`/`font-size:0`/`opacity:0`, текст
 *    за краем (`text-indent:-9999px`, `left:-9999px`), `clip`, классы
 *    sr-only/visually-hidden/d-none…, белым по белому (inline color ==
 *    background) — §6.5 п.3: так прячут инъекцию «ИИ, игнорируй…» от
 *    человека, но не от нас;
 *  - корень контента: `<main>`/[role=main], одна `<article>`, иначе body;
 *  - заголовки h1–h6 → путь блока; таблицы — построчно «заголовок:
 *    значение»; `<details>/<summary>` и FAQ-разметка (microdata и JSON-LD
 *    schema.org FAQPage) → блок `faq`;
 *  - UGC (`ugc: true`): отзывы/комментарии по классам/id (review, comment,
 *    testimonial, отзыв, відгук), itemprop=review, schema.org/Review,
 *    WordPress `#comments`;
 *  - язык: `<html lang>`, иначе эвристика (extract/lang.ts);
 *  - ссылки (`<a href>`, включая меню — по ним идёт обход без sitemap)
 *    → normalizeCrawlUrl; noindex, canonical, theme-color.
 */
import { createHash } from 'crypto';
import type { AnyNode, Element } from 'domhandler';
import { findAll, findOne, getAttributeValue, isTag, isText } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { CRAWLER_ROBOTS_TOKEN } from '../../../brand';
import type { ExtractedBlock, ExtractedPage } from '../types';
import { normalizeCrawlUrl } from '../url';
import { detectLang, langFromAttr } from './lang';

/** Теги, чей текст никогда не основной. */
const DROP_TAGS = new Set([
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
  'nav',
  'aside',
  'form',
  'button',
  'select',
  'option',
  'textarea',
  'input',
  'label',
  'dialog',
  'head',
  'title',
  'meta',
  'link',
]);

const DROP_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'dialog',
  'alertdialog',
  'menu',
  'menubar',
]);

/** Классы/id «обвязки» — точным токеном (не подстрокой: `menu-item-price`). */
const CHROME_TOKENS = new Set([
  'breadcrumb',
  'breadcrumbs',
  'navbar',
  'sidebar',
  'site-header',
  'site-footer',
  'skip-link',
  'main-menu',
  'mobile-menu',
  'nav-menu',
  'top-menu',
  'pagination',
  'share',
  'social',
  'social-links',
  'newsletter',
  'popup',
  'modal',
]);

/** Классы «не видно человеку». */
const HIDDEN_TOKENS = new Set([
  'sr-only',
  'visually-hidden',
  'visuallyhidden',
  'screen-reader-text',
  'screen-reader-only',
  'hidden',
  'd-none',
  'is-hidden',
  'invisible',
  'hide',
]);

const COOKIE_RE = /cookie|consent|gdpr|cookiebot|onetrust|cc-banner|cc-window/i;

const UGC_TOKEN_RE =
  /(^|[-_])(reviews?|comments?|commentlist|testimonials?|feedbacks?|отзыв\w*|відгук\w*)($|[-_])/i;
/** Классы-состояния WordPress на body/article — не блоки комментариев. */
const UGC_STOP_TOKENS = new Set([
  'comments-open',
  'comments-closed',
  'no-comments',
  'has-comments',
  'reviews-allowed',
]);

const HEADING_RE = /^h([1-6])$/;

/** Блочные контейнеры — граница абзаца, свой текст = абзац `p`. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'blockquote',
  'dd',
  'dt',
  'dl',
  'figure',
  'figcaption',
  'address',
  'center',
  'header',
  'footer',
  'ul',
  'ol',
  'hr',
  'body',
  'html',
  'caption',
]);

function tokens(el: Element): string[] {
  const cls = getAttributeValue(el, 'class') ?? '';
  const id = getAttributeValue(el, 'id') ?? '';
  return `${cls} ${id}`
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i <= 0) continue;
    out.set(
      decl.slice(0, i).trim().toLowerCase(),
      decl
        .slice(i + 1)
        .replace(/!important/i, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ''),
    );
  }
  return out;
}

function isZeroLength(v: string | undefined): boolean {
  return v !== undefined && /^-?0(\.0+)?(px|em|rem|pt|%|vh|vw)?$/.test(v);
}

function farOffscreen(v: string | undefined): boolean {
  if (!v) return false;
  const m = /^(-\d+(?:\.\d+)?)(px|em|rem|pt|%|vw|vh)?$/.exec(v);
  if (!m) return false;
  const n = Math.abs(Number(m[1]));
  return m[2] === '%' || m[2] === 'vw' || m[2] === 'vh' ? n >= 100 : n >= 999;
}

/** Inline-стиль прячет текст от человека. */
function hiddenByStyle(style: string): boolean {
  const s = parseStyle(style);
  if (s.get('display') === 'none') return true;
  const vis = s.get('visibility');
  if (vis === 'hidden' || vis === 'collapse') return true;
  if (isZeroLength(s.get('font-size'))) return true;
  const op = s.get('opacity');
  if (op !== undefined && /^0(\.0+)?%?$/.test(op)) return true;
  if (farOffscreen(s.get('text-indent'))) return true;
  if (farOffscreen(s.get('left')) || farOffscreen(s.get('top'))) return true;
  if (
    (isZeroLength(s.get('height')) || isZeroLength(s.get('width'))) &&
    s.get('overflow') === 'hidden'
  ) {
    return true;
  }
  const clip = s.get('clip');
  if (clip && /^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(clip)) {
    return true;
  }
  const clipPath = s.get('clip-path');
  if (clipPath && /^inset\((50%|100%)\)$/.test(clipPath)) return true;
  const color = s.get('color');
  const bg = s.get('background-color') ?? s.get('background');
  if (color && bg && color === bg) return true;
  if (color === 'transparent') return true;
  return false;
}

function isHidden(el: Element): boolean {
  if (el.attribs.hidden !== undefined) return true;
  if ((getAttributeValue(el, 'aria-hidden') ?? '').trim() === 'true') {
    return true;
  }
  const style = getAttributeValue(el, 'style');
  if (style && hiddenByStyle(style)) return true;
  const cls = (getAttributeValue(el, 'class') ?? '').toLowerCase().split(/\s+/);
  return cls.some((c) => HIDDEN_TOKENS.has(c));
}

function hasAncestor(el: Element, names: string[]): boolean {
  let p = el.parent;
  while (p) {
    if (isTag(p) && names.includes(p.name)) return true;
    p = p.parent;
  }
  return false;
}

/** Узел целиком не идёт в основной текст. */
function shouldSkip(el: Element): boolean {
  const name = el.name;
  if (DROP_TAGS.has(name)) return true;
  if (
    (name === 'header' || name === 'footer') &&
    !hasAncestor(el, ['article', 'main'])
  ) {
    return true;
  }
  const role = (getAttributeValue(el, 'role') ?? '').trim().toLowerCase();
  if (role && DROP_ROLES.has(role)) return true;
  if (isHidden(el)) return true;
  const t = tokens(el);
  if (t.some((x) => CHROME_TOKENS.has(x))) return true;
  if (name !== 'body' && name !== 'html' && t.some((x) => COOKIE_RE.test(x))) {
    return true;
  }
  return false;
}

function isUgc(el: Element): boolean {
  if (el.name === 'body' || el.name === 'html' || el.name === 'main') {
    return false;
  }
  const itemprop = (getAttributeValue(el, 'itemprop') ?? '').toLowerCase();
  if (/\b(review|comment)\b/.test(itemprop)) return true;
  const itemtype = (getAttributeValue(el, 'itemtype') ?? '').toLowerCase();
  if (/schema\.org\/(review|comment|userreview)\b/.test(itemtype)) return true;
  if ((getAttributeValue(el, 'id') ?? '').toLowerCase() === 'comments') {
    return true;
  }
  return tokens(el).some(
    (x) => !UGC_STOP_TOKENS.has(x) && UGC_TOKEN_RE.test(x),
  );
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Видимый текст поддерева (с теми же правилами пропуска). */
function visibleText(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (!isTag(node)) {
    // Document/CDATA — дети; комментарии — нет.
    const kids = (node as { children?: AnyNode[] }).children;
    return kids ? kids.map(visibleText).join('') : '';
  }
  if (shouldSkip(node)) return '';
  if (node.name === 'br') return '\n';
  const inner = node.children.map(visibleText).join('');
  return BLOCK_TAGS.has(node.name) ||
    HEADING_RE.test(node.name) ||
    node.name === 'li' ||
    node.name === 'tr' ||
    node.name === 'td' ||
    node.name === 'th'
    ? ` ${inner} `
    : inner;
}

class BlockCollector {
  readonly blocks: ExtractedBlock[] = [];
  private stack: Array<{ level: number; text: string }> = [];
  private buffer: string[] = [];
  private bufferType: 'p' | 'li' = 'p';
  private ugc = false;

  private path(): string[] {
    return this.stack.map((h) => h.text);
  }

  private push(block: ExtractedBlock): void {
    if (!block.text) return;
    if (this.ugc) block.ugc = true;
    const prev = this.blocks[this.blocks.length - 1];
    // Повтор подряд (адаптивная вёрстка: «десктоп»/«мобайл» копии) — один блок.
    if (prev && prev.t === block.t && prev.text === block.text) return;
    this.blocks.push(block);
  }

  flush(): void {
    const text = norm(this.buffer.join(''));
    this.buffer = [];
    if (text) this.push({ t: this.bufferType, text, path: this.path() });
  }

  walk(node: AnyNode): void {
    if (isText(node)) {
      this.buffer.push(node.data);
      return;
    }
    if (!isTag(node)) {
      const kids = (node as { children?: AnyNode[] }).children;
      kids?.forEach((c) => this.walk(c));
      return;
    }
    const el = node;
    if (shouldSkip(el)) return;
    const name = el.name;

    const ugcHere = !this.ugc && isUgc(el);
    if (ugcHere) {
      this.flush();
      this.ugc = true;
    }
    try {
      this.walkElement(el, name);
    } finally {
      if (ugcHere) {
        this.flush();
        this.ugc = false;
      }
    }
  }

  private walkElement(el: Element, name: string): void {
    const h = HEADING_RE.exec(name);
    if (h) {
      this.flush();
      const level = Number(h[1]);
      const text = norm(visibleText(el));
      if (!text) return;
      while (
        this.stack.length &&
        this.stack[this.stack.length - 1].level >= level
      ) {
        this.stack.pop();
      }
      this.push({ t: 'h', level, text, path: this.path() });
      this.stack.push({ level, text });
      return;
    }
    if (name === 'br') {
      this.buffer.push(' ');
      return;
    }
    if (name === 'img' || name === 'picture' || name === 'source') return;
    if (isFaqQuestion(el)) {
      this.flush();
      const q = norm(
        visibleText(
          findOne(
            (e) => (getAttributeValue(e, 'itemprop') ?? '') === 'name',
            el.children,
          ) ?? el,
        ),
      );
      const ansEl = findOne(
        (e) => (getAttributeValue(e, 'itemprop') ?? '') === 'acceptedAnswer',
        el.children,
      );
      const a = ansEl ? norm(visibleText(ansEl)) : '';
      if (q && a)
        this.push({ t: 'faq', text: `${q}\n${a}`, path: this.path() });
      else if (q) this.push({ t: 'p', text: q, path: this.path() });
      return;
    }
    if (name === 'details') {
      this.flush();
      const summary = el.children.find((c) => isTag(c) && c.name === 'summary');
      const q = summary ? norm(visibleText(summary)) : '';
      const a = norm(
        el.children
          .filter((c) => c !== summary)
          .map(visibleText)
          .join(' '),
      );
      if (q && a)
        this.push({ t: 'faq', text: `${q}\n${a}`, path: this.path() });
      else if (q || a) this.push({ t: 'p', text: q || a, path: this.path() });
      return;
    }
    if (name === 'table') {
      this.flush();
      this.table(el);
      return;
    }
    if (name === 'pre') {
      this.flush();
      const text = visibleText(el)
        .split('\n')
        .map((l) => l.replace(/[ \t]+$/g, ''))
        .join('\n')
        .trim();
      if (text) this.push({ t: 'pre', text, path: this.path() });
      return;
    }
    if (name === 'li') {
      this.flush();
      const prevType = this.bufferType;
      this.bufferType = 'li';
      el.children.forEach((c) => this.walk(c));
      this.flush();
      this.bufferType = prevType;
      return;
    }
    if (BLOCK_TAGS.has(name)) {
      // Вложенный блок внутри `li` (`<li><p>…</p></li>`) остаётся `li`.
      this.flush();
      el.children.forEach((c) => this.walk(c));
      this.flush();
      return;
    }
    el.children.forEach((c) => this.walk(c));
  }

  private table(table: Element): void {
    const rows = findAll((e) => e.name === 'tr', table.children).filter(
      // Строки вложенных таблиц — часть ячейки внешней.
      (tr) => closestTable(tr) === table,
    );
    let header: string[] | null = null;
    for (const tr of rows) {
      if (shouldSkip(tr)) continue;
      const cells = tr.children.filter(
        (c): c is Element =>
          isTag(c) && (c.name === 'td' || c.name === 'th') && !shouldSkip(c),
      );
      if (cells.length === 0) continue;
      const texts = cells.map((c) => norm(visibleText(c)));
      const allTh = cells.every((c) => c.name === 'th');
      if (allTh && header === null && cells.length > 1) {
        header = texts;
        continue;
      }
      let text: string;
      if (header && header.length === texts.length) {
        text = texts
          .map((v, i) => (v ? (header![i] ? `${header![i]}: ${v}` : v) : ''))
          .filter(Boolean)
          .join('; ');
      } else if (texts.length === 2 && texts[0] && texts[1]) {
        text = `${texts[0]}: ${texts[1]}`;
      } else {
        text = texts.filter(Boolean).join('; ');
      }
      if (text) this.push({ t: 'tr', text, path: this.path() });
    }
  }
}

function closestTable(el: Element): Element | null {
  let p = el.parent;
  while (p) {
    if (isTag(p) && p.name === 'table') return p;
    p = p.parent;
  }
  return null;
}

function isFaqQuestion(el: Element): boolean {
  const itemtype = (getAttributeValue(el, 'itemtype') ?? '').toLowerCase();
  return /schema\.org\/question\b/.test(itemtype);
}

/** FAQ из JSON-LD (`@type: FAQPage`) — читается ДО выброса script. */
function faqFromJsonLd(scripts: Element[]): Array<{ q: string; a: string }> {
  const out: Array<{ q: string; a: string }> = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || out.length >= 100 || v === null || typeof v !== 'object') {
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    const type = o['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('Question')) {
      const q = typeof o.name === 'string' ? o.name : '';
      const ans = o.acceptedAnswer as Record<string, unknown> | undefined;
      const aRaw =
        ans && typeof ans === 'object' && typeof ans.text === 'string'
          ? ans.text
          : '';
      const a = norm(visibleText(parseDocument(aRaw)));
      if (q && a) out.push({ q: norm(q), a });
      return;
    }
    for (const key of ['@graph', 'mainEntity']) {
      if (key in o) visit(o[key], depth + 1);
    }
  };
  for (const s of scripts) {
    const raw = s.children.map((c) => (isText(c) ? c.data : '')).join('');
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // Битый JSON-LD на чужом сайте — не наша ошибка, просто пропускаем.
    }
  }
  return out;
}

function metaContent(all: Element[], name: string): string | null {
  const want = name.toLowerCase();
  for (const m of all) {
    if (m.name !== 'meta') continue;
    const n = (
      getAttributeValue(m, 'name') ??
      getAttributeValue(m, 'property') ??
      ''
    )
      .trim()
      .toLowerCase();
    if (n === want) return (getAttributeValue(m, 'content') ?? '').trim();
  }
  return null;
}

/** noindex/none в `<meta name="robots">` или в мете нашего бота. */
function metaNoindex(all: Element[]): boolean {
  const ours = CRAWLER_ROBOTS_TOKEN.toLowerCase();
  return all.some((m) => {
    if (m.name !== 'meta') return false;
    const n = (getAttributeValue(m, 'name') ?? '').trim().toLowerCase();
    if (n !== 'robots' && n !== ours) return false;
    const c = (getAttributeValue(m, 'content') ?? '').toLowerCase();
    return /\b(noindex|none)\b/.test(c);
  });
}

export function extractPage(html: string, url: string): ExtractedPage {
  const doc = parseDocument(html, { decodeEntities: true });
  const all = findAll(() => true, doc.children);

  const htmlEl = all.find((e) => e.name === 'html');
  const baseHref = all.find(
    (e) => e.name === 'base' && getAttributeValue(e, 'href'),
  );
  const linkBase =
    (baseHref &&
      normalizeCrawlUrl(getAttributeValue(baseHref, 'href') ?? '', url)) ||
    url;

  const titleEl = all.find((e) => e.name === 'title');
  const ogTitle = metaContent(all, 'og:title');

  const canonicalEl = all.find(
    (e) =>
      e.name === 'link' &&
      (getAttributeValue(e, 'rel') ?? '')
        .toLowerCase()
        .split(/\s+/)
        .includes('canonical'),
  );
  const canonical = canonicalEl
    ? normalizeCrawlUrl(getAttributeValue(canonicalEl, 'href') ?? '', linkBase)
    : null;

  const themeRaw = metaContent(all, 'theme-color');
  const themeColor =
    themeRaw &&
    themeRaw.length <= 64 &&
    /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(themeRaw)
      ? themeRaw
      : null;

  const links: string[] = [];
  const seen = new Set<string>();
  for (const a of all) {
    if (a.name !== 'a' && a.name !== 'area') continue;
    const href = getAttributeValue(a, 'href');
    if (!href) continue;
    const n = normalizeCrawlUrl(href, linkBase);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    links.push(n);
    if (links.length >= 2000) break;
  }

  const jsonLdFaq = faqFromJsonLd(
    all.filter(
      (e) =>
        e.name === 'script' &&
        (getAttributeValue(e, 'type') ?? '').toLowerCase() ===
          'application/ld+json',
    ),
  );

  // Корень контента: main → [role=main] → единственная article → body.
  const visibleMain = (e: Element) => !shouldSkip(e) && !hasHiddenAncestor(e);
  const articles = all.filter((e) => e.name === 'article' && visibleMain(e));
  const root =
    all.find((e) => e.name === 'main' && visibleMain(e)) ??
    all.find(
      (e) => (getAttributeValue(e, 'role') ?? '') === 'main' && visibleMain(e),
    ) ??
    (articles.length === 1 ? articles[0] : undefined) ??
    all.find((e) => e.name === 'body') ??
    doc;

  const collector = new BlockCollector();
  // Корень мог оказаться внутри UGC-обёртки только в патологической
  // вёрстке; путь заголовков начинаем с корня.
  if (root === doc) collector.walk(doc);
  else (root as Element).children.forEach((c) => collector.walk(c));
  collector.flush();

  const blocks = collector.blocks;
  const knownFaq = new Set(
    blocks.filter((b) => b.t === 'faq').map((b) => b.text.split('\n')[0]),
  );
  for (const f of jsonLdFaq) {
    if (knownFaq.has(f.q)) continue;
    knownFaq.add(f.q);
    blocks.push({ t: 'faq', text: `${f.q}\n${f.a}`, path: [] });
  }

  const text = blocks
    .map((b) => b.text)
    .join('\n')
    .normalize('NFC');
  const h1 = blocks.find((b) => b.t === 'h' && b.level === 1)?.text ?? null;
  const title =
    (titleEl ? norm(visibleTitle(titleEl)) : '') ||
    (ogTitle ? norm(ogTitle) : '') ||
    h1 ||
    null;

  return {
    url,
    title: title ? title.slice(0, 500) : null,
    lang:
      langFromAttr(htmlEl ? getAttributeValue(htmlEl, 'lang') : null) ??
      detectLang(text),
    text,
    blocks,
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    links,
    noindex: metaNoindex(all),
    canonical,
    themeColor,
  };
}

function visibleTitle(el: Element): string {
  return el.children.map((c) => (isText(c) ? c.data : '')).join('');
}

function hasHiddenAncestor(el: Element): boolean {
  let p = el.parent;
  while (p) {
    if (isTag(p) && shouldSkip(p)) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Страница рисуется скриптами (SPA): основного текста почти нет, а
 * разметка — пустой контейнер приложения и бандл. В Э1 такие страницы не
 * рендерим (контракт Э1, решение 9: браузер грузит подресурсы мимо IP-pin)
 * → `skipReason = 'spa'`, владелец видит причину.
 */
export function looksLikeSpaShell(html: string, page: ExtractedPage): boolean {
  if (page.text.length >= 200) return false;
  const doc = parseDocument(html);
  const all = findAll(() => true, doc.children);
  const hasBundle = all.some(
    (e) => e.name === 'script' && !!getAttributeValue(e, 'src'),
  );
  const appRoot = all.some((e) =>
    [
      'root',
      'app',
      '__next',
      '__nuxt',
      '___gatsby',
      'svelte',
      'q-app',
    ].includes((getAttributeValue(e, 'id') ?? '').toLowerCase()),
  );
  const jsNotice =
    /enable javascript|включите javascript|увімкніть javascript|requires javascript/i.test(
      html,
    );
  return hasBundle && (appRoot || jsNotice);
}
