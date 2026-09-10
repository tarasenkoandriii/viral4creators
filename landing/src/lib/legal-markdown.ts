/**
 * Крошечный markdown-рендерер под юридические документы (spec §20).
 *
 * Зачем свой: в doc/legal используется ровно пять конструкций —
 * заголовки `#`/`##`, абзацы, списки `-`, цитата `>` и `**жирный**`.
 * Тянуть парсер ради этого не нужно, а собственная функция ещё и
 * тестируется скриптом. Возвращает плоский список блоков — рендер
 * (React) отдельно, поэтому файл переиспользуется лендингом и TMA.
 */

export type LegalBlock =
  | { kind: 'h1'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'note'; text: string };

/** «**жирный**» → отрезки; всё остальное — обычный текст. */
export interface InlineSpan {
  text: string;
  bold: boolean;
}

export function parseInline(text: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index), bold: false });
    }
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out.length > 0 ? out : [{ text: '', bold: false }];
}

/** Markdown → блоки. Мягкие переносы внутри абзаца склеиваются пробелом. */
export function parseLegalMarkdown(md: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: string[] = [];
  let note: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ').trim() });
    para = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: 'ul', items: list });
    list = [];
  };
  const flushNote = () => {
    if (note.length) blocks.push({ kind: 'note', text: note.join(' ').trim() });
    note = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushNote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushAll();
      continue;
    }
    if (line.startsWith('## ')) {
      flushAll();
      blocks.push({ kind: 'h2', text: line.slice(3).trim() });
      continue;
    }
    if (line.startsWith('# ')) {
      flushAll();
      blocks.push({ kind: 'h1', text: line.slice(2).trim() });
      continue;
    }
    if (line.startsWith('> ')) {
      flushPara();
      flushList();
      note.push(line.slice(2).trim());
      continue;
    }
    if (/^[-*] /.test(line.trim())) {
      flushPara();
      flushNote();
      list.push(line.trim().slice(2).trim());
      continue;
    }
    // продолжение пункта списка (перенос строки с отступом)
    if (list.length > 0 && /^\s{2,}\S/.test(raw)) {
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    flushNote();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}
