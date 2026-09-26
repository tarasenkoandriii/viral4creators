/**
 * Генератор OG-карточек лендинга обучалок (этап J ТЗ
 * `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * Пять картинок 1200×630 — по одной на локаль — в
 * `landing/public/og/tutorial-<locale>.jpg`. Имена те же, что были:
 * адрес карточки задаёт `ogImageUrl()` в
 * `landing/src/lib/social-meta.ts`, общий с главной и поздравлениями, и
 * трогать его ради одной площадки незачем.
 *
 * ## Почему отдельный скрипт, а не `next/og`
 *
 * Соблазн очевиден — `ImageResponse` уже используется в
 * `landing/src/app/icon.tsx`. Не подходит по трём причинам, и все три
 * выяснились проверкой, а не рассуждением (находка А-6 аудита ТЗ):
 * адрес карточки задан статикой в `social-meta.ts`;
 * маршрут-генератор жил бы по адресу `/[locale]/site-tutorial/
 * opengraph-image`, который на поддомене проходит через переписывание в
 * middleware; и `socialMeta()` задаёт `images` явно, перебивая файловую
 * конвенцию Next. Здесь картинка рисуется ВНЕ приложения, результат
 * коммитится, в рантайм лендинга не добавляется ничего.
 *
 * ## Когда запускать
 *
 * Руками, когда поменялся заголовок в словаре или дизайн карточки:
 *
 *     node scripts/og-tutorial-cards.mjs
 *
 * Нужны две вещи, обе — внешние команды, НИ ОДНОЙ npm-зависимости:
 * headless-Chromium (снимает кадр) и `convert` из ImageMagick либо
 * `ffmpeg` (переводит PNG в JPEG). Скрипт ищет их сам; путь к браузеру
 * можно задать через `$CHROME_PATH`.
 *
 * Зависимости нет сознательно. Это разовый инструмент, а не часть
 * сборки: тянуть ради него пакет в `landing/package.json`, где
 * прод-зависимостей четыре, значило бы платить постоянную цену за
 * редкое действие. Скрипт, который через год запускается без
 * `npm install`, надёжнее скрипта, которому нужен совпавший lock-файл.
 *
 * JPEG, а не PNG, и не по привычке: имя файла задаёт `ogImageUrl()`, а
 * по расширению определяется `Content-Type`. PNG-байты под именем
 * `.jpg` раздавались бы как `image/jpeg`, и часть чужих парсеров
 * превью на этом спотыкается.
 *
 * Тексты берутся из тех же словарей, что и страница. Этого мало:
 * заголовок в словаре поменяют, скрипт перезапустить забудут, и
 * карточка будет тихо показывать прошлогодний текст — ровно тот вид
 * расхождения, который в этом проекте ловят швом. Поэтому рядом
 * пишется `scripts/assets/og-tutorial-cards.lock.json` с отпечатком
 * строк, из которых картинки нарисованы, а `scripts/check-docs.mjs`
 * (шов 16) сверяет его со словарями на каждом прогоне CI.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['ru', 'uk', 'en', 'de', 'es'];
const WIDTH = 1200;
const HEIGHT = 630;
/** Верх бюджета: карточки, которые были до этого этапа, весили ~60 КБ. */
const MAX_BYTES = 95 * 1024;

function read(rel) {
  return readFileSync(path.join(ROOT, rel));
}

function fontFace(family, weight, subset) {
  const b64 = read(
    `scripts/assets/og-fonts/inter-${subset}-${weight}-normal.woff2`,
  ).toString('base64');
  // `unicode-range` не задаём: подмножеств всего два, и браузер сам
  // возьмёт то, в котором есть нужный глиф.
  return `@font-face{font-family:${family};font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
}

const FONTS = [
  fontFace('InterOg', 400, 'latin'),
  fontFace('InterOg', 400, 'cyrillic'),
  fontFace('InterOg', 700, 'latin'),
  fontFace('InterOg', 700, 'cyrillic'),
].join('');

const SHOT = read('landing/public/illustrations/tutorial-hero.svg').toString(
  'base64',
);

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

/** Марка с акцентной «4» — та же деталь, что была на прежних карточках. */
function brand() {
  return 'viral<span class="b4">4</span>creators';
}

function html({ title, badge }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${FONTS}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${WIDTH}px;height:${HEIGHT}px}
body{
  background:#0b0b0d;color:#ececec;
  font-family:InterOg,sans-serif;
  display:flex;align-items:center;gap:48px;padding:0 72px;
  position:relative;overflow:hidden;
}
/* Те же два слоя фона, что у первого экрана страницы (этап E):
   акцентное свечение и техническая сетка, гаснущая книзу. */
body::before{content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse 58% 78% at 20% -6%,rgba(108,140,255,.20),transparent 66%);}
body::after{content:'';position:absolute;inset:0;
  background-image:
    repeating-linear-gradient(to right,rgba(255,255,255,.035) 0 1px,transparent 1px 32px),
    repeating-linear-gradient(to bottom,rgba(255,255,255,.035) 0 1px,transparent 1px 32px);
  -webkit-mask-image:linear-gradient(to bottom,#000 0%,transparent 82%);}
.copy{position:relative;z-index:1;width:500px;flex:0 0 500px}
.brand{font-weight:700;font-size:25px;letter-spacing:-.01em;color:#ececec}
.b4{color:#6c8cff}
h1{margin-top:26px;font-weight:700;letter-spacing:-.022em;line-height:1.1;
   font-size:52px;text-wrap:balance}
.badge{display:inline-block;margin-top:28px;padding:11px 22px;border-radius:999px;
  border:1px solid #2a2a2e;color:#9a9a9a;font-size:20px;line-height:1.2}
/* Оправа — та же, что у кадров на странице: подложка на тон светлее,
   тонкая граница, контактная тень, рассеянная тень и верхний блик.
   На почти чёрном фоне видимость даёт не заливка, а тени. */
.shot{position:relative;z-index:1;flex:0 0 508px;padding:12px;border-radius:20px;
  background:#1b1b1f;border:1px solid #33333a;
  box-shadow:0 1px 2px rgba(0,0,0,.6),0 18px 48px -16px rgba(0,0,0,.85),
             inset 0 1px 0 rgba(255,255,255,.06)}
.shot img{display:block;width:100%;height:auto;border-radius:9px;background:#08080a}
</style></head><body>
<div class="copy">
  <div class="brand">${brand()}</div>
  <h1>${escapeHtml(title)}</h1>
  <div class="badge">${escapeHtml(badge)}</div>
</div>
<div class="shot"><img src="data:image/svg+xml;base64,${SHOT}" alt=""></div>
<script>
/* Автоподгонка кегля. Заголовки в пяти языках разной длины, немецкий
   длиннее всех. Вместо того чтобы подбирать размер на глаз под самый
   длинный и обделять остальные, уменьшаем его по шагу, пока колонка не
   перестанет вылезать. Делается прямо в странице, а не по CDP: скрипту
   тогда не нужен управляющий браузером пакет. */
(function () {
  var h1 = document.querySelector('h1');
  var copy = document.querySelector('.copy');
  var size = 52;
  function fits() {
    return copy.scrollHeight <= 470 && h1.scrollWidth <= h1.clientWidth + 1;
  }
  while (!fits() && size > 34) {
    size -= 2;
    h1.style.fontSize = size + 'px';
  }
  document.documentElement.dataset.fitted = String(size);
})();
</script>
</body></html>`;
}

function findBin(candidates) {
  return candidates.find((p) => p && existsSync(p));
}

const chrome = findBin([
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);
if (!chrome) {
  console.error(
    'Не нашёл headless-Chromium. Укажите путь: CHROME_PATH=/путь/к/chrome node scripts/og-tutorial-cards.mjs',
  );
  process.exit(1);
}

const magick = findBin(['/usr/bin/convert', '/usr/local/bin/convert', '/opt/homebrew/bin/convert']);
const ffmpeg = findBin(['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']);
if (!magick && !ffmpeg) {
  console.error(
    'Нужен конвертер PNG→JPEG: ImageMagick (`convert`) или ffmpeg. Ни того, ни другого не нашёл.',
  );
  process.exit(1);
}

function toJpeg(png, jpg) {
  if (magick) {
    execFileSync(magick, [png, '-quality', '88', '-strip', jpg]);
  } else {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', png, '-q:v', '3', jpg]);
  }
}

/** Отпечаток строк, из которых нарисована карточка — для шва 16. */
function fingerprint(hero) {
  return createHash('sha256')
    .update(`${hero.title}\n${hero.badge}`)
    .digest('hex')
    .slice(0, 16);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'og-cards-'));
const problems = [];
const lock = {};
try {
  for (const locale of LOCALES) {
    const dict = JSON.parse(
      read(`landing/src/dictionaries/${locale}.json`).toString(),
    );
    const hero = dict.siteTutorialLanding.hero;
    lock[locale] = fingerprint(hero);
    const pageFile = path.join(tmp, `${locale}.html`);
    const pngFile = path.join(tmp, `${locale}.png`);
    writeFileSync(pageFile, html({ title: hero.title, badge: hero.badge }));

    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${WIDTH},${HEIGHT}`,
        // Шрифты приезжают data-ссылками, сеть не нужна вовсе; бюджет
        // виртуального времени даёт странице досчитать автоподгонку до
        // снимка.
        '--virtual-time-budget=4000',
        `--screenshot=${pngFile}`,
        `file://${pageFile}`,
      ],
      { stdio: 'pipe' },
    );

    const out = `landing/public/og/tutorial-${locale}.jpg`;
    toJpeg(pngFile, path.join(ROOT, out));
    const bytes = statSync(path.join(ROOT, out)).size;
    const kb = (bytes / 1024).toFixed(1);
    if (bytes > MAX_BYTES) {
      problems.push(`${out}: ${kb} КБ — больше бюджета ${MAX_BYTES / 1024} КБ`);
    }
    console.log(`${out}  ${kb} КБ`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

writeFileSync(
  path.join(ROOT, 'scripts/assets/og-tutorial-cards.lock.json'),
  `${JSON.stringify(lock, null, 2)}\n`,
);

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('Готово: пять карточек перерисованы.');
