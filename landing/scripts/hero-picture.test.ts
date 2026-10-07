/**
 * Hero трёх страниц — `<picture>` с AVIF и запасными WebP/JPEG
 * (`src/components/HeroPicture.tsx`, TODO «AVIF без `srcset` и запасного
 * формата», 07.10.2026).
 *
 *  1. разметка: `<source>` AVIF, затем WebP (порядок важен — браузер
 *     берёт первый понятный), `<img>` с JPEG, у всех `srcset` 768w/1536w
 *     и одинаковый `sizes`, у `<img>` — `width`/`height` (без сдвига
 *     вёрстки), пустой `alt`, без ленивой загрузки;
 *  2. каждый адрес из разметки лежит в `public/`;
 *  3. страницы (главная, поздравления, обучалки) рисуют hero через
 *     `HeroPicture`, а не одиночным AVIF через `next/image`;
 *  4. список hero совпадает со скриптом `scripts/hero-fallbacks.mjs`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HERO_HEIGHT,
  HERO_IMAGES,
  HERO_SIZES,
  HERO_WIDTH,
  HeroPicture,
} from '../src/components/HeroPicture';

(globalThis as { React?: typeof React }).React = React;

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const name of HERO_IMAGES) {
  const html = renderToStaticMarkup(React.createElement(HeroPicture, { name }));
  assert.ok(
    html.startsWith('<picture>') && html.endsWith('</picture>'),
    `${name}: не <picture>`,
  );
  const tags = html.match(/<(source|img)\b[^>]*>/g) ?? [];
  assert.equal(tags.length, 3, `${name}: ожидалось два <source> и <img>`);
  const [avif, webp, img] = tags;
  assert.match(
    avif,
    /^<source\b[^>]*type="image\/avif"/,
    `${name}: первый source — AVIF`,
  );
  assert.match(
    webp,
    /^<source\b[^>]*type="image\/webp"/,
    `${name}: второй source — WebP`,
  );
  assert.match(img, /^<img\b/, `${name}: последний — <img>`);
  assert.match(
    img,
    new RegExp(`src="/illustrations/${name}\\.jpg"`),
    `${name}: запасной JPEG`,
  );
  assert.match(img, new RegExp(`width="${HERO_WIDTH}"`));
  assert.match(img, new RegExp(`height="${HERO_HEIGHT}"`));
  assert.match(img, /alt=""/);
  assert.match(img, /loading="eager"/);
  assert.ok(
    !/fetchpriority/i.test(img),
    `${name}: высокий приоритет на телефоне мешал CSS/JS`,
  );
  for (const [tag, ext] of [
    [avif, 'avif'],
    [webp, 'webp'],
    [img, 'jpg'],
  ] as const) {
    const srcset = /srcSet="([^"]+)"|srcset="([^"]+)"/i.exec(tag);
    const value = srcset?.[1] ?? srcset?.[2] ?? '';
    assert.equal(
      value,
      `/illustrations/${name}-768.${ext} 768w, /illustrations/${name}.${ext} 1536w`,
      `${name}: srcset ${ext}`,
    );
    assert.ok(tag.includes(`sizes="${HERO_SIZES}"`), `${name}: sizes у ${ext}`);
  }
  // ── 2. Все адреса лежат на диске ──
  const urls = [...html.matchAll(/\/illustrations\/[\w.-]+/g)].map((m) => m[0]);
  assert.ok(urls.length >= 7);
  for (const url of new Set(urls)) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'public', url)),
      `${url}: файла нет`,
    );
  }
}

// ── 3. Страницы ──
for (const [page, name] of [
  ['src/app/[locale]/page.tsx', 'ads-hero-v2'],
  ['src/app/[locale]/greetings/page.tsx', 'greetings-hero-v2'],
  ['src/app/[locale]/site-tutorial/page.tsx', 'tutorial-hero-v2'],
] as const) {
  const src = read(page);
  assert.ok(
    src.includes(`<HeroPicture name="${name}" />`),
    `${page}: hero не через HeroPicture`,
  );
  assert.ok(
    !/-hero-v2\.avif/.test(src),
    `${page}: одиночный AVIF hero остался`,
  );
  assert.ok(!/hero\.svg/.test(src), `${page}: SVG hero`);
}

// ── 4. Список hero = скрипт производных файлов ──
{
  const script = read('scripts/hero-fallbacks.mjs');
  const list = /const HEROES = \[([^\]]+)\]/.exec(script)?.[1] ?? '';
  assert.deepEqual(
    [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    [...HERO_IMAGES],
    'HERO_IMAGES и scripts/hero-fallbacks.mjs разошлись',
  );
}

console.log(
  `hero-picture: ok (${HERO_IMAGES.length} hero × AVIF/WebP/JPEG × 768/1536)`,
);
