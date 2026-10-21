/**
 * parseJob — проверка и разбор тела POST /api/ffmpeg в план исполнения
 * (ТЗ §6). Строки не исполняются: shell-подобная токенизация, удаление
 * ведущего `ffmpeg`, разбор опций CLI и фильтрграфа, подстановка путей
 * только в разобранных аргументах и только в известных контекстах
 * (`-i`, позиция выхода, файловые опции фильтров).
 *
 * Пути внутри каталога попытки (cwd ffmpeg):
 *   inputs/<ключ>[.ext]  — скачанные входы (расширение — из пути URL);
 *   outputs/<имя>        — объявленные результаты;
 *   work/<имя>           — промежуточные файлы цепочки (не выдаются).
 */
import type {
  ExecPlan,
  JobRequestBody,
  LimitsProfile,
  ParseResult,
} from '../contracts';
import { tokenize } from './tokenize';
import { parseFiltergraph } from './filtergraph';
import {
  DEFAULT_VALUE_LIMITS,
  ValueLimits,
  checkValue as checkFilterValue,
  frameFits,
} from './values';
import {
  ALLOWED_AUDIO_CODECS,
  ALLOWED_FILTERS,
  ALLOWED_MOVFLAGS,
  ALLOWED_OUTPUT_FORMATS,
  ALLOWED_PIX_FMTS,
  ALLOWED_VIDEO_CODECS,
  BOUNDING_TRIMS,
  CLI_OPTIONS,
  FILTER_SPECS,
  INPUT_DEMUXERS,
  UNBOUNDED_FILTERS,
  filterFileOptions,
  OUTPUT_EXTENSIONS,
  SERVICE_ONLY_OPTIONS,
  X264_PRESETS,
} from './allowlist';

export const INPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLACEHOLDER = /^\{\{([^{}]*)\}\}$/;
const MAX_URL_LENGTH = 4096;

export type ParseLimits = Pick<
  LimitsProfile,
  | 'maxInputs'
  | 'maxCommands'
  | 'maxOutputs'
  | 'maxCommandsTextBytes'
  | 'maxThreads'
> &
  Partial<ValueLimits>;

class Reject extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'UNSUPPORTED_COMMAND',
    message: string,
  ) {
    super(message);
  }
}

const invalid = (m: string) => new Reject('INVALID_REQUEST', m);
const unsupported = (m: string) => new Reject('UNSUPPORTED_COMMAND', m);

function extFromUrl(url: string): string {
  try {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname);
    return m ? `.${m[1].toLowerCase()}` : '';
  } catch {
    return '';
  }
}

function extOf(name: string): string {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(name);
  return m ? m[0].toLowerCase() : '';
}

interface Ctx {
  inputs: Map<string, string>; // key → inputs/...
  declaredOutputs: Set<string>;
  /** Файлы, созданные прежними шагами: имя → путь. */
  produced: Map<string, string>;
  intermediates: Set<string>;
  maxThreads: number;
  limits: ValueLimits;
}

interface StepState {
  /** Файлы, которые пишет текущий шаг: имя → путь. */
  writes: Map<string, string>;
}

/** Ссылка на файл в известном контексте → путь в workspace; null — не ссылка. */
function resolveRef(
  raw: string,
  mode: 'read' | 'write',
  ctx: Ctx,
  step: StepState,
): string | null {
  const ph = PLACEHOLDER.exec(raw);
  let name: string;
  let kind: 'any' | 'inputs' | 'outputs';
  if (ph) {
    name = ph[1];
    kind = 'any';
  } else if (raw.startsWith('inputs/')) {
    name = raw.slice('inputs/'.length);
    kind = 'inputs';
  } else if (raw.startsWith('outputs/')) {
    name = raw.slice('outputs/'.length);
    kind = 'outputs';
  } else {
    return null;
  }
  if (!OUTPUT_NAME_PATTERN.test(name)) {
    throw unsupported(`invalid file reference "${raw}"`);
  }
  if (mode === 'read') {
    if (kind !== 'outputs' && ctx.inputs.has(name)) {
      return ctx.inputs.get(name)!;
    }
    if (kind === 'inputs') throw unsupported(`unknown input "${raw}"`);
    const produced = ctx.produced.get(name);
    if (produced) return produced;
    if (step.writes.has(name)) {
      throw unsupported(`"${raw}" is read by the same command that writes it`);
    }
    throw unsupported(
      `"${raw}" is neither an input nor a result of a previous command`,
    );
  }
  // write
  if (kind === 'inputs' || ctx.inputs.has(name)) {
    throw unsupported(`command writes to input "${raw}"`);
  }
  if (ctx.produced.has(name) || step.writes.has(name)) {
    throw unsupported(`file "${name}" is written twice`);
  }
  const target = ctx.declaredOutputs.has(name)
    ? `outputs/${name}`
    : `work/${name}`;
  step.writes.set(name, target);
  return target;
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Проверка фильтрграфа и контекстная подстановка путей в файловые опции.
 * Возвращает строку графа с подставленными путями.
 */
function processGraph(graph: string, ctx: Ctx, step: StepState): string {
  const parsed = parseFiltergraph(graph);
  if (!parsed.ok) throw unsupported(`filtergraph: ${parsed.message}`);
  const substitutions: Array<{ raw: string; path: string }> = [];
  const expected: string[] = [];
  for (const f of parsed.filters) {
    const spec = FILTER_SPECS[f.name];
    if (!spec || !ALLOWED_FILTERS.has(f.name)) {
      throw unsupported(`filter "${f.name}" is not allowed`);
    }
    if (f.instance !== null && !/^[A-Za-z0-9_]{1,32}$/.test(f.instance)) {
      throw unsupported(`invalid filter instance "${f.name}@${f.instance}"`);
    }
    const seen = new Set<string>();
    for (const o of f.options) {
      // FF-SEC-01: `/key=` в FFmpeg 6.1 читает значение опции из файла.
      if (o.key !== null && o.key.startsWith('/')) {
        throw unsupported(
          `option "${o.key}" of filter "${f.name}" loads a file and is not allowed`,
        );
      }
      const kind =
        o.key !== null ? spec.keys[o.key] : spec.positional[o.position!];
      if (!kind || (o.key !== null && !Object.hasOwn(spec.keys, o.key))) {
        throw unsupported(
          o.key !== null
            ? `option "${o.key}" of filter "${f.name}" is not allowed`
            : `too many positional options for "${f.name}"`,
        );
      }
      const name = o.key ?? `#${o.position}`;
      if (seen.has(name)) {
        throw unsupported(`option "${name}" of "${f.name}" is repeated`);
      }
      seen.add(name);
      if (kind.kind === 'file-read' || kind.kind === 'file-write') {
        const mode = kind.kind === 'file-read' ? 'read' : 'write';
        const target = resolveRef(o.value, mode, ctx, step);
        if (target === null) {
          throw unsupported(
            `file option of "${f.name}" must reference {{name}}, inputs/ or outputs/`,
          );
        }
        if (mode === 'write' && extOf(target) !== '.txt') {
          throw unsupported(`"${f.name}" may only write .txt results`);
        }
        substitutions.push({ raw: o.value, path: target });
        expected.push(target);
        continue;
      }
      if (/\{\{|\}\}/.test(o.value)) {
        throw unsupported(
          `placeholder outside a file option in filter "${f.name}"`,
        );
      }
      const problem = checkFilterValue(kind, o.value, ctx.limits);
      if (problem) {
        throw unsupported(`filter "${f.name}" option "${name}": ${problem}`);
      }
    }
    // FF-INT-05: обычный водяной знак остаётся байт-в-байт как у hosted
    // (без expansion), пока в тексте нет `%`; с `%` — только expansion=none.
    if (f.name === 'drawtext') {
      const expansion = f.options.find((o) => o.key === 'expansion')?.value;
      const text = f.options.find((o) => o.key === 'text')?.value ?? '';
      if (expansion !== 'none' && text.includes('%')) {
        throw unsupported(
          'drawtext text with "%" requires expansion=none (text expansion)',
        );
      }
    }
    for (const req of spec.required ?? []) {
      if (!seen.has(req)) {
        throw unsupported(`filter "${f.name}" requires option "${req}"`);
      }
    }
    for (const ff of filterFileOptions(f.name)) {
      const n = ff.key ?? `#${ff.position}`;
      if (f.name === 'subtitles' && !seen.has(n)) {
        throw unsupported(
          'filter "subtitles" needs exactly one file reference',
        );
      }
    }
    // Кадр scale/pad: обе стороны числом → кадр в пределах профиля.
    if (f.name === 'scale' || f.name === 'pad') {
      const w = Number(f.options.find((o) => o.position === 0)?.value);
      const h = Number(f.options.find((o) => o.position === 1)?.value);
      if (w > 0 && h > 0 && !frameFits(w, h, ctx.limits)) {
        throw unsupported(`filter "${f.name}": frame size exceeds the profile`);
      }
      if (
        f.options.filter((o) => o.position === 0 || o.position === 1).length !==
        2
      ) {
        throw unsupported(`filter "${f.name}" needs explicit width and height`);
      }
    }
    // FF-SEC-03: бесконечный источник ограничен своей опцией или
    // следующим в цепочке atrim/trim с границей.
    const bounds = UNBOUNDED_FILTERS[f.name];
    if (bounds && !bounds.some((k) => seen.has(k))) {
      const next = parsed.filters.find(
        (g) => g.chain === f.chain && g.position === f.position + 1,
      );
      const trimKeys = next ? BOUNDING_TRIMS[next.name] : undefined;
      const bounded =
        !!next &&
        !!trimKeys &&
        next.options.some((o) => trimKeys.includes(o.key ?? `#${o.position}`));
      if (!bounded) {
        throw unsupported(
          `filter "${f.name}" produces an endless stream without a duration bound`,
        );
      }
    }
  }
  // Сырая строка обязана содержать каждую ссылку ровно столько раз,
  // сколько её нашёл разбор: иначе ссылка была «спрятана» экранированием
  // или встречается вне файловой опции — неоднозначно.
  const rawCounts = new Map<string, number>();
  for (const s of substitutions) {
    rawCounts.set(s.raw, (rawCounts.get(s.raw) ?? 0) + 1);
  }
  const placeholderUses = substitutions.filter((s) =>
    PLACEHOLDER.test(s.raw),
  ).length;
  if (countOccurrences(graph, '{{') !== placeholderUses) {
    throw unsupported('ambiguous placeholder in filtergraph');
  }
  let out = graph;
  for (const [raw, count] of rawCounts) {
    if (countOccurrences(graph, raw) !== count) {
      throw unsupported(`ambiguous file reference "${raw}" in filtergraph`);
    }
    const target = substitutions.find((s) => s.raw === raw)!.path;
    out = out.split(raw).join(target);
  }
  // Повторный разбор: файловые опции теперь — ровно ожидаемые пути.
  const check = parseFiltergraph(out);
  if (!check.ok) throw unsupported('filtergraph changed after substitution');
  const got: string[] = [];
  for (const f of check.filters) {
    const specs = filterFileOptions(f.name);
    for (const o of f.options) {
      if (
        specs.some((sp) =>
          o.key !== null ? sp.key === o.key : sp.position === o.position,
        )
      ) {
        got.push(o.value);
      }
    }
  }
  if (got.join('\u0000') !== expected.join('\u0000') || out.includes('{{')) {
    throw unsupported('filtergraph substitution mismatch');
  }
  return out;
}

const RE = {
  time: /^(\d{1,6}(\.\d{1,6})?|\d{1,2}:\d{2}:\d{2}(\.\d{1,6})?)$/,
  rate: /^\d{1,4}(\.\d{1,6})?(\/\d{1,6})?$/,
  loop: /^(0|1|-1)$/,
  streamLoop: /^(-1|\d{1,4})$/,
  map: /^(\[[A-Za-z0-9_]{1,64}\]|\d{1,3}(:[vas](:\d{1,3})?)?\??)$/,
  crf: /^\d{1,2}(\.\d{1,3})?$/,
  bitrate: /^\d{1,6}k?$/,
  ar: /^\d{4,6}$/,
  uint: /^\d{1,9}$/,
  metadata: /^[a-z_]{1,32}=[A-Za-z0-9 _=;:.,()/-]{0,200}$/,
};

/** Секунды из `-t`/`-ss` (SS или HH:MM:SS[.ms]). */
function timeSeconds(v: string): number {
  const m = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(v);
}

function checkValue(
  base: string,
  spec: string,
  v: string,
  limits: ValueLimits,
): void {
  const bad = () =>
    unsupported(`invalid value for -${base}${spec ? `:${spec}` : ''}`);
  switch (base) {
    case 'ss':
    case 't':
      if (!RE.time.test(v)) throw bad();
      // FF-SEC-03: не длиннее профиля.
      if (timeSeconds(v) > limits.maxInputDurationSec) {
        throw unsupported(`-${base} exceeds ${limits.maxInputDurationSec} s`);
      }
      return;
    case 'loop':
      if (!RE.loop.test(v)) throw bad();
      return;
    case 'stream_loop':
      if (!RE.streamLoop.test(v)) throw bad();
      return;
    case 'framerate':
    case 'r': {
      if (!RE.rate.test(v)) throw bad();
      const [a, b] = v.split('/');
      const rate = Number(a) / (b ? Number(b) : 1);
      if (!(rate > 0) || rate > limits.maxFps) {
        throw unsupported(`-${base} exceeds ${limits.maxFps} fps`);
      }
      return;
    }
    case 'map':
      if (!RE.map.test(v)) throw bad();
      return;
    case 'c': {
      const set = spec === 'v' ? ALLOWED_VIDEO_CODECS : ALLOWED_AUDIO_CODECS;
      if (!set.has(v)) throw unsupported(`codec "${v}" is not allowed`);
      return;
    }
    case 'preset':
      if (!X264_PRESETS.has(v)) throw bad();
      return;
    case 'crf':
      if (!RE.crf.test(v) || Number(v) > 51) throw bad();
      return;
    case 'pix_fmt':
      if (!ALLOWED_PIX_FMTS.has(v)) throw bad();
      return;
    case 'b':
      if (!RE.bitrate.test(v)) throw bad();
      return;
    case 'ar':
      if (!RE.ar.test(v) || Number(v) < 8000 || Number(v) > 96000) throw bad();
      return;
    case 'movflags':
      if (!ALLOWED_MOVFLAGS.has(v)) throw bad();
      return;
    case 'metadata':
      if (!RE.metadata.test(v)) throw bad();
      return;
    case 'frames':
      if (!RE.uint.test(v)) throw bad();
      return;
    case 'q':
      if (!RE.uint.test(v) || Number(v) < 1 || Number(v) > 31) throw bad();
      return;
    case 'f':
      if (!ALLOWED_OUTPUT_FORMATS.has(v)) {
        throw unsupported(`output format "${v}" is not allowed`);
      }
      return;
    case 'threads':
    case 'filter_threads':
    case 'filter_complex_threads':
      if (!RE.uint.test(v)) throw bad();
      return;
    default:
      return;
  }
}

interface FileGroup {
  opts: Array<{ name: string; value: string | null }>;
  path: string;
}

function clampThreads(v: string, max: number): string {
  const n = Number(v);
  return String(n <= 0 || n > max ? max : n);
}

const BINARY_NAMES = /^(ffprobe|ffplay|sh|bash|env|sudo|exec|nice|timeout)$/;

function parseCommand(
  command: string,
  ctx: Ctx,
): { argv: string[]; writes: Map<string, string> } {
  const tok = tokenize(command);
  if (!tok.ok) throw unsupported(`command syntax: ${tok.message}`);
  const tokens = tok.tokens;
  if (tokens[0] === 'ffmpeg') tokens.shift();
  if (tokens.length === 0) throw unsupported('empty command');
  if (BINARY_NAMES.test(tokens[0]) || tokens[0].includes('/ffmpeg')) {
    throw unsupported('only ffmpeg commands are accepted');
  }
  const step: StepState = { writes: new Map() };
  const globals: Array<{ name: string; value: string | null }> = [];
  const inputs: FileGroup[] = [];
  const outputs: FileGroup[] = [];
  let pending: Array<{ name: string; value: string | null }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-') && t !== '-') {
      const opt = t.slice(1);
      const colon = opt.indexOf(':');
      const base = colon >= 0 ? opt.slice(0, colon) : opt;
      const spec = colon >= 0 ? opt.slice(colon + 1) : '';
      if (base === 'i') {
        if (spec) throw unsupported('invalid -i');
        const v = tokens[++i];
        if (v === undefined) throw unsupported('-i without a file');
        const path = resolveRef(v, 'read', ctx, step);
        if (path === null) {
          throw unsupported(
            /^[a-z][a-z0-9+.-]*:/i.test(v)
              ? 'URLs and protocols are not allowed in -i'
              : `-i must reference {{key}}, inputs/ or outputs/ (got "${v.slice(0, 40)}")`,
          );
        }
        inputs.push({ opts: pending, path });
        pending = [];
        continue;
      }
      const def = CLI_OPTIONS[base];
      if (!def || SERVICE_ONLY_OPTIONS.has(base)) {
        throw unsupported(`option -${opt} is not allowed`);
      }
      if (!def.specs.includes(spec)) {
        throw unsupported(`option -${opt} is not allowed`);
      }
      let value: string | null = null;
      if (def.arity === 1) {
        const v = tokens[++i];
        if (v === undefined) throw unsupported(`-${opt} without a value`);
        value = v;
      }
      const name = spec ? `${base}:${spec}` : base;
      if (def.scope === 'global') {
        if (base === 'filter_complex') {
          value = processGraph(value!, ctx, step);
        } else if (value !== null) {
          checkValue(base, spec, value, ctx.limits);
          if (base === 'filter_threads' || base === 'filter_complex_threads') {
            value = clampThreads(value, ctx.maxThreads);
          }
        }
        globals.push({ name, value });
        continue;
      }
      if (base === 'vf') {
        value = processGraph(value!, ctx, step);
      } else if (value !== null) {
        checkValue(base, spec, value, ctx.limits);
        if (base === 'threads') value = clampThreads(value, ctx.maxThreads);
      }
      pending.push({ name, value });
      continue;
    }
    // Позиционный токен — файл результата.
    let path: string | null;
    if (t === '-') {
      const fmt = pending.find((o) => o.name === 'f');
      if (fmt?.value !== 'null') {
        throw unsupported('"-" output is allowed only with -f null');
      }
      path = '-';
    } else {
      path = resolveRef(t, 'write', ctx, step);
      if (path === null) {
        throw unsupported(
          `output must be {{name}} or outputs/name (got "${t.slice(0, 40)}")`,
        );
      }
      const ext = extOf(path);
      if (!OUTPUT_EXTENSIONS[ext]?.media) {
        throw unsupported(
          `output extension "${ext || '(none)'}" is not allowed`,
        );
      }
    }
    for (const o of pending) {
      const def = CLI_OPTIONS[o.name.split(':')[0]];
      if (def.scope === 'input') {
        throw unsupported(`input option -${o.name} placed before an output`);
      }
    }
    outputs.push({ opts: pending, path });
    pending = [];
  }
  if (pending.length > 0) {
    throw unsupported(
      `trailing option(s) without a file: ${pending.map((o) => `-${o.name}`).join(' ')}`,
    );
  }
  if (outputs.length === 0) throw unsupported('command has no output');
  // FF-SEC-03: зацикленный вход (`-loop 1`, `-stream_loop` ≠ 0) — только с
  // конечной длительностью: `-t` у самого входа или `-t`/`-frames:v` у
  // каждого выхода команды (значения уже ограничены профилем).
  const looped = inputs.some((g) =>
    g.opts.some(
      (o) =>
        (o.name === 'loop' && o.value !== '0') ||
        (o.name === 'stream_loop' && o.value !== '0'),
    ),
  );
  if (looped) {
    const outputsBounded = outputs.every((g) =>
      g.opts.some((o) => o.name === 't' || o.name === 'frames:v'),
    );
    for (const g of inputs) {
      const loops = g.opts.some(
        (o) =>
          (o.name === 'loop' || o.name === 'stream_loop') && o.value !== '0',
      );
      if (loops && !outputsBounded && !g.opts.some((o) => o.name === 't')) {
        throw unsupported(
          'looped input needs -t on the input or -t/-frames:v on every output',
        );
      }
    }
  }
  for (const g of inputs) {
    for (const o of g.opts) {
      const def = CLI_OPTIONS[o.name.split(':')[0]];
      if (def.scope === 'output') {
        throw unsupported(`output option -${o.name} placed before -i`);
      }
    }
  }

  // Сборка argv: принудительные опции без конфликта с заданными.
  const max = String(ctx.maxThreads);
  const argv: string[] = ['-nostdin', '-hide_banner', '-y'];
  const hasGlobal = (n: string) => globals.some((g) => g.name === n);
  if (!hasGlobal('filter_threads')) argv.push('-filter_threads', max);
  if (!hasGlobal('filter_complex_threads')) {
    argv.push('-filter_complex_threads', max);
  }
  for (const g of globals) {
    if (g.name === 'y' || g.name === 'nostdin' || g.name === 'hide_banner') {
      continue;
    }
    argv.push(`-${g.name}`);
    if (g.value !== null) argv.push(g.value);
  }
  const pushOpts = (opts: FileGroup['opts']) => {
    for (const o of opts) {
      argv.push(`-${o.name}`);
      if (o.value !== null) argv.push(o.value);
    }
  };
  const demuxers = INPUT_DEMUXERS.join(',');
  for (const g of inputs) {
    if (!g.opts.some((o) => o.name === 'threads')) argv.push('-threads', max);
    argv.push('-protocol_whitelist', 'file,pipe');
    argv.push('-format_whitelist', demuxers);
    pushOpts(g.opts);
    argv.push('-i', g.path);
  }
  for (const g of outputs) {
    if (!g.opts.some((o) => o.name === 'threads')) argv.push('-threads', max);
    argv.push('-protocol_whitelist', 'file,pipe');
    pushOpts(g.opts);
    argv.push(g.path);
  }
  return { argv, writes: step.writes };
}

export function parseJob(
  body: JobRequestBody,
  limits: ParseLimits,
): ParseResult {
  try {
    return { ok: true, plan: buildPlan(body, limits) };
  } catch (e) {
    if (e instanceof Reject)
      return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

function buildPlan(body: JobRequestBody, limits: ParseLimits): ExecPlan {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body must be an object');
  }
  const allowed = new Set(['input_files', 'output_files', 'ffmpeg_commands']);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw invalid(`unknown field "${k}"`);
  }
  const { input_files, output_files, ffmpeg_commands } = body;
  if (
    !input_files ||
    typeof input_files !== 'object' ||
    Array.isArray(input_files)
  ) {
    throw invalid('input_files must be an object');
  }
  if (!Array.isArray(output_files) || !Array.isArray(ffmpeg_commands)) {
    throw invalid('output_files and ffmpeg_commands must be arrays');
  }
  const inputEntries = Object.entries(input_files);
  if (inputEntries.length > limits.maxInputs) {
    throw invalid(`too many inputs (max ${limits.maxInputs})`);
  }
  if (output_files.length < 1 || output_files.length > limits.maxOutputs) {
    throw invalid(`output_files must have 1..${limits.maxOutputs} items`);
  }
  if (
    ffmpeg_commands.length < 1 ||
    ffmpeg_commands.length > limits.maxCommands
  ) {
    throw invalid(`ffmpeg_commands must have 1..${limits.maxCommands} items`);
  }
  let textBytes = 0;
  for (const c of ffmpeg_commands) {
    if (typeof c !== 'string' || c.trim() === '') {
      throw invalid('each command must be a non-empty string');
    }
    textBytes += Buffer.byteLength(c, 'utf8');
  }
  if (textBytes > limits.maxCommandsTextBytes) {
    throw invalid('commands text is too large');
  }

  const inputs: ExecPlan['inputs'] = [];
  const inputMap = new Map<string, string>();
  const localNames = new Set<string>();
  for (const [key, url] of inputEntries) {
    if (!INPUT_KEY_PATTERN.test(key))
      throw invalid(`invalid input key "${key.slice(0, 64)}"`);
    if (
      typeof url !== 'string' ||
      url.length === 0 ||
      url.length > MAX_URL_LENGTH
    ) {
      throw invalid(`input "${key}" must be a URL string`);
    }
    try {
      new URL(url);
    } catch {
      throw invalid(`input "${key}" is not a valid URL`);
    }
    const localName = `inputs/${key}${extOf(key) ? '' : extFromUrl(url)}`;
    if (localNames.has(localName)) {
      throw invalid(`input "${key}" collides with another input`);
    }
    localNames.add(localName);
    inputMap.set(key, localName);
    inputs.push({ key, url, localName });
  }

  const declared = new Set<string>();
  const outputs: ExecPlan['outputs'] = [];
  for (const name of output_files) {
    if (typeof name !== 'string' || !OUTPUT_NAME_PATTERN.test(name)) {
      throw invalid('invalid output file name');
    }
    if (declared.has(name)) throw invalid(`duplicate output "${name}"`);
    if (inputMap.has(name)) {
      throw invalid(`"${name}" is both an input and an output`);
    }
    if (!OUTPUT_EXTENSIONS[extOf(name)]) {
      throw unsupported(`output type of "${name}" is not supported`);
    }
    declared.add(name);
    outputs.push({ name, localName: `outputs/${name}` });
  }

  const ctx: Ctx = {
    inputs: inputMap,
    declaredOutputs: declared,
    produced: new Map(),
    intermediates: new Set(),
    maxThreads: Math.max(1, Math.floor(limits.maxThreads)),
    limits: {
      maxWidth: limits.maxWidth ?? DEFAULT_VALUE_LIMITS.maxWidth,
      maxHeight: limits.maxHeight ?? DEFAULT_VALUE_LIMITS.maxHeight,
      maxImagePixels:
        limits.maxImagePixels ?? DEFAULT_VALUE_LIMITS.maxImagePixels,
      maxFps: limits.maxFps ?? DEFAULT_VALUE_LIMITS.maxFps,
      maxInputDurationSec:
        limits.maxInputDurationSec ?? DEFAULT_VALUE_LIMITS.maxInputDurationSec,
    },
  };
  const steps: ExecPlan['steps'] = [];
  ffmpeg_commands.forEach((command, idx) => {
    let res;
    try {
      res = parseCommand(command, ctx);
    } catch (e) {
      if (e instanceof Reject) {
        throw new Reject(e.code, `command ${idx + 1}: ${e.message}`);
      }
      throw e;
    }
    for (const [name, path] of res.writes) {
      ctx.produced.set(name, path);
      if (path.startsWith('work/')) ctx.intermediates.add(path);
    }
    steps.push({ argv: res.argv });
  });
  for (const name of declared) {
    if (!ctx.produced.has(name)) {
      throw invalid(`output "${name}" is not produced by any command`);
    }
  }
  return {
    inputs,
    outputs,
    steps,
    intermediates: [...ctx.intermediates],
  };
}
