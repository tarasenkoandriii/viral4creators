/**
 * Подготовка настоящих кадров мастера для секции «Как это выглядит»
 * (этап I ТЗ `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * На вход — четыре снимка телефонного экрана, скачанные по адресам из
 * `outcomes[].blobUrl` прогона `POST /api/admin/ui-snapshot/run`
 * (порядок как в секции: вставили ссылку → увидели экран → заполнили и
 * нажали → получили ролик). На выход — четыре `.avif` в
 * `landing/public/illustrations/`, обрезанные по значимой зоне и
 * уложенные в бюджет.
 *
 *     node scripts/tutorial-frames-process.mjs ru 1.png 2.png 3.png 4.png
 *
 * Порядок работы целиком — `doc/TUTORIAL-FRAMES-CAPTURE.md`.
 *
 * ## Что делает и почему
 *
 * **Обрезает верхние 60% кадра.** Снимок — 390×844, телефон целиком.
 * Внизу у мастера пусто или служебное; показывать его в карточке
 * значит отдать треть высоты ни за чем. Значимая зона — окно сайта и
 * панель управления. Низ на странице дополнительно уходит в
 * градиентное затухание (CSS), поэтому ровная линия реза не видна.
 *
 * **Подбирает качество под бюджет 120 КБ,** а не ставит его наугад:
 * кадры разные, и один фиксированный `crf` либо раздувает простые,
 * либо мылит сложные. Если даже на пределе качества кадр не
 * укладывается — скрипт падает и говорит уменьшить зону обрезки. Это
 * сознательно: молча отдать замыленный снимок на странице, которая
 * продаёт достоверность, хуже, чем остановиться.
 *
 * Зависимостей нет: только `ffmpeg` (он же считает и обрезку).
 */
import { existsSync, statSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['ru', 'uk', 'en', 'de', 'es'];
const OUT_DIR = 'landing/public/illustrations';
/** Тот же потолок, что проверяет шов 17 в `check-docs.mjs`. */
const MAX_BYTES = 120 * 1024;
/** Доля кадра сверху, которую оставляем. Совпадает с расчётом ширины
 *  снимка в `landing/src/lib/tutorial-frames.ts` (780×1012). */
const KEEP = 0.6;
const TARGET_WIDTH = 780;

const [locale, ...inputs] = process.argv.slice(2);
if (!LOCALES.includes(locale) || inputs.length !== 4) {
  console.error(
    `Использование: node scripts/tutorial-frames-process.mjs <${LOCALES.join('|')}> кадр1 кадр2 кадр3 кадр4`,
  );
  process.exit(1);
}
for (const f of inputs) {
  if (!existsSync(f)) {
    console.error(`нет файла: ${f}`);
    process.exit(1);
  }
}

const ffmpeg = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].find(
  (p) => existsSync(p),
);
if (!ffmpeg) {
  console.error('нужен ffmpeg (он же делает обрезку и кодирует AVIF)');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'frames-'));
try {
  inputs.forEach((input, i) => {
    const index = i + 1;
    const filter = `crop=iw:floor(ih*${KEEP}/2)*2:0:0,scale=${TARGET_WIDTH}:-2:flags=lanczos`;
    let chosen = null;
    // От лучшего качества к худшему: первый, который влез в бюджет, и
    // берём. Шаги редкие — между 28 и 40 разница видна, между 28 и 29
    // нет, а каждый лишний прогон libaom это секунды.
    for (const crf of [26, 30, 34, 38, 42]) {
      const candidate = path.join(tmp, `${index}-${crf}.avif`);
      execFileSync(
        ffmpeg,
        ['-y', '-loglevel', 'error', '-i', input, '-vf', filter,
         '-c:v', 'libaom-av1', '-crf', String(crf), '-cpu-used', '4',
         '-pix_fmt', 'yuv420p', '-f', 'avif', candidate],
        { stdio: 'pipe' },
      );
      const bytes = statSync(candidate).size;
      if (bytes <= MAX_BYTES) {
        chosen = { file: candidate, bytes, crf };
        break;
      }
    }
    if (!chosen) {
      console.error(
        `кадр ${index} (${input}) не влезает в ${MAX_BYTES / 1024} КБ даже на пределе качества. ` +
          'Уменьшайте зону обрезки (KEEP), а не качество: замыленный снимок на странице, ' +
          'которая продаёт достоверность, хуже отсутствующего.',
      );
      process.exit(1);
    }
    const out = path.join(ROOT, OUT_DIR, `tutorial-shot-${locale}-${index}.avif`);
    copyFileSync(chosen.file, out);
    console.log(
      `${OUT_DIR}/tutorial-shot-${locale}-${index}.avif  ` +
        `${(chosen.bytes / 1024).toFixed(1)} КБ  (crf ${chosen.crf})`,
    );
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `Готово. Добавьте '${locale}' в REAL_FRAME_LOCALES ` +
    '(landing/src/lib/tutorial-frames.ts) — ПОСЛЕ этого шага, не раньше: ' +
    'порядок проверяет шов 17 в scripts/check-docs.mjs.',
);
