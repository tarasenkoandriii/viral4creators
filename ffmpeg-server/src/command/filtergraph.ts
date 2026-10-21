/**
 * Разбор строки фильтрграфа так же, как это делает libavfilter
 * (graphparser.c + av_get_token + process_options, FFmpeg 6.1), без
 * исполнения. Нужен для проверки имён фильтров по allowlist и для
 * контекстной подстановки путей в файловые опции (`subtitles=…`,
 * `metadata=…:file=…`).
 *
 * Два уровня экранирования, как в FFmpeg:
 *  1) уровень графа: `av_get_token(buf, "[],;")` снимает `\x` и '…';
 *  2) уровень опций: `av_get_token(args, ":")` после `key=` снимает их
 *     ещё раз.
 */

const WS = ' \n\t\r';

/** Точная копия av_get_token(): снимает один уровень `\` и '…'. */
export function avGetToken(
  buf: string,
  pos: number,
  term: string,
): { value: string; pos: number } {
  let p = pos;
  while (p < buf.length && WS.includes(buf[p])) p++;
  let out = '';
  // `end` — длина вывода, которую нельзя срезать как хвостовые пробелы.
  let end = 0;
  while (p < buf.length && !term.includes(buf[p])) {
    const c = buf[p++];
    if (c === '\\' && p < buf.length) {
      out += buf[p++];
      end = out.length;
    } else if (c === "'") {
      while (p < buf.length && buf[p] !== "'") out += buf[p++];
      if (p < buf.length) {
        p++;
        end = out.length;
      }
    } else {
      out += c;
    }
  }
  let len = out.length;
  while (len > end && WS.includes(out[len - 1])) len--;
  return { value: out.slice(0, len), pos: p };
}

export interface ParsedOption {
  /** Явный ключ или null — позиционное значение (implicit key). */
  key: string | null;
  /** Номер позиционного значения среди позиционных (0-based). */
  position: number | null;
  value: string;
}

export interface ParsedFilter {
  /** Имя без `@instance`. */
  name: string;
  instance: string | null;
  /** Аргументы после первого уровня unescape (null — без `=`). */
  args: string | null;
  options: ParsedOption[];
  inputs: string[];
  outputs: string[];
  /** Номер цепочки (`;`) и позиция фильтра в ней (`,`). */
  chain: number;
  position: number;
}

export type FiltergraphResult =
  { ok: true; filters: ParsedFilter[] } | { ok: false; message: string };

function isKeyChar(c: string): boolean {
  return /[A-Za-z0-9_./-]/.test(c);
}

/** process_options/av_opt_get_key_value: `k=v:k=v:позиционное`. */
export function parseFilterOptions(args: string): ParsedOption[] {
  const out: ParsedOption[] = [];
  let p = 0;
  let positional = 0;
  while (p < args.length) {
    // get_key: [A-Za-z0-9_./-]+ сразу перед '='.
    let k = p;
    while (k < args.length && isKeyChar(args[k])) k++;
    if (k > p && args[k] === '=') {
      const key = args.slice(p, k);
      const t = avGetToken(args, k + 1, ':');
      out.push({ key, position: null, value: t.value });
      p = t.pos;
    } else {
      const t = avGetToken(args, p, ':');
      out.push({ key: null, position: positional++, value: t.value });
      p = t.pos;
    }
    if (args[p] === ':') p++;
  }
  return out;
}

function skipWs(s: string, p: number): number {
  while (p < s.length && WS.includes(s[p])) p++;
  return p;
}

function parseLabels(
  s: string,
  pos: number,
): { labels: string[]; pos: number } | { error: string } {
  const labels: string[] = [];
  let p = pos;
  while (s[p] === '[') {
    const t = avGetToken(s, p + 1, ']');
    if (s[t.pos] !== ']') return { error: 'unterminated link label' };
    if (!t.value) return { error: 'empty link label' };
    labels.push(t.value);
    p = skipWs(s, t.pos + 1);
  }
  return { labels, pos: p };
}

export function parseFiltergraph(graph: string): FiltergraphResult {
  const filters: ParsedFilter[] = [];
  let p = skipWs(graph, 0);
  if (p >= graph.length) return { ok: false, message: 'empty filtergraph' };
  let chain = 0;
  for (;;) {
    // Одна цепочка: filter (',' filter)*
    let position = 0;
    for (;;) {
      const ins = parseLabels(graph, p);
      if ('error' in ins) return { ok: false, message: ins.error };
      p = ins.pos;
      const nameTok = avGetToken(graph, p, '=,;[');
      p = nameTok.pos;
      if (!nameTok.value) return { ok: false, message: 'missing filter name' };
      const at = nameTok.value.indexOf('@');
      const name = at >= 0 ? nameTok.value.slice(0, at) : nameTok.value;
      const instance = at >= 0 ? nameTok.value.slice(at + 1) : null;
      let args: string | null = null;
      if (graph[p] === '=') {
        const a = avGetToken(graph, p + 1, '[],;');
        args = a.value;
        p = a.pos;
      }
      const outs = parseLabels(graph, p);
      if ('error' in outs) return { ok: false, message: outs.error };
      p = skipWs(graph, outs.pos);
      filters.push({
        name,
        instance,
        args,
        options: args === null ? [] : parseFilterOptions(args),
        inputs: ins.labels,
        outputs: outs.labels,
        chain,
        position: position++,
      });
      if (graph[p] === ',') {
        p = skipWs(graph, p + 1);
        continue;
      }
      break;
    }
    if (p >= graph.length) break;
    if (graph[p] === ';') {
      chain++;
      p = skipWs(graph, p + 1);
      if (p >= graph.length) break;
      continue;
    }
    return {
      ok: false,
      message: `unexpected "${graph[p]}" in filtergraph`,
    };
  }
  return { ok: true, filters };
}
