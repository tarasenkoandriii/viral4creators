/**
 * Запасные форматы и ширины hero трёх страниц (главная, поздравления,
 * обучалки) из исходного AVIF 1536×1024 (TODO «лендинг: AVIF без
 * `srcset` и запасного формата», 07.10.2026).
 *
 * Зачем: AVIF понимают Safari 16+ / iOS 16+; в iOS 15 WebView (в том
 * числе встроенный браузер Telegram на старых телефонах) `<img src=…avif>`
 * — пустая рамка в первом экране. Разметка — `<picture>`
 * (`src/components/HeroPicture.tsx`): AVIF → WebP → JPEG, у каждого
 * формата две ширины (768 и 1536), браузер скачивает ОДИН файл.
 *
 * Исходник — только AVIF (`public/illustrations/<имя>.avif`); всё
 * остальное — производное, пересобирается этим скриптом:
 *
 *     node scripts/hero-fallbacks.mjs
 *
 * Нужен `sharp` (с поддержкой AVIF на вход). В зависимости лендинга он
 * не добавлен сознательно — это разовый инструмент, как генераторы
 * OG-карточек; скрипт ищет его сам: обычный `import`, затем
 * `$SHARP_PATH`, затем глобальная установка npm. Наличие и бюджеты
 * файлов держит `scripts/greeting-frames.test.ts` (блок hero).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public', 'illustrations');

/** Должен совпадать с `HERO_IMAGES` в `src/components/HeroPicture.tsx`. */
const HEROES = ['ads-hero-v2', 'greetings-hero-v2', 'tutorial-hero-v2'];
const SMALL = 768;

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    /* не в зависимостях — ищем дальше */
  }
  const require = createRequire(import.meta.url);
  const candidates = [process.env.SHARP_PATH];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
    }).trim();
    candidates.push(path.join(globalRoot, 'sharp'));
  } catch {
    /* npm недоступен */
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return require(candidate);
  }
  console.error(
    'Не нашёл sharp. Установите (`npm i -g sharp`) или задайте SHARP_PATH.',
  );
  process.exit(1);
}

const sharp = await loadSharp();

for (const name of HEROES) {
  const source = path.join(DIR, `${name}.avif`);
  const meta = await sharp(source).metadata();
  if (meta.width !== 1536 || meta.height !== 1024) {
    console.error(
      `${name}.avif: ${meta.width}×${meta.height}, ожидалось 1536×1024`,
    );
    process.exit(1);
  }
  const outputs = [
    [
      `${name}-${SMALL}.avif`,
      (img) => img.resize(SMALL).avif({ quality: 52, effort: 6 }),
    ],
    [`${name}.webp`, (img) => img.webp({ quality: 78, effort: 6 })],
    [
      `${name}-${SMALL}.webp`,
      (img) => img.resize(SMALL).webp({ quality: 78, effort: 6 }),
    ],
    [
      `${name}.jpg`,
      (img) => img.jpeg({ quality: 78, mozjpeg: true, progressive: true }),
    ],
    [
      `${name}-${SMALL}.jpg`,
      (img) =>
        img
          .resize(SMALL)
          .jpeg({ quality: 78, mozjpeg: true, progressive: true }),
    ],
  ];
  for (const [file, encode] of outputs) {
    const out = path.join(DIR, file);
    await encode(sharp(source)).toFile(out);
    console.log(`${file}  ${(statSync(out).size / 1024).toFixed(1)} КБ`);
  }
}
console.log('Готово: запасные форматы hero пересобраны.');
