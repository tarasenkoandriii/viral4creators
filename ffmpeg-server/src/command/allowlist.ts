/**
 * Allowlist команд, построенный из корпуса реальных запросов платформы
 * (`test/fixtures/command-corpus.json`, генератор —
 * `backend/src/common/ffmpeg-corpus.ts`). Тест
 * `test/command/allowlist.spec.ts` сверяет: всё, что здесь есть, реально
 * встречается в корпусе (кроме принудительных опций сервиса), и всё, что
 * есть в корпусе, здесь разрешено. Расширять — только вместе с корпусом.
 */

/**
 * Тип значения опции фильтра (FF-SEC-01/02). Проверяется в
 * `command/values.ts` против профиля лимитов.
 *  - file-read / file-write — ссылка по manifest задачи;
 *  - num — число в диапазоне; int — целое в диапазоне;
 *  - dim — сторона кадра: -1/-2 (по пропорции) или 1…max стороны профиля;
 *  - size — `WxH` в пределах профиля; rate — частота ≤ maxFps;
 *  - dur — секунды ≤ maxInputDurationSec; ms — миллисекунды того же
 *    предела; samples — отсчёты при ≤ 192 кГц того же предела;
 *  - expr — выражение FFmpeg из идентификаторов корпуса (`EXPR_IDENTIFIERS`);
 *  - enum — одно из значений корпуса; color — цвет корпуса;
 *  - style — строка force_style; text — произвольный текст drawtext.
 */
export type ValueKind =
  | { kind: 'file-read' }
  | { kind: 'file-write' }
  | { kind: 'num'; min: number; max: number }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'dim' }
  | { kind: 'size' }
  | { kind: 'rate' }
  | { kind: 'dur' }
  | { kind: 'ms' }
  | { kind: 'samples' }
  | { kind: 'expr' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'color' }
  | { kind: 'style' }
  | { kind: 'text' };

export interface FilterSpec {
  /** Допустимые ключи опций (только из корпуса). */
  keys: Readonly<Record<string, ValueKind>>;
  /** Позиционные значения по порядку; больше — отказ. */
  positional: readonly ValueKind[];
  /** Ключи, без которых фильтр не принимается. */
  required?: readonly string[];
}

const num = (min: number, max: number): ValueKind => ({
  kind: 'num',
  min,
  max,
});
const int = (min: number, max: number): ValueKind => ({
  kind: 'int',
  min,
  max,
});
const en = (...values: string[]): ValueKind => ({ kind: 'enum', values });
const DIM: ValueKind = { kind: 'dim' };
const DUR: ValueKind = { kind: 'dur' };
const EXPR: ValueKind = { kind: 'expr' };
const COLOR: ValueKind = { kind: 'color' };

/**
 * Фильтры корпуса и их опции: ключи, позиционные значения и типы — ровно
 * то, что встречается в `test/fixtures/command-corpus.json` (сверяет
 * `test/command/corpus.spec.ts`). Любой другой ключ, в том числе с
 * префиксом `/` (FFmpeg 6.1: «значение из файла»), — отказ.
 */
export const FILTER_SPECS: Readonly<Record<string, FilterSpec>> = {
  adelay: { keys: { all: en('1') }, positional: [{ kind: 'ms' }] },
  aformat: {
    keys: { channel_layouts: en('stereo', 'mono'), sample_fmts: en('fltp') },
    positional: [],
  },
  amix: {
    keys: {
      inputs: int(2, 16),
      duration: en('first'),
      dropout_transition: num(0, 10),
      normalize: en('0'),
    },
    positional: [],
  },
  anull: { keys: {}, positional: [] },
  anullsrc: {
    keys: {
      channel_layout: en('stereo'),
      sample_rate: int(8000, 96000),
      d: DUR,
      r: int(8000, 96000),
      cl: en('stereo'),
    },
    positional: [],
  },
  apad: {
    keys: { whole_dur: DUR, pad_len: { kind: 'samples' } },
    positional: [],
  },
  aresample: { keys: {}, positional: [int(8000, 96000)] },
  asetpts: { keys: {}, positional: [EXPR] },
  asplit: { keys: {}, positional: [int(2, 8)] },
  atempo: { keys: {}, positional: [num(0.5, 2)] },
  atrim: {
    keys: { end_sample: { kind: 'samples' }, duration: DUR },
    positional: [DUR, DUR],
  },
  blackdetect: { keys: { d: DUR, pix_th: num(0, 1) }, positional: [] },
  color: {
    keys: { c: COLOR, s: { kind: 'size' }, r: { kind: 'rate' }, d: DUR },
    positional: [],
    required: ['d'],
  },
  concat: {
    keys: { n: int(1, 64), v: en('0', '1'), a: en('0', '1') },
    positional: [],
  },
  crop: { keys: {}, positional: [EXPR, EXPR, EXPR, EXPR] },
  drawtext: {
    keys: {
      expansion: en('none'),
      text: { kind: 'text' },
      fontsize: EXPR,
      fontcolor: COLOR,
      bordercolor: COLOR,
      borderw: int(0, 20),
      x: EXPR,
      y: EXPR,
    },
    positional: [],
    // Без expansion=none текст исполняет %{…}-выражения: тогда `%` в
    // тексте запрещён (parse.ts, решение FF-INT-05).
    required: ['text'],
  },
  format: { keys: {}, positional: [en('rgba')] },
  fps: { keys: {}, positional: [{ kind: 'rate' }] },
  freezedetect: { keys: { n: num(0, 1), d: DUR }, positional: [] },
  geq: { keys: { r: EXPR, g: EXPR, b: EXPR, a: EXPR }, positional: [] },
  loudnorm: {
    keys: { I: num(-70, -5), TP: num(-9, 0), LRA: num(1, 50) },
    positional: [],
  },
  metadata: {
    keys: { mode: en('print'), file: { kind: 'file-write' } },
    positional: [],
    required: ['mode'],
  },
  overlay: {
    keys: { x: EXPR, y: EXPR, enable: EXPR },
    positional: [EXPR, EXPR],
  },
  pad: { keys: { color: COLOR }, positional: [DIM, DIM, EXPR, EXPR] },
  perspective: {
    keys: {
      x0: EXPR,
      y0: EXPR,
      x1: EXPR,
      y1: EXPR,
      x2: EXPR,
      y2: EXPR,
      x3: EXPR,
      y3: EXPR,
      interpolation: en('cubic'),
      eval: en('frame'),
    },
    positional: [],
  },
  scale: {
    keys: { force_original_aspect_ratio: en('decrease') },
    positional: [DIM, DIM],
  },
  setpts: { keys: {}, positional: [EXPR] },
  setsar: { keys: {}, positional: [en('1')] },
  settb: { keys: {}, positional: [en('AVTB')] },
  sidechaincompress: {
    keys: {
      threshold: num(0.000977, 1),
      ratio: num(1, 20),
      attack: num(0.01, 2000),
      release: num(0.01, 9000),
    },
    positional: [],
  },
  subtitles: {
    keys: { force_style: { kind: 'style' } },
    positional: [{ kind: 'file-read' }],
  },
  tpad: {
    keys: { stop_mode: en('clone'), stop_duration: DUR },
    positional: [],
  },
  trim: { keys: { duration: DUR }, positional: [] },
  volume: { keys: {}, positional: [num(0, 10)] },
  xfade: {
    keys: { transition: en('fade'), duration: DUR, offset: DUR },
    positional: [],
  },
};

/** Фильтры корпуса (имя без `@instance`). */
export const ALLOWED_FILTERS: ReadonlySet<string> = new Set(
  Object.keys(FILTER_SPECS),
);

/**
 * Идентификаторы выражений FFmpeg, встречающиеся в корпусе. Функции
 * `st/ld/while/…` и прочие сюда не входят: выражение — только формы
 * корпуса (FF-SEC-02).
 */
export const EXPR_IDENTIFIERS: ReadonlySet<string> = new Set([
  'H',
  'N',
  'PTS',
  'SR',
  'STARTPTS',
  'TB',
  'W',
  'X',
  'Y',
  'exp',
  'floor',
  'h',
  'ih',
  'in',
  'iw',
  'main_h',
  'main_w',
  'min',
  'oh',
  'out_h',
  'out_w',
  'overlay_h',
  'overlay_w',
  'ow',
  'sgn',
  'sqrt',
  't',
  'th',
  'tw',
  'w',
]);

/**
 * Фильтры, которые без ограничения длительности дают бесконечный поток
 * (FF-SEC-03): допустимы, только если ограничены своей опцией или
 * следующим в цепочке atrim/trim с границей.
 */
export const UNBOUNDED_FILTERS: Readonly<Record<string, readonly string[]>> = {
  anullsrc: ['d'],
  color: ['d'],
  apad: ['whole_dur', 'pad_len'],
};
export const BOUNDING_TRIMS: Readonly<Record<string, readonly string[]>> = {
  atrim: ['end_sample', 'duration', '#1'],
  trim: ['duration'],
};

/** Файловая опция фильтра (из FILTER_SPECS). */
export interface FilterFileSpec {
  key: string | null;
  position: number | null;
  mode: 'read' | 'write';
}

export function filterFileOptions(name: string): FilterFileSpec[] {
  const spec = FILTER_SPECS[name];
  if (!spec) return [];
  const out: FilterFileSpec[] = [];
  for (const [key, v] of Object.entries(spec.keys)) {
    if (v.kind === 'file-read' || v.kind === 'file-write') {
      out.push({
        key,
        position: null,
        mode: v.kind === 'file-read' ? 'read' : 'write',
      });
    }
  }
  spec.positional.forEach((v, i) => {
    if (v.kind === 'file-read' || v.kind === 'file-write') {
      out.push({
        key: null,
        position: i,
        mode: v.kind === 'file-read' ? 'read' : 'write',
      });
    }
  });
  return out;
}

/**
 * Для второй, независимой проверки в executor: фильтры, которые не
 * должны появляться никогда, и ключи файловых опций FFmpeg.
 */
export const DENIED_FILTERS: ReadonlySet<string> = new Set([
  'movie',
  'amovie',
  'sendcmd',
  'asendcmd',
  'zmq',
  'azmq',
  'lv2',
  'ladspa',
  'frei0r',
  'frei0r_src',
  'ass',
]);
export const FILE_OPTION_KEYS: ReadonlySet<string> = new Set([
  'file',
  'filename',
  'f',
  'textfile',
  'fontfile',
  'fontsdir',
]);

/** Энкодеры (значения -c:v / -c:a) корпуса. `copy` — без перекодирования. */
export const ALLOWED_VIDEO_CODECS: ReadonlySet<string> = new Set([
  'libx264',
  'copy',
]);
export const ALLOWED_AUDIO_CODECS: ReadonlySet<string> = new Set([
  'aac',
  'copy',
]);

/** Явный -f выхода (только null-выход детекторов). */
export const ALLOWED_OUTPUT_FORMATS: ReadonlySet<string> = new Set(['null']);

/**
 * Расширения результатов корпуса → muxer, который выберет FFmpeg, и
 * требуемый неявный энкодер (для capability self-test).
 */
export const OUTPUT_EXTENSIONS: Readonly<
  Record<string, { muxer: string; mime: string; media: boolean }>
> = {
  '.mp4': { muxer: 'mp4', mime: 'video/mp4', media: true },
  '.m4a': { muxer: 'ipod', mime: 'audio/mp4', media: true },
  '.jpg': { muxer: 'image2', mime: 'image/jpeg', media: true },
  // Пишет фильтр metadata=print, не muxer.
  '.txt': { muxer: '', mime: 'text/plain; charset=utf-8', media: false },
};

/**
 * Демультиплексоры, которые executor разрешает для `-i`
 * (`-format_whitelist`). Без hls/concat/dash/tee/lavfi/sdp/rtp и прочих,
 * способных открыть другие файлы или сеть.
 */
export const INPUT_DEMUXERS: readonly string[] = [
  'mov',
  'mp4',
  'm4a',
  'matroska',
  'webm',
  'mp3',
  'wav',
  'aac',
  'flac',
  'ogg',
  'image2',
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
];

/** Пресеты libx264. */
export const X264_PRESETS: ReadonlySet<string> = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]);

export const ALLOWED_PIX_FMTS: ReadonlySet<string> = new Set(['yuv420p']);
export const ALLOWED_MOVFLAGS: ReadonlySet<string> = new Set(['+faststart']);

/** Опции CLI. scope: где допустима опция; arity 0/1; specs — суффиксы `:v`. */
export interface CliOptionSpec {
  scope: 'global' | 'input' | 'output' | 'file';
  arity: 0 | 1;
  /** Допустимые stream specifier (`''` — без суффикса). */
  specs: readonly string[];
  /** Опция есть в корпусе (false — добавляется только сервисом). */
  corpus: boolean;
}

export const CLI_OPTIONS: Readonly<Record<string, CliOptionSpec>> = {
  y: { scope: 'global', arity: 0, specs: [''], corpus: false },
  nostdin: { scope: 'global', arity: 0, specs: [''], corpus: false },
  hide_banner: { scope: 'global', arity: 0, specs: [''], corpus: false },
  filter_complex: { scope: 'global', arity: 1, specs: [''], corpus: true },
  filter_threads: { scope: 'global', arity: 1, specs: [''], corpus: false },
  filter_complex_threads: {
    scope: 'global',
    arity: 1,
    specs: [''],
    corpus: false,
  },
  threads: { scope: 'file', arity: 1, specs: [''], corpus: false },
  protocol_whitelist: { scope: 'file', arity: 1, specs: [''], corpus: false },
  format_whitelist: { scope: 'input', arity: 1, specs: [''], corpus: false },
  ss: { scope: 'file', arity: 1, specs: [''], corpus: true },
  t: { scope: 'file', arity: 1, specs: [''], corpus: true },
  loop: { scope: 'input', arity: 1, specs: [''], corpus: true },
  framerate: { scope: 'input', arity: 1, specs: [''], corpus: true },
  stream_loop: { scope: 'input', arity: 1, specs: [''], corpus: true },
  f: { scope: 'output', arity: 1, specs: [''], corpus: true },
  vf: { scope: 'output', arity: 1, specs: [''], corpus: true },
  map: { scope: 'output', arity: 1, specs: [''], corpus: true },
  c: { scope: 'output', arity: 1, specs: ['v', 'a'], corpus: true },
  preset: { scope: 'output', arity: 1, specs: [''], corpus: true },
  crf: { scope: 'output', arity: 1, specs: [''], corpus: true },
  pix_fmt: { scope: 'output', arity: 1, specs: [''], corpus: true },
  b: { scope: 'output', arity: 1, specs: ['a'], corpus: true },
  ar: { scope: 'output', arity: 1, specs: [''], corpus: true },
  r: { scope: 'output', arity: 1, specs: [''], corpus: true },
  movflags: { scope: 'output', arity: 1, specs: [''], corpus: true },
  metadata: { scope: 'output', arity: 1, specs: [''], corpus: true },
  frames: { scope: 'output', arity: 1, specs: ['v'], corpus: true },
  q: { scope: 'output', arity: 1, specs: ['v'], corpus: true },
  vn: { scope: 'output', arity: 0, specs: [''], corpus: true },
  an: { scope: 'output', arity: 0, specs: [''], corpus: true },
  shortest: { scope: 'output', arity: 0, specs: [''], corpus: true },
};

/** Опции, которые клиенту передавать нельзя (их ставит сервис). */
export const SERVICE_ONLY_OPTIONS: ReadonlySet<string> = new Set([
  'protocol_whitelist',
  'format_whitelist',
]);
