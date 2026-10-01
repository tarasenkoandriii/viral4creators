#!/usr/bin/env node
/**
 * OG-карточки 1200×630 на страницу × локаль (ТЗ §8.5) →
 * `public/og/<page>-<locale>.jpg`.
 *
 * Приём `scripts/og-tutorial-cards.mjs` (корень репозитория): headless-
 * Chromium снимает HTML-шаблон, результат коммитится, `next/og` не
 * используется. Отличие — без ImageMagick: Chromium сам отдаёт JPEG.
 *
 * Тексты — из словарей (`og.<page>`) и имя — из `src/brand.ts`, поэтому
 * после смены бренда (В-1) карточки нужно пересобрать: `npm run og`.
 * Что для каждой страницы × локали файл есть, проверяет
 * `scripts/seo.test.ts`. Скриншота виджета на карточке нет — виджета
 * ещё нет (§0: рисунок за скриншот не выдаём).
 *
 * Браузер: playwright-core той же версии, что браузеры в
 * `PLAYWRIGHT_BROWSERS_PATH` (в CI — `npx playwright install chromium`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['uk', 'en', 'ru'];
const PAGES = ['home', 'assistant', 'how-it-works', 'security', 'pricing', 'faq', 'pilot'];
const brandSrc = fs.readFileSync(path.join(ROOT, 'src/brand.ts'), 'utf8');
const BRAND = /name: '([^']+)'/.exec(brandSrc)?.[1];
if (!BRAND) throw new Error('og-cards: не нашлось BRAND.name в src/brand.ts');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html(title, badge) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;font-family:system-ui,'Segoe UI',Roboto,'Noto Sans',Arial,sans-serif;
    background:#ffffff;color:#111827;display:flex;flex-direction:column;justify-content:space-between;padding:72px 80px;
    border-top:16px solid #1d4ed8}
  .brand{display:flex;align-items:center;gap:18px;font-size:40px;font-weight:700}
  .mark{width:48px;height:48px;border-radius:12px;background:#1d4ed8}
  h1{font-size:76px;line-height:1.1;letter-spacing:-0.01em;max-width:1000px}
  .badge{display:inline-block;padding:8px 22px;border-radius:999px;background:#fef3c7;color:#7c2d12;
    font-size:30px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  </style></head><body>
  <div class="brand"><span class="mark"></span>${esc(BRAND)}</div>
  <h1>${esc(title)}</h1>
  <div><span class="badge">${esc(badge)}</span></div>
  </body></html>`;
}

const outDir = path.join(ROOT, 'public/og');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
let count = 0;
for (const locale of LOCALES) {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, `src/dictionaries/${locale}.json`), 'utf8'));
  for (const key of PAGES) {
    const title = dict.og[key];
    if (!title) throw new Error(`og-cards: нет og.${key} в ${locale}.json`);
    await page.setContent(html(title, dict.og.badge), { waitUntil: 'load' });
    await page.screenshot({ path: path.join(outDir, `${key}-${locale}.jpg`), type: 'jpeg', quality: 82 });
    count++;
  }
}
await browser.close();
console.log(`og-cards: ${count} карточек в public/og/`);
