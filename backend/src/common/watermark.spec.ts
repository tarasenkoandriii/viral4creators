/**
 * Экранирование текста водяного знака (`escapeDrawtext`): текст на кадре
 * ровно исходный, а строка команды проходит shell-подобный разбор
 * собственного ffmpeg-server без 422 (`$`, обратная кавычка).
 *
 * Уровни разбираются здесь независимой моделью: двойные кавычки sh →
 * `av_get_token` графа → `av_get_token` опций; `expansion=none` снимает
 * третий уровень (`%`, `\` у drawtext). Если в окружении есть ffmpeg —
 * дополнительно рендер против `textfile` (побайтовое совпадение кадра).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWatermarkPlan,
  DRAWTEXT_SPECIAL,
  escapeDrawtext,
  WatermarkIntensityValue,
} from './watermark';

/** Генератор origin/main дословно — эталон для обычных текстов (FF-INT-05). */
function legacyPlan(text: string, intensity: WatermarkIntensityValue) {
  const esc = text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/"/g, '\\"');
  const params = {
    SLIGHT: {
      positions: [{ x: 'w-tw-20', y: 'h-th-20' }],
      fontsizeExpr: 'h/22',
      opacity: 0.32,
    },
    STANDARD: {
      positions: [{ x: '(w-tw)/2', y: 'h-th-h*0.06' }],
      fontsizeExpr: 'h/14',
      opacity: 0.5,
    },
    STRONG: {
      positions: [
        { x: 'w*0.04', y: 'h*0.08' },
        { x: '(w-tw)/2', y: '(h-th)/2' },
        { x: 'w-tw-w*0.04', y: 'h-th-h*0.08' },
      ],
      fontsizeExpr: 'h/11',
      opacity: 0.65,
    },
  }[intensity];
  const filters = params.positions
    .map(
      (pos) =>
        `drawtext=text='${esc}':fontsize=${params.fontsizeExpr}:fontcolor=white@${params.opacity}:` +
        `bordercolor=black@${Math.min(params.opacity + 0.15, 1)}:borderw=2:x=${pos.x}:y=${pos.y}`,
    )
    .join(',');
  return (
    `-i {{input}} -vf "${filters}" ` +
    `-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p ` +
    `-c:a copy -movflags +faststart {{watermarked.mp4}}`
  );
}

const PLAIN = [
  'viral4creators',
  'Иван Петров',
  'Студія «Ґанок» — їжак',
  'Studio "Best", 2026 [v2]; ok!',
  '  пробелы по краям  ',
  '{x} & <y> #1 ~z',
];

describe('обычный текст — команда байт в байт как на origin/main (FF-INT-05)', () => {
  it.each(PLAIN)('%j', (t) => {
    expect(DRAWTEXT_SPECIAL.test(t)).toBe(false);
    for (const i of ['SLIGHT', 'STANDARD', 'STRONG'] as const)
      expect(buildWatermarkPlan(t, i).command).toBe(legacyPlan(t, i));
  });
});

/** Тексты со спецсимволами — новое экранирование. */
const SPECIAL = [
  'it\'s 100% "ok"',
  'a:b,c;d[e]f\\g',
  'Cost $5 `now` {x}',
  '  пробелы по краям  ',
  'Привіт, світ! %{pts} \\% \\\\',
  "''",
];

/** Содержимое `"…"` в sh: `\` перед `\ " $ \`` — сам символ. */
function shellDqUnescape(s: string): string {
  return s.replace(/\\([\\"$`])/g, '$1');
}
/** Один уровень `av_get_token` без кавычек: `\x` → `x`. */
function avUnescape(s: string): string {
  return s.replace(/\\([\s\S])/g, '$1');
}

describe('escapeDrawtext', () => {
  it.each(SPECIAL)(
    'уровни разбора возвращают ровно исходный текст: %j',
    (t) => {
      const raw = escapeDrawtext(t);
      expect(avUnescape(avUnescape(shellDqUnescape(raw)))).toBe(t);
    },
  );

  it.each(SPECIAL)(
    'в строке команды нет неэкранированных $ и обратной кавычки: %j',
    (t) => {
      const raw = escapeDrawtext(t);
      // Каждый `$`/`` ` `` предварён нечётным числом обратных слешей.
      for (const m of raw.matchAll(/(\\*)[$`]/g))
        expect(m[1].length % 2).toBe(1);
      // Внутри `"…"` нет голой двойной кавычки и разрыва графа.
      for (const m of raw.matchAll(/(\\*)"/g)) expect(m[1].length % 2).toBe(1);
    },
  );

  it('drawtext без разбора %{…}: expansion=none в каждом экземпляре', () => {
    const plan = buildWatermarkPlan("it's", 'STRONG');
    expect(plan.command.match(/drawtext=expansion=none:text=/g)).toHaveLength(
      3,
    );
  });
});

let ffmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ffmpeg = true;
} catch {
  ffmpeg = false;
}
(ffmpeg ? describe : describe.skip)('escapeDrawtext — рендер FFmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const md5 = (f: string) =>
    createHash('md5').update(readFileSync(f)).digest('hex');
  const render = (filter: string, out: string) =>
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=320x180:d=1',
        '-vf',
        filter,
        '-frames:v',
        '1',
        join(dir, out),
      ],
      { cwd: dir },
    );

  // Пробелы по краям обычного текста прежний генератор (origin/main) теряет
  // (уровень опций FFmpeg их обрезает) — поведение сохранено, в рендер-сверку
  // такие тексты не входят.
  it.each([...SPECIAL, ...PLAIN].filter((t) => t.trim() === t))(
    'кадр совпадает с textfile: %j',
    (t) => {
      const plan = buildWatermarkPlan(t, 'STANDARD');
      const vf = shellDqUnescape(
        /-vf "((?:\\.|[^"\\])*)"/.exec(plan.command)![1],
      );
      writeFileSync(join(dir, 't.txt'), t);
      const ref = vf.replace(
        /drawtext=(?:expansion=none:text=(?:\\[\s\S]|[^:\\])*|text='[^']*'):/,
        'drawtext=expansion=none:textfile=t.txt:',
      );
      render(vf, 'a.png');
      render(ref, 'b.png');
      expect(md5(join(dir, 'a.png'))).toBe(md5(join(dir, 'b.png')));
    },
  );
});
