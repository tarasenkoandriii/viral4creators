/**
 * Генератор OG-карточек лендинга Story‑Tales (Р-STL-18): пять картинок
 * 1200×630 — `public/og/stories-<locale>.jpg`, адрес задаёт
 * `ogImageUrl(STORIES_SITE_URL, 'stories', locale)`.
 *
 * Тот же способ, что у карточек обучалки и поздравлений
 * (`scripts/og-tutorial-cards.mjs` в корне — там все «почему»: картинка
 * рисуется ВНЕ приложения headless-Chromium'ом, PNG → JPEG через
 * ImageMagick/ffmpeg, ни одной npm-зависимости, результат коммитится).
 * Отличия:
 *
 *  - запускается через `tsx` из `landing/` — тексты Story‑Tales лежат в
 *    TS-модулях (`src/lib/stories/copy`), а не в JSON-словарях;
 *  - рисунок — тот же `HeroIllustration`, что в первом экране, с теми же
 *    стилями `stories.css` (светлая тема): карточка не обещает ничего
 *    сверх страницы — марка, слоган, бейдж и заголовок первого экрана;
 *  - бейдж — пилотный (`copy.access.pilot.badge`, «Пилот по приглашению»,
 *    20.10.2026): карточки отдаются только в режимах лендинга `pilot` и
 *    `public` (в `closed` — 404), и «Скоро запуск» в превью было бы
 *    неправдой. Перед режимом `public` — перерисовать с его бейджем;
 *  - отпечаток строк — `scripts/og-stories-cards.lock.json`, сверяет
 *    `scripts/stories-page.test.ts` (поменяли заголовок, слоган или бейдж
 *    и не перезапустили генератор — `npm test` скажет).
 *
 * Запуск (руками, когда поменялись эти тексты или рисунок):
 *
 *     cd landing && npx tsx scripts/og-stories-cards.tsx
 *
 * Путь к браузеру — `$CHROME_PATH`, иначе ищется сам.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeroIllustration } from '../src/app/(stories)/[locale]/stories/HeroIllustration';
import { locales } from '../src/lib/i18n';
import { BRAND, STORIES_COPY } from '../src/lib/stories/copy';
import { OG_CARD_BYTES_MAX, ogCardFingerprint } from '../src/lib/stories/og';

(globalThis as { React?: typeof React }).React = React;

const ROOT = path.join(__dirname, '..');
const WIDTH = 1200;
const HEIGHT = 630;
const css = readFileSync(path.join(ROOT, 'src', 'app', '(stories)', '[locale]', 'stories', 'stories.css'), 'utf8')
  // Карточка — всегда светлая: превью мессенджера темы страницы не знает.
  .replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/g, '');

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(locale: (typeof locales)[number]): string {
  const t = STORIES_COPY[locale];
  const figure = renderToStaticMarkup(
    <HeroIllustration
      alt={t.hero.illustrationAlt}
      caption={t.hero.illustrationCaption}
      narratorLabel={t.hero.narratorCardLabel}
      taleLabel={t.hero.taleCardLabel}
    />,
  );
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
.card{box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;padding:56px 64px;display:grid;grid-template-columns:1.1fr 1fr;gap:40px;align-items:center;font-family:-apple-system,'Segoe UI',sans-serif}
.brand{font-family:var(--st-serif);font-weight:700;font-size:30px;margin:0 0 28px}
.tagline{font-family:var(--st-serif);font-style:italic;font-size:26px;color:var(--st-accent);margin:0 0 14px}
h1{font-family:var(--st-serif);font-size:48px;line-height:1.12;margin:0 0 24px;color:var(--st-ink)}
.badge{display:inline-block;font-size:20px;font-weight:600;padding:8px 18px;border-radius:999px;background:var(--st-accent-soft);color:var(--st-ink)}
.st-ill-label{font-size:18px}
.st-figure figcaption{font-size:18px}
</style></head><body><div class="st-root"><div class="card">
<div><p class="brand">${escape(BRAND)}</p><p class="tagline">${escape(t.tagline)}</p><h1>${escape(t.hero.title)}</h1><span class="badge">${escape(t.access.pilot.badge)}</span></div>
<div>${figure}</div>
</div></div></body></html>`;
}

const find = (list: Array<string | undefined>) => list.find((p) => p && existsSync(p));
const chrome = find([
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);
const magick = find(['/usr/bin/convert', '/usr/local/bin/convert', '/opt/homebrew/bin/convert']);
const ffmpeg = find(['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']);
if (!chrome || (!magick && !ffmpeg)) {
  console.error('Нужны headless-Chromium ($CHROME_PATH) и ImageMagick `convert` либо ffmpeg.');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'og-stories-'));
const lock: Record<string, string> = {};
const problems: string[] = [];
try {
  for (const locale of locales) {
    const html = path.join(tmp, `${locale}.html`);
    const png = path.join(tmp, `${locale}.png`);
    writeFileSync(html, page(locale));
    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${WIDTH},${HEIGHT}`,
        '--virtual-time-budget=2000',
        `--screenshot=${png}`,
        `file://${html}`,
      ],
      { stdio: 'pipe' },
    );
    const out = path.join(ROOT, 'public', 'og', `stories-${locale}.jpg`);
    if (magick) execFileSync(magick, [png, '-quality', '86', '-strip', out]);
    else execFileSync(ffmpeg!, ['-y', '-loglevel', 'error', '-i', png, '-q:v', '3', out]);
    const bytes = statSync(out).size;
    if (bytes > OG_CARD_BYTES_MAX) problems.push(`${out}: ${bytes} байт — больше бюджета`);
    lock[locale] = ogCardFingerprint(STORIES_COPY[locale]);
    console.log(`public/og/stories-${locale}.jpg  ${(bytes / 1024).toFixed(1)} КБ`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(path.join(ROOT, 'scripts', 'og-stories-cards.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('Готово: пять карточек Story‑Tales перерисованы.');
