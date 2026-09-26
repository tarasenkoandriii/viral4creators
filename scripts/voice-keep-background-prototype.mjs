#!/usr/bin/env node
/**
 * Прототип: заменить ГОЛОС модели, сохранив фон ролика.
 *
 * Зачем он есть
 * -------------
 * Сегодня постпрод умеет два режима (`src/common/postprod.ts`):
 * `voiceover` подмешивает исходную дорожку приглушённой (`DEFAULT_DUCK`),
 * `dub` выбрасывает её целиком. Первый оставляет слышимым голос модели
 * (двоение), второй уносит вместе с голосом весь фон — лай собак, шум
 * дороги, музыку. Пользователь при этом просил заменить ГОЛОС, а не звук.
 *
 * Тот же файл уже признаёт задачу нерешённой: «более точный (ii) — фильтр
 * подавления голосовых частот перед amix — остаётся нерешённым отдельным
 * заходом». Этот прототип проверяет другой путь — разделение дорожки на
 * стемы, — чтобы решение принималось на слух, а не на бумаге.
 *
 * Что делает
 * ----------
 * 1. Достаёт звук из ОРИГИНАЛА (ролик как его отдала модель).
 * 2. Разделяет его htdemucs на «вокал» и «всё остальное».
 * 3. Берёт звук из РЕЗУЛЬТАТА ПОСТПРОДА — в режиме `dub` там ровно
 *    синтезированный голос на тишине, то есть готовый голосовой стем.
 * 4. Мешает «всё остальное» + этот голос тем же приёмом, что и продукт
 *    (`amix duration=first normalize=0`), и кладёт обратно в видео.
 *
 *    Одно расхождение с продуктом, замеченное сквозным аудитом A–F:
 *    здесь стем идёт в микс как есть, а продукт приводит его к длине
 *    ролика (`atrim`/`apad`) — иначе чуть более длинный стем удлинил
 *    бы ролик, потому что именно по нему считается `duration=first`.
 *    Для прослушивания разницы это не важно (речь о десятках
 *    миллисекунд в хвосте), но читать этот файл как образец
 *    продуктового микса больше нельзя.
 * 5. Печатает замеры: время разделения и уровни RMS по стемам.
 *
 * На выходе три файла рядом друг с другом — оригинал, нынешний постпрод и
 * прототип. Слушать подряд.
 *
 * Почему это запускается на Маке, а не в песочнице ассистента
 * -----------------------------------------------------------
 * У песочницы и у локальной VM Cowork закрыт egress: недоступны ни веса
 * модели (dl.fbaipublicfiles.com), ни хранилище роликов. Это ограничение
 * среды, а не задачи.
 *
 * Использование
 * -------------
 *   node scripts/voice-keep-background-prototype.mjs <оригинал> <постпрод> [папка]
 *
 * Аргументы — локальные файлы или ссылки (скачает сам). Оба ролика берутся
 * с экрана постпрода: таб «Оригинал Grok» и таб «После обработки».
 *
 * Требования: node, ffmpeg, python3. Demucs ставится в свой venv внутри
 * рабочей папки и системный python не трогает.
 */
import { execFileSync, execSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';

const [, , rawSource, rawDubbed, outDirArg] = process.argv;
if (!rawSource || !rawDubbed) {
  console.error(
    'Использование: node scripts/voice-keep-background-prototype.mjs <оригинал> <постпрод> [папка]\n' +
      '  оригинал — ролик со звуком модели (таб «Оригинал Grok»)\n' +
      '  постпрод — нынешний результат (таб «После обработки»), голос на тишине',
  );
  process.exit(1);
}

const outDir = path.resolve(outDirArg || 'voice-prototype');
mkdirSync(outDir, { recursive: true });

/** Приглушение фона под речью. Взято равным 1.0 НАМЕРЕННО: смысл прогона —
 *  услышать, сколько фона возвращается, а не подобрать микс. Подбор — уже
 *  задача внедрения, и он должен опираться на этот прослушанный результат. */
const BG_GAIN = 1.0;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function have(cmd) {
  try {
    run('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

for (const tool of ['ffmpeg', 'ffprobe', 'python3']) {
  if (!have(tool)) {
    console.error(`нет ${tool} — поставьте и повторите (brew install ffmpeg python)`);
    process.exit(1);
  }
}

/**
 * macOS закрывает «Загрузки», «Документы» и «Рабочий стол» от процессов без
 * явного разрешения (TCC), и наружу это выходит как `Operation not
 * permitted` из ffprobe — сообщение, по которому человек идёт искать
 * несуществующую ошибку в скрипте. Проверяем доступ сами и называем
 * причину.
 */
function assertReadable(file) {
  try {
    closeSync(openSync(file, 'r'));
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      console.error(
        `\nmacOS не пускает к файлу: ${file}\n\n` +
          'Это защита приватности (TCC): у терминала нет доступа к этой папке —\n' +
          'чаще всего к «Загрузкам», «Документам» или «Рабочему столу».\n\n' +
          'Самый быстрый выход — перенести файлы Finder\'ом в обычную папку\n' +
          'и запустить оттуда, например:\n' +
          '  mkdir -p ~/work/voice-prototype\n' +
          '  # перетащите оба ролика в эту папку в Finder\n' +
          '  node scripts/voice-keep-background-prototype.mjs \\\n' +
          '    ~/work/voice-prototype/original.mp4 ~/work/voice-prototype/postprod.mp4\n\n' +
          'Выдавать терминалу полный доступ к диску ради одного прогона не нужно.',
      );
      process.exit(1);
    }
    throw e;
  }
}

/** Ссылка или файл. Скачиваем curl'ом, чтобы не тянуть зависимостей. */
function localize(input, name) {
  if (!/^https?:\/\//.test(input)) {
    if (!existsSync(input)) {
      console.error(`файла нет: ${input}`);
      process.exit(1);
    }
    const resolved = path.resolve(input);
    assertReadable(resolved);
    return resolved;
  }
  const dest = path.join(outDir, `${name}.mp4`);
  console.log(`скачиваю ${name}…`);
  run('curl', ['-fsSL', '-o', dest, input]);
  return dest;
}

const source = localize(rawSource, 'source');
const dubbed = localize(rawDubbed, 'dubbed');

function seconds(file) {
  const out = run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file,
  ]);
  return Number(out.trim());
}

/** Средний уровень дорожки в dBFS. Нужен как ЧИСЛО рядом с ушами: «фон
 *  вернулся» хочется не только слышать, но и видеть. */
function rmsDb(file) {
  try {
    // ВАЖНО: без `-v error`. volumedetect печатает результат на уровне
    // info, и первая редакция этого скрипта его же и заглушала — отсюда
    // были NaN во всех строках замеров.
    const out = execSync(
      `ffmpeg -hide_banner -nostats -i ${JSON.stringify(file)} -af volumedetect -f null - 2>&1`,
      { encoding: 'utf8' },
    );
    const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? Number(m[1]) : NaN;
  } catch {
    return NaN;
  }
}

console.log(`\nоригинал: ${seconds(source).toFixed(2)} с, постпрод: ${seconds(dubbed).toFixed(2)} с`);

// ── venv с demucs ────────────────────────────────────────────────────────
const venv = path.join(outDir, '.venv');
const py = path.join(venv, 'bin', 'python');
if (!existsSync(py)) {
  console.log('ставлю demucs в отдельный venv (один раз, несколько минут)…');
  run('python3', ['-m', 'venv', venv]);
  run(py, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip']);
  run(py, ['-m', 'pip', 'install', '-q', 'demucs']);
}

// ── звук оригинала ───────────────────────────────────────────────────────
const sourceWav = path.join(outDir, 'source.wav');
run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-vn', '-ac', '2', '-ar', '44100', sourceWav]);

// ── разделение ───────────────────────────────────────────────────────────
const stemDir = path.join(outDir, 'stems', 'htdemucs', 'source');
const background = path.join(stemDir, 'no_vocals.wav');
const vocals = path.join(stemDir, 'vocals.wav');

// Стемы переживают перезапуск: разделение — самая долгая часть прогона
// (десятки секунд на CPU), и повторять её ради правки микса незачем.
// Удалите папку stems, чтобы пересчитать.
let separationSeconds = 0;
if (existsSync(background) && existsSync(vocals)) {
  console.log('стемы уже посчитаны — переиспользую (удалите stems/, чтобы пересчитать)');
} else {
  console.log('разделяю дорожку (htdemucs)…');
  const started = Date.now();
  run(py, ['-m', 'demucs', '-n', 'htdemucs', '--two-stems=vocals', '-o', path.join(outDir, 'stems'), sourceWav], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  separationSeconds = (Date.now() - started) / 1000;
}
if (!existsSync(background)) {
  console.error(`demucs не отдал фон: нет ${background}`);
  process.exit(1);
}

// ── голос из постпрода ───────────────────────────────────────────────────
const voiceWav = path.join(outDir, 'voice.wav');
run('ffmpeg', ['-y', '-v', 'error', '-i', dubbed, '-vn', '-ac', '2', '-ar', '44100', voiceWav]);

// ── микс тем же приёмом, что в продукте ──────────────────────────────────
// `duration=first` держит длину по фону (он равен длине ролика), `normalize=0`
// не даёт amix самому подрезать уровни — ровно как в buildAudioFilters.
const MIX = `[0:a]volume=${BG_GAIN}[bg];[bg][1:a]amix=inputs=2:duration=first:normalize=0[a]`;

// Сначала ЗВУК отдельным файлом. Слушать можно уже его, и он не зависит
// от того, удастся ли мукс в видео: первая редакция скрипта отдавала
// только mp4, он собрался без видеодорожки (34 КБ), и прототип нельзя
// было ни открыть, ни услышать. Аудио — суть прогона, видео — удобство.
const resultWav = path.join(outDir, 'prototype.wav');
run('ffmpeg', [
  '-y', '-v', 'error',
  '-i', background, '-i', voiceWav,
  '-filter_complex', MIX, '-map', '[a]', resultWav,
]);

/** Длительность видеопотока (не контейнера): по ней и видно, что мукс
 *  прошёл. Пусто — видеодорожки в файле нет вовсе. */
function videoSeconds(file) {
  try {
    const out = run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', file,
    ]).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

const result = path.join(outDir, 'prototype.mp4');
function mux(videoArgs) {
  return execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'warning',
    '-i', source, '-i', resultWav,
    '-map', '0:v:0', '-map', '1:a:0',
    ...videoArgs, '-c:a', 'aac', '-shortest', result,
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Копирование видеопотока — быстро и без потерь, но у роликов из
// генераторов оно иногда не проходит (экзотический профиль, битые
// таймстемпы). Поэтому результат ПРОВЕРЯЕТСЯ, и при неудаче видео
// пережимается. Молча отдавать нерабочий файл — худший из вариантов.
let muxNote = 'видеопоток скопирован без пережатия';
try {
  mux(['-c:v', 'copy']);
} catch (e) {
  muxNote = `копирование не прошло (${String(e.stderr || e.message).trim().split('\n').pop()}), видео пережато`;
}
const srcSeconds = seconds(source);
if (videoSeconds(result) < srcSeconds * 0.9) {
  muxNote = 'копирование дало файл без полноценной видеодорожки — видео пережато';
  mux(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']);
}
if (videoSeconds(result) < srcSeconds * 0.9) {
  muxNote = 'видео собрать не удалось — слушайте prototype.wav, он рядом и полноценный';
}

// ── замеры ───────────────────────────────────────────────────────────────
const kb = (f) => (statSync(f).size / 1024).toFixed(0);
console.log(`
── Замеры ────────────────────────────────────────────────
Длительность ролика      ${seconds(source).toFixed(2)} с
Разделение заняло        ${separationSeconds ? `${separationSeconds.toFixed(1)} с` : 'переиспользованы готовые стемы'}  (CPU Mac; на A100 у Replicate — около 23 с на прогон)

Уровни (mean dBFS, чем ближе к нулю тем громче):
  оригинал целиком       ${rmsDb(sourceWav).toFixed(1)}
  стем «вокал»           ${rmsDb(vocals).toFixed(1)}
  стем «фон»             ${rmsDb(background).toFixed(1)}   ← это и вернётся в ролик
  голос из постпрода     ${rmsDb(voiceWav).toFixed(1)}
  прототип               ${rmsDb(result).toFixed(1)}

Видео: ${muxNote}

Файлы:
  1. ${source}
     оригинал: фон + голос модели
  2. ${dubbed}
     сегодня: голос на тишине
  3. ${resultWav}  (${kb(resultWav)} КБ)
     прототип, только звук — слушать в первую очередь
  4. ${result}  (${kb(result)} КБ)
     прототип с картинкой

Слушать подряд 1 → 2 → 3. Главный вопрос к уху: слышны ли в третьем
остатки речи модели под новым голосом. Если слышны — фон придётся
приглушать (BG_GAIN в этом файле), и тогда решение стоит обсудить заново.
`);
