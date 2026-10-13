import { Fragment, type ReactNode } from 'react';

/**
 * Markdown материала → React БЕЗ сырого HTML (проектный документ §13.1,
 * §16.8; тест — `scripts/markdown.test.ts`).
 *
 * Свой минимальный рендер, а не библиотека: тело приходит из кабинета
 * (согласованная версия), но HTML в нём не исполняется НИКОГДА — React
 * экранирует текст, `dangerouslySetInnerHTML` нет. Поддержано: заголовки
 * (`#` материала → `<h2>`: `<h1>` на странице один — заголовок материала),
 * абзацы, списки, цитаты, блоки и строки кода, таблицы (GFM), линия,
 * **жирный**, *курсив*, ссылки.
 *
 * Ссылки: только `https:`, `mailto:`, внутренний путь `/…` и якорь `#…`;
 * прочее (`javascript:`, `http:`, `data:`, относительное) — просто текст.
 * Внешние — `rel="nofollow noopener"`. Внутренние — без `utm_*` (ТЗ §14:
 * «внутренние ссылки без UTM»; метки вырезаются, `check-built` проверяет
 * итог).
 */

export interface MarkdownOptions {
  /** Хост сайта (`SITE_URL`): https-ссылка на него — внутренняя. */
  siteHost: string;
}

type Block =
  | { t: 'h'; level: 2 | 3 | 4 | 5 | 6; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'code'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' };

const LIST_UL = /^\s{0,3}[-*+]\s+(.*)$/;
const LIST_OL = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  const isBlockStart = (l: string, next: string | undefined) =>
    HEADING.test(l) ||
    FENCE.test(l) ||
    HR.test(l) ||
    LIST_UL.test(l) ||
    LIST_OL.test(l) ||
    /^\s{0,3}>/.test(l) ||
    (l.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // закрывающая (или конец текста)
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: 'h', level: Math.min(6, Math.max(2, h[1].length)) as 2 | 3 | 4 | 5 | 6, text: h[2] });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const r = cells(lines[i++]);
        rows.push(head.map((_, k) => r[k] ?? ''));
      }
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push({ t: 'quote', text: body.join(' ') });
      continue;
    }
    const listRe = LIST_UL.test(line) ? LIST_UL : LIST_OL.test(line) ? LIST_OL : null;
    if (listRe) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = listRe.exec(lines[i]);
        if (m) items.push(m[1]);
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      out.push({ t: listRe === LIST_UL ? 'ul' : 'ol', items });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    out.push({ t: 'p', text: para.join(' ') });
  }
  return out;
}

export type SafeLink = { href: string; external: boolean } | null;

/** Политика ссылок (см. шапку). `null` — ссылкой не делать. */
export function safeHref(raw: string, opts: MarkdownOptions): SafeLink {
  const href = raw.trim();
  if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(href)) return { href, external: true };
  if (href.startsWith('#')) return /^#[\w-]{1,80}$/.test(href) ? { href, external: false } : null;
  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) {
    return { href: stripUtm(href), external: false };
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.host.toLowerCase() === opts.siteHost.toLowerCase()) {
    return { href: stripUtm(url.pathname + url.search + url.hash), external: false };
  }
  return { href: url.toString(), external: true };
}

/** Вырезает `utm_*` из внутреннего пути (остальные параметры и якорь — как есть). */
export function stripUtm(pathWithQuery: string): string {
  const url = new URL(pathWithQuery, 'https://internal.invalid');
  for (const k of [...url.searchParams.keys()]) if (/^utm_/i.test(k)) url.searchParams.delete(k);
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`;
}

/** Строчная разметка: `код`, [ссылка](url), **жирный**, *курсив*. */
export function renderInline(text: string, opts: MarkdownOptions, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*([^*]+)\*\*|(?<![\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}_])_([^_\s][^_]*)_(?![\p{L}\p{N}_])/gu;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) {
      const link = safeHref(m[3], opts);
      const inner = renderInline(m[2], opts, key);
      if (!link) out.push(<Fragment key={key}>{inner}</Fragment>);
      else if (link.external) {
        out.push(
          <a key={key} href={link.href} rel="nofollow noopener">
            {inner}
          </a>,
        );
      } else {
        out.push(
          <a key={key} href={link.href}>
            {inner}
          </a>,
        );
      }
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[4] ?? m[5], opts, key)}</strong>);
    } else {
      out.push(<em key={key}>{renderInline(m[6] ?? m[7], opts, key)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, options }: { source: string; options: MarkdownOptions }) {
  const blocks = parseBlocks(source);
  return (
    <>
      {blocks.map((b, k) => {
        const key = `b${k}`;
        switch (b.t) {
          case 'h': {
            const H = `h${b.level}` as 'h2';
            return <H key={key}>{renderInline(b.text, options, key)}</H>;
          }
          case 'p':
            return <p key={key}>{renderInline(b.text, options, key)}</p>;
          case 'ul':
          case 'ol': {
            const L = b.t;
            return (
              <L key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, options, `${key}-${j}`)}</li>
                ))}
              </L>
            );
          }
          case 'quote':
            return <blockquote key={key}>{renderInline(b.text, options, key)}</blockquote>;
          case 'code':
            return (
              <pre key={key} tabIndex={0}>
                <code>{b.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={key} />;
          case 'table':
            return (
              <div key={key} className="table-wrap" role="region" aria-label="Таблиця" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} scope="col">
                          {renderInline(c, options, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, x) => (
                          <td key={x}>{renderInline(c, options, `${key}-${j}-${x}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}
