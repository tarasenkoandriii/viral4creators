/**
 * Ограниченный markdown ответа модели (ТЗ §4.12: «ответ модели — враждебный
 * текст»). Разбор в ДАННЫЕ (AST), рендер — Preact-узлами (тексты экранирует
 * сам Preact, HTML-приёмников нет). Что поддерживаем: абзацы, переносы,
 * **жирный**, *курсив*, `код`, списки, блок кода, ссылки. Чего нет НИКОГДА:
 * сырого HTML (виден как текст), картинок (`![a](u)` → только подпись —
 * внешняя картинка = канал утечки), ссылок не на хосты сайта и не https
 * (такая ссылка остаётся текстом).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'pre'; v: string };

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)$/;

/**
 * Ссылка разрешена, если её origin — один из хостов сайта (`config.hosts` +
 * подтверждённый origin родителя) и схема https (http — только loopback для
 * локальных стендов). Возвращает нормализованный href или null.
 */
export function safeHref(
  raw: string,
  allowedOrigins: readonly string[]
): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const okScheme =
    u.protocol === 'https:' ||
    (u.protocol === 'http:' && LOOPBACK.test(u.hostname));
  if (!okScheme) return null;
  return allowedOrigins.indexOf(u.origin) >= 0 ? u.href : null;
}

function inline(src: string, allowed: readonly string[], depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < 3 && (rest.indexOf('**') === 0 || rest.indexOf('__') === 0)) {
      const mark = rest.slice(0, 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2) {
        flush();
        out.push({
          t: 'b',
          c: inline(src.slice(i + 2, end), allowed, depth + 1),
        });
        i = end + 2;
        continue;
      }
    }
    if (depth < 3 && (ch === '*' || ch === '_') && src[i + 1] !== ' ') {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && src[end - 1] !== ' ') {
        flush();
        out.push({
          t: 'i',
          c: inline(src.slice(i + 1, end), allowed, depth + 1),
        });
        i = end + 1;
        continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      // Картинка: только подпись, адрес не используется вовсе.
      const m = /^!\[([^\]\n]{0,200})\]\(([^)\s]{0,2000})\)/.exec(rest);
      if (m) {
        buf += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/.exec(rest);
      if (m) {
        const href = safeHref(m[2], allowed);
        flush();
        const label = inline(m[1], allowed, depth + 1);
        if (href) out.push({ t: 'a', href, c: label });
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const UL = /^\s{0,3}[-*•]\s+(.*)$/;
const OL = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;

export function parseMarkdown(
  src: string,
  allowedOrigins: readonly string[]
): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length)
      out.push({ t: 'p', c: inline(para.join('\n'), allowedOrigins) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++)
        code.push(lines[i]);
      out.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      const re = ul ? UL : OL;
      const items: Inline[][] = [];
      for (; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(inline(m[1], allowedOrigins));
      }
      i--;
      out.push({ t: kind, items });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      out.push({ t: 'p', c: [{ t: 'b', c: inline(h[1], allowedOrigins) }] });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return out;
}
