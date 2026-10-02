/**
 * Документация установки (Л5, ТЗ §3.13): Markdown в репозитории
 * (`sites-landing/docs/assistant/<локаль>/<страница>.md`) → блоки. Свой
 * маленький разборщик, как `legal-markdown.ts`, только с тем, что нужно
 * документации разработчика: заголовки `##`/`###`, абзацы, списки `-` и
 * `1.`, примечание `>`, таблица с подписью, блок кода и инлайн
 * `**жирный**`, `` `код` ``, `[текст](адрес)`.
 *
 * Правила (их проверяет `scripts/docs.test.ts`):
 *  - всё содержание после вводного абзаца — внутри блоков `:::claim <id>`
 *    … `:::` (реестр утверждений §3.0: ни одного тезиса без claimId);
 *    `hidden`-блок не рендерится, `soon` — с меткой, и в нём нельзя ни
 *    ссылок, ни кода (код неопубликованного пакета никто не должен копировать);
 *  - код установки НЕ пишется в Markdown руками: блок ```` ```gen:<имя> ````
 *    заполняется функцией из `lib/install.ts` — той же, что сверяется с
 *    продуктом тестом (иначе документация разошлась бы с TMA);
 *  - публичные имена — плейсхолдерами `%%имя%%` из `brand.ts`;
 *  - ссылки — только на свои пути (`/…`) или `https://`.
 * Рендер (React) — `components/DocsArticle.tsx`, без `dangerouslySetInnerHTML`.
 */

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; href: string };

export type DocBlock =
  | { kind: 'h2' | 'h3'; text: string; id: string }
  | { kind: 'p'; inline: Inline[] }
  | { kind: 'ul' | 'ol'; items: Inline[][] }
  | { kind: 'note'; inline: Inline[] }
  | { kind: 'code'; lang: string; code: string; gen: string | null }
  | { kind: 'table'; caption: string; head: string[]; rows: Inline[][][] }
  | { kind: 'claim'; claim: string; blocks: DocBlock[] };

export interface ParsedDoc {
  /** `<title>` страницы (с брендом). */
  title: string;
  /** Заголовок h1 — `heading:` вводной части, иначе title. */
  heading: string;
  description: string;
  lead: Inline[];
  blocks: DocBlock[];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function safeHref(href: string): string | null {
  if (/^\/(?!\/)[A-Za-z0-9/_#.-]*$/.test(href)) return href;
  if (/^https:\/\/[A-Za-z0-9.-]+(\/[^\s"'<>]*)?$/.test(href)) return href;
  return null;
}

export function parseInlineDoc(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => {
    if (t) out.push({ kind: 'text', text: t });
  };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] });
    else {
      const href = safeHref(m[4]);
      if (href) out.push({ kind: 'link', text: m[3], href });
      else throw new Error(`docs: небезопасная ссылка «${m[4]}»`);
    }
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return out;
}

/** `%%имя%%` → значение; неизвестное имя — ошибка (а не пустая строка в документации). */
export function substitute(md: string, vars: Record<string, string>): string {
  return md.replace(/%%([A-Za-z][A-Za-z0-9]*)%%/g, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`docs: неизвестный плейсхолдер %%${name}%%`);
    return vars[name];
  });
}

/**
 * Разбор. `gen` — генераторы блоков кода (`lib/install.ts`); неизвестный —
 * ошибка сборки.
 */
export function parseDoc(md: string, gen: Record<string, () => string>): ParsedDoc {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const meta: Record<string, string> = {};
  if (lines[0] === '---') {
    i = 1;
    for (; i < lines.length && lines[i] !== '---'; i++) {
      const mm = /^([a-z]+):\s*(.+)$/.exec(lines[i]);
      if (mm) meta[mm[1]] = mm[2].trim();
    }
    i++;
  }
  if (!meta.title || !meta.description) throw new Error('docs: нет title/description во вводной части');

  const root: DocBlock[] = [];
  const stack: DocBlock[][] = [root];
  const cur = () => stack[stack.length - 1];
  let lead: Inline[] | null = null;
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  let note: string[] = [];
  let caption: string | null = null;

  const flush = () => {
    if (para.length) {
      const inline = parseInlineDoc(para.join(' '));
      if (lead === null && stack.length === 1 && root.length === 0) lead = inline;
      else cur().push({ kind: 'p', inline });
    }
    if (list) cur().push({ kind: list.kind, items: list.items.map(parseInlineDoc) });
    if (note.length) cur().push({ kind: 'note', inline: parseInlineDoc(note.join(' ')) });
    para = [];
    list = null;
    note = [];
  };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && lines[i].trimEnd() !== '```'; i++) body.push(lines[i]);
      if (i >= lines.length) throw new Error('docs: незакрытый блок кода');
      const tag = fence[1];
      if (tag.startsWith('gen:')) {
        const name = tag.slice(4);
        const fn = gen[name];
        if (!fn) throw new Error(`docs: неизвестный генератор кода «${name}»`);
        if (body.some((l) => l.trim())) throw new Error(`docs: блок gen:${name} должен быть пустым — код даёт lib/install.ts`);
        cur().push({ kind: 'code', lang: name, code: fn(), gen: name });
      } else {
        cur().push({ kind: 'code', lang: tag || 'text', code: body.join('\n'), gen: null });
      }
      continue;
    }
    const claimOpen = /^:::claim ([a-z0-9-]+)\s*$/.exec(line);
    if (claimOpen) {
      flush();
      if (stack.length > 1) throw new Error('docs: вложенные блоки :::claim не поддерживаются');
      const block: DocBlock = { kind: 'claim', claim: claimOpen[1], blocks: [] };
      root.push(block);
      stack.push(block.blocks);
      continue;
    }
    if (line === ':::') {
      flush();
      if (stack.length === 1) throw new Error('docs: лишний :::');
      stack.pop();
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const h = /^(#{2,3}) (.+)$/.exec(line);
    if (h) {
      flush();
      const text = h[2].trim();
      cur().push({ kind: h[1].length === 2 ? 'h2' : 'h3', text, id: slugify(text) });
      continue;
    }
    if (/^# /.test(line)) throw new Error('docs: h1 — из title вводной части, в тексте его нет');
    const cap = /^Table: (.+)$/.exec(line);
    if (cap) {
      flush();
      caption = cap[1].trim();
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      if (!caption) throw new Error('docs: таблица без подписи (строка «Table: …» перед ней; урок Ф-7)');
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        rows.push(cells);
      }
      i--;
      const [head, ...body] = rows;
      if (!head || body.some((r) => r.length !== head.length)) throw new Error(`docs: таблица «${caption}» — разное число столбцов`);
      cur().push({ kind: 'table', caption, head, rows: body.map((r) => r.map(parseInlineDoc)) });
      caption = null;
      continue;
    }
    if (line.startsWith('> ')) {
      if (para.length || list) flush();
      note.push(line.slice(2).trim());
      continue;
    }
    const li = /^\s*(-|\d+\.) (.+)$/.exec(line);
    if (li && !/^\s{2,}/.test(raw)) {
      const kind = li[1] === '-' ? 'ul' : 'ol';
      if (para.length || note.length || (list && list.kind !== kind)) flush();
      if (!list) list = { kind, items: [] };
      list.items.push(li[2].trim());
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list || note.length) flush();
    para.push(line.trim());
  }
  flush();
  if (stack.length !== 1) throw new Error('docs: незакрытый блок :::claim');
  return { title: meta.title, heading: meta.heading ?? meta.title, description: meta.description, lead: lead ?? [], blocks: root };
}

/** Все блоки вглубь (для проверок). */
export function walkBlocks(blocks: readonly DocBlock[], fn: (b: DocBlock, claim: string | null) => void, claim: string | null = null) {
  for (const b of blocks) {
    fn(b, claim);
    if (b.kind === 'claim') walkBlocks(b.blocks, fn, b.claim);
  }
}

export function inlineText(inline: readonly Inline[]): string {
  return inline.map((x) => x.text).join('');
}
