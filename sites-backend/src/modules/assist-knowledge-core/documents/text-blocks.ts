/**
 * Текст документа → блоки чанкера (`ExtractedBlock`, форма K1 из
 * site-crawl/types.ts) — K3. Чистые функции без сети и без Nest: их
 * зовёт parse.ts для TXT/MD/CSV и для HTML, который отдаёт mammoth (DOCX).
 *
 * Почему свой разбор HTML, а не extractPage обхода (K1): у DOCX нет меню,
 * футера и скрытого текста — эвристики «основного контента» страницы
 * здесь только навредят (выкинули бы короткий документ как «навигацию»).
 */
import { parseDocument as parseHtml } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { textContent } from 'domutils';
import type {
  ExtractedBlock,
  ExtractedBlockType,
} from '../../site-crawl/types';

/** Пробелы схлопнуты, управляющие символы (кроме перевода строки) убраны. */
export function cleanText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/ /g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim()
  );
}

const oneLine = (s: string): string => cleanText(s).replace(/\n+/g, ' ');

/** Стек заголовков: уровень → текст; путь — тексты по возрастанию уровня. */
class HeadingStack {
  private stack: Array<{ level: number; text: string }> = [];

  path(): string[] {
    return this.stack.map((h) => h.text);
  }

  /** Путь ПРЕДКОВ нового заголовка, затем он сам становится вершиной. */
  push(level: number, text: string): string[] {
    this.stack = this.stack.filter((h) => h.level < level);
    const ancestors = this.path();
    this.stack.push({ level, text });
    return ancestors;
  }
}

function block(
  t: ExtractedBlockType,
  text: string,
  path: string[],
  level?: number,
): ExtractedBlock {
  const b: ExtractedBlock = { t, text, path: [...path] };
  if (level !== undefined) b.level = level;
  return b;
}

/** TXT: абзацы — по пустой строке; длинные «стены» строк — по строкам. */
export function blocksFromPlainText(text: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  for (const para of cleanText(text).split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    const lines = p.split('\n');
    // Файл без пустых строк (выгрузка, лог) — иначе один «абзац» на мегабайт.
    if (lines.length > 30) {
      for (const l of lines) if (l.trim()) out.push(block('p', l.trim(), []));
    } else {
      out.push(block('p', lines.join(' '), []));
    }
  }
  return out;
}

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MD_LIST = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function mdInline(s: string): string {
  return oneLine(
    s
      // Картинки и ссылки — только текст: адреса из файла в знания не идут
      // ссылками (их показ — дело ответа, с проверкой источника).
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, ''),
  );
}

function mdRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => mdInline(c));
}

/** «Заголовок: значение; …» — та же форма строки таблицы, что у обхода. */
export function rowText(headers: string[], cells: string[]): string {
  const parts: string[] = [];
  cells.forEach((v, i) => {
    if (!v) return;
    const h = headers[i];
    parts.push(h ? `${h}: ${v}` : v);
  });
  return parts.join('; ');
}

/** MD: заголовки `#` → путь, списки → li, таблицы → tr, код → pre. */
export function blocksFromMarkdown(md: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  const heads = new HeadingStack();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    const text = mdInline(para.join(' '));
    if (text) out.push(block('p', text, heads.path()));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) {
        code.push(lines[i]);
      }
      const text = cleanText(code.join('\n'));
      if (text) out.push(block('pre', text, heads.path()));
      continue;
    }
    const h = MD_HEADING.exec(line);
    if (h) {
      flush();
      const text = mdInline(h[2]);
      if (text) {
        const level = h[1].length;
        out.push(block('h', text, heads.push(level, text), level));
      }
      continue;
    }
    if (line.includes('|') && MD_TABLE_SEP.test(lines[i + 1] ?? '')) {
      flush();
      const headers = mdRow(line);
      for (i += 2; i < lines.length && lines[i].includes('|'); i++) {
        const text = rowText(headers, mdRow(lines[i]));
        if (text) out.push(block('tr', text, heads.path()));
      }
      i--;
      continue;
    }
    const li = MD_LIST.exec(line);
    if (li) {
      flush();
      const text = mdInline(li[1]);
      if (text) out.push(block('li', text, heads.path()));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.replace(/^\s*>\s?/, ''));
  }
  flush();
  return out;
}

/** CSV по RFC 4180: кавычки, переводы строк внутри поля, разделитель , ; или таб. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => firstLine.split(d).length);
  const delim = [',', ';', '\t'][counts.indexOf(Math.max(...counts))];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** CSV: первая строка — заголовки; каждая строка — блок `tr`. */
export function blocksFromCsv(text: string): ExtractedBlock[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(oneLine);
  const body = rows.length > 1 ? rows.slice(1) : rows;
  const out: ExtractedBlock[] = [];
  for (const r of body) {
    const t = rowText(rows.length > 1 ? headers : [], r.map(oneLine));
    if (t) out.push(block('tr', t, []));
  }
  return out;
}

function isElement(n: ChildNode): n is Element {
  return n.type === 'tag' || n.type === 'script' || n.type === 'style';
}

function cellsOf(tr: Element): { cells: string[]; header: boolean } {
  const tds = tr.children.filter(
    (c): c is Element => isElement(c) && (c.name === 'td' || c.name === 'th'),
  );
  return {
    cells: tds.map((td) => oneLine(textContent(td))),
    header: tds.length > 0 && tds.every((td) => td.name === 'th'),
  };
}

/**
 * HTML простого документа (вывод mammoth) → блоки. Скрипты/стили
 * выбрасываются (в DOCX их не бывает, но HTML — это HTML).
 */
export function blocksFromSimpleHtml(html: string): {
  blocks: ExtractedBlock[];
  firstHeading: string | null;
} {
  const doc = parseHtml(html);
  const out: ExtractedBlock[] = [];
  const heads = new HeadingStack();
  let firstHeading: string | null = null;

  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) {
        if (n.type === 'text') {
          const t = oneLine(n.data);
          if (t) out.push(block('p', t, heads.path()));
        }
        continue;
      }
      const name = n.name.toLowerCase();
      if (name === 'script' || name === 'style' || name === 'img') continue;
      const hm = /^h([1-6])$/.exec(name);
      if (hm) {
        const text = oneLine(textContent(n));
        if (text) {
          const level = Number(hm[1]);
          out.push(block('h', text, heads.push(level, text), level));
          firstHeading ??= text;
        }
        continue;
      }
      if (name === 'p' || name === 'li' || name === 'pre') {
        const nested = n.children.some(
          (c) => isElement(c) && (c.name === 'ul' || c.name === 'ol'),
        );
        if (name === 'li' && nested) {
          // Пункт со вложенным списком: свой текст — отдельно, вложенное — рекурсией.
          const own = n.children.filter(
            (c) => !(isElement(c) && (c.name === 'ul' || c.name === 'ol')),
          );
          const text = oneLine(own.map((c) => textContent(c)).join(' '));
          if (text) out.push(block('li', text, heads.path()));
          walk(
            n.children.filter(
              (c) => isElement(c) && (c.name === 'ul' || c.name === 'ol'),
            ),
          );
          continue;
        }
        const text =
          name === 'pre' ? cleanText(textContent(n)) : oneLine(textContent(n));
        if (text)
          out.push(block(name as 'p' | 'li' | 'pre', text, heads.path()));
        continue;
      }
      if (name === 'table') {
        const trs: Element[] = [];
        const collect = (ns: ChildNode[]) => {
          for (const c of ns) {
            if (!isElement(c)) continue;
            if (c.name === 'tr') trs.push(c);
            else if (c.name !== 'table') collect(c.children);
          }
        };
        collect(n.children);
        let headers: string[] = [];
        trs.forEach((tr, idx) => {
          const { cells, header } = cellsOf(tr);
          // Первая строка — заголовки, если она из th или таблица без th вовсе
          // (в DOCX заголовок таблицы — обычная первая строка).
          if (idx === 0 && (header || trs.length > 1)) {
            headers = cells;
            return;
          }
          const text = rowText(headers, cells);
          if (text) out.push(block('tr', text, heads.path()));
        });
        continue;
      }
      walk(n.children);
    }
  };
  walk(doc.children);
  return { blocks: out, firstHeading };
}

/** Язык текста без пакета (как у обхода, контракт Э1 п.10): буквы і/ї/є/ґ, ы/э/ё/ъ. */
export function detectLang(text: string): string | null {
  const sample = text.slice(0, 20_000);
  const uk = (sample.match(/[іїєґІЇЄҐ]/g) ?? []).length;
  const ru = (sample.match(/[ыэёъЫЭЁЪ]/g) ?? []).length;
  const cyr = (sample.match(/[а-яА-ЯёЁіїєґІЇЄҐ]/g) ?? []).length;
  const lat = (sample.match(/[a-zA-Z]/g) ?? []).length;
  if (cyr === 0 && lat === 0) return null;
  if (cyr >= lat) {
    if (uk === 0 && ru === 0) return null;
    return uk >= ru ? 'uk' : 'ru';
  }
  return 'en';
}
