/**
 * Шов между списком локалей с настоящими кадрами поздравлений
 * (`src/lib/greeting-frames.ts`) и тем, что отдаётся странице
 * (этап H ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5.3).
 *
 * Главное свойство то же, что у обучалки: тип картинки (схема или
 * снимок) определяется ТОЛЬКО списком локалей — оговорка «это схемы»
 * на странице берётся из того же `greetingFramesAreReal`, и разойтись
 * им негде. Сверку «пунктов в словаре столько же, сколько кадров» и
 * переключение оговорки держит тест страницы (L1): ключи словаря —
 * его сторона.
 *
 * Здесь же — правила Уровня 1 для самих схем, которые иначе держатся
 * только на внимательности рисующего: бюджет веса и «ни текста, ни
 * внешних ссылок». Сверку списка локалей с файлами снимков делает шов
 * 17-бис в `scripts/check-docs.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { locales } from '../src/lib/i18n';
import { HERO_IMAGES } from '../src/components/HeroPicture';
import {
  GREETING_FRAME_COUNT,
  GREETING_REAL_FRAME_LOCALES,
  greetingFrame,
  greetingFramesAreReal,
  greetingPersonaScheme,
} from '../src/lib/greeting-frames';

const PUBLIC = path.join(__dirname, '..', 'public');

// Четыре сюжета §5.2 п.3: повод и бриф; характер ролика; сценарий;
// готовый ролик. Другое число — значит поменялся сюжет, а не опечатка.
assert.equal(GREETING_FRAME_COUNT, 4);

for (const locale of GREETING_REAL_FRAME_LOCALES) {
  assert.ok(
    (locales as readonly string[]).includes(locale),
    `в GREETING_REAL_FRAME_LOCALES попала неизвестная локаль «${locale}»`,
  );
}

for (const locale of locales) {
  const real = greetingFramesAreReal(locale);
  assert.equal(real, GREETING_REAL_FRAME_LOCALES.includes(locale));
  for (let n = 1; n <= GREETING_FRAME_COUNT; n += 1) {
    const frame = greetingFrame(locale, n);
    assert.equal(
      frame.real,
      real,
      `${locale}, кадр ${n}: тип не совпал со списком`,
    );
    if (real) {
      assert.equal(frame.src, `/illustrations/greet-shot-${locale}-${n}.avif`);
      assert.ok(
        frame.height > frame.width,
        `${locale}, кадр ${n}: снимок должен быть вертикальным`,
      );
    } else {
      assert.equal(frame.src, `/illustrations/greet-frame-${n}.svg`);
      // Холст схемы 840×540 — тот же, что у обучалки (§5.3).
      assert.deepEqual(
        [frame.width, frame.height],
        [840, 540],
        `кадр ${n}: не тот холст схемы`,
      );
    }
  }
}

// Схема «Вы в кадре» (этап J) — всегда схема, тот же холст: настоящий
// кадр этого экрана — лицо человека, для рекламы нужно отдельное согласие.
{
  const persona = greetingPersonaScheme();
  assert.equal(persona.real, false, '«Вы в кадре» не может быть «снимком»');
  assert.equal(persona.src, '/illustrations/greet-persona.svg');
  assert.deepEqual([persona.width, persona.height], [840, 540]);
}

// Номер вне 1…4 — ошибка вызывающего, а не битая картинка на странице.
for (const bad of [0, GREETING_FRAME_COUNT + 1, 1.5, Number.NaN]) {
  assert.throws(
    () => greetingFrame('ru', bad),
    RangeError,
    `greetingFrame('ru', ${bad}) должен бросать, а не отдавать несуществующий файл`,
  );
}

/**
 * Файлы схем: на месте, в бюджете, и без того, что Уровень 1 запрещает.
 * Бюджеты — §5.3 ТЗ (≤120 КБ кадр; схема «Вы в кадре» — кадр, этап J).
 * `greet-hero.svg` удалён 07.10.2026: hero — AVIF (см. ниже), и OG-карточки
 * (`scripts/og-greetings-cards.mjs`) рисуются с того же AVIF.
 *
 * «Без текста» проверяется по элементам, а не по символам: цифры в
 * SVG — это координаты. `<text>` сделал бы картинку зависимой от
 * локали (схема одна на пять), `<image>`/`href` — от чужого адреса,
 * `<foreignObject>` — от HTML внутри картинки. Любой `http` кроме
 * пространства имён — это домен на картинке или внешняя загрузка.
 */
const schemes = [
  ...Array.from({ length: GREETING_FRAME_COUNT }, (_, i) => ({
    file: `greet-frame-${i + 1}.svg`,
    max: 120 * 1024,
  })),
  { file: 'greet-persona.svg', max: 120 * 1024 },
];
for (const { file, max } of schemes) {
  const full = path.join(PUBLIC, 'illustrations', file);
  const bytes = statSync(full).size;
  assert.ok(
    bytes <= max,
    `${file}: ${Math.round(bytes / 1024)} КБ при бюджете ${max / 1024} КБ`,
  );
  const svg = readFileSync(full, 'utf8');
  assert.match(svg, /viewBox="0 0 840 540"/, `${file}: холст не 840×540`);
  assert.doesNotMatch(
    svg,
    /<(text|tspan|textPath|foreignObject|image|use|script)\b/,
    `${file}: запрещённый элемент`,
  );
  assert.doesNotMatch(svg, /\bhref=/, `${file}: внешняя ссылка`);
  const urls = svg.match(/https?:\/\/[^"'\s)]+/g) ?? [];
  assert.deepEqual(
    urls.filter((u) => u !== 'http://www.w3.org/2000/svg'),
    [],
    `${file}: адрес на картинке`,
  );
  // Схема не должна остаться заглушкой первого шага этапа.
  assert.ok(!svg.includes('Заглушка'), `${file}: всё ещё заглушка`);
}

/**
 * Hero трёх страниц — растровые AVIF 1536×1024 (`*-hero-v2.avif`; главная,
 * поздравления, обучалки). Бюджет — фактический вес на момент замены
 * плюс ~20% запаса: картинка в первом экране и кандидат в LCP, и
 * пересохранение «без оглядки на вес» должно ронять тест, а не страницу.
 * Размер сверяется по коробке `ispe` файла с тем, что объявляет разметка
 * (`width={1536} height={1024}`), иначе оправа растянет кадр.
 */
{
  const heroes = [
    { file: 'ads-hero-v2.avif', max: 128 * 1024 },
    { file: 'greetings-hero-v2.avif', max: 80 * 1024 },
    { file: 'tutorial-hero-v2.avif', max: 68 * 1024 },
  ];
  for (const { file, max } of heroes) {
    const bytes = readFileSync(path.join(PUBLIC, 'illustrations', file));
    assert.ok(
      bytes.length <= max,
      `${file}: ${Math.round(bytes.length / 1024)} КБ при бюджете ${max / 1024} КБ`,
    );
    assert.equal(bytes.subarray(4, 12).toString('latin1'), 'ftypavif', `${file}: не AVIF`);
    const ispe = bytes.indexOf('ispe', 0, 'latin1');
    assert.ok(ispe > 0, `${file}: нет коробки ispe`);
    assert.deepEqual(
      [bytes.readUInt32BE(ispe + 8), bytes.readUInt32BE(ispe + 12)],
      [1536, 1024],
      `${file}: не 1536×1024`,
    );
  }

  /**
   * Запасные форматы и ширины (`components/HeroPicture.tsx`, производные
   * от AVIF — `scripts/hero-fallbacks.mjs`): у каждого hero есть AVIF 768,
   * WebP и JPEG в 1536 и 768. Нет файла — `<picture>` отдаст 404 ровно тем
   * браузерам, ради которых запасной формат и заведён. Формат — по
   * сигнатуре, ширина — по заголовку файла (srcset обещает `768w`/`1536w`).
   * Бюджеты — фактический вес плюс запас; запасной JPEG качают только
   * браузеры без AVIF и WebP, поэтому он может быть тяжелее.
   */
  const fallbackBudget: Record<string, Record<string, number>> = {
    'ads-hero-v2': { avif768: 80, webp: 210, webp768: 82, jpg: 245, jpg768: 85 },
    'greetings-hero-v2': { avif768: 42, webp: 120, webp768: 50, jpg: 170, jpg768: 62 },
    'tutorial-hero-v2': { avif768: 34, webp: 108, webp768: 46, jpg: 158, jpg768: 58 },
  };
  for (const name of HERO_IMAGES) {
    const budget = fallbackBudget[name];
    assert.ok(budget, `${name}: нет бюджета запасных форматов`);
    const variants = [
      { file: `${name}-768.avif`, key: 'avif768', width: 768, kind: 'avif' },
      { file: `${name}.webp`, key: 'webp', width: 1536, kind: 'webp' },
      { file: `${name}-768.webp`, key: 'webp768', width: 768, kind: 'webp' },
      { file: `${name}.jpg`, key: 'jpg', width: 1536, kind: 'jpg' },
      { file: `${name}-768.jpg`, key: 'jpg768', width: 768, kind: 'jpg' },
    ] as const;
    for (const v of variants) {
      const bytes = readFileSync(path.join(PUBLIC, 'illustrations', v.file));
      assert.ok(
        bytes.length <= budget[v.key] * 1024,
        `${v.file}: ${Math.round(bytes.length / 1024)} КБ при бюджете ${budget[v.key]} КБ`,
      );
      assert.deepEqual(imageSize(bytes, v.kind), [v.width, (v.width * 2) / 3], `${v.file}: размер`);
    }
  }
}

/** Ширина×высота по заголовку файла — без зависимостей. */
function imageSize(bytes: Buffer, kind: 'avif' | 'webp' | 'jpg'): [number, number] {
  if (kind === 'avif') {
    assert.equal(bytes.subarray(4, 12).toString('latin1'), 'ftypavif', 'не AVIF');
    const ispe = bytes.indexOf('ispe', 0, 'latin1');
    return [bytes.readUInt32BE(ispe + 8), bytes.readUInt32BE(ispe + 12)];
  }
  if (kind === 'webp') {
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', 'не WebP');
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', 'не WebP');
    const chunk = bytes.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') {
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    }
    if (chunk === 'VP8X') {
      return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
    }
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    throw new Error(`WebP: неизвестный блок ${chunk}`);
  }
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'не JPEG');
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0..SOF15, кроме DHT (C4), JPG (C8) и DAC (CC).
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
    }
    offset += 2 + length;
  }
  throw new Error('JPEG: нет SOF');
}

/**
 * Скрипт обработки снимков (`scripts/tutorial-frames-process.mjs
 * --greeting`, этап I ТЗ Greeting 2.0) ↔ эта страница. Скрипт кладёт
 * файлы и называет список, в который потом дописывают локаль; страница
 * ищет файлы по своему шаблону. Разойдись имя — владелец положит четыре
 * кадра, допишет локаль, и шов 17-бис назовёт их «лишними», а страница
 * отдаст 404. Разойдись размер — оправа кадра растянет снимок.
 */
{
  const script = readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'tutorial-frames-process.mjs'),
    'utf8',
  );
  const greetingKind =
    /greeting: \{\s*prefix: '([a-z-]+)',\s*list: '([A-Z_]+)',\s*module: '([^']+)'/.exec(
      script,
    );
  assert.ok(
    greetingKind,
    'в tutorial-frames-process.mjs не нашёлся KINDS.greeting',
  );
  const [, prefix, list, modulePath] = greetingKind;
  const pageSrc = readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'greeting-frames.ts'),
    'utf8',
  );
  assert.ok(
    pageSrc.includes(`/illustrations/${prefix}-\${locale}-\${n}.avif`),
    `страница ищет не те файлы, что кладёт скрипт (${prefix}-<локаль>-<n>.avif)`,
  );
  assert.ok(
    pageSrc.includes(`export const ${list}:`),
    `скрипт велит дописать локаль в ${list}, а такого списка на странице нет`,
  );
  assert.equal(modulePath, 'landing/src/lib/greeting-frames.ts');

  // 844 CSS-пикселя × плотность 2 × KEEP, вниз до чётного — ровно так
  // режет ffmpeg (`floor(ih*KEEP/2)*2`); ширина — TARGET_WIDTH.
  const keep = Number(/const KEEP = ([0-9.]+);/.exec(script)?.[1]);
  const width = Number(/const TARGET_WIDTH = (\d+);/.exec(script)?.[1]);
  const shot = /const SHOT = \{ width: (\d+), height: (\d+) \}/.exec(pageSrc);
  assert.ok(shot, 'в greeting-frames.ts не нашёлся SHOT');
  assert.deepEqual(
    [Number(shot[1]), Number(shot[2])],
    [width, Math.floor((844 * 2 * keep) / 2) * 2],
    'размер снимка на странице разошёлся с обрезкой скрипта',
  );
}

console.log(
  `greeting-frames: ok (${locales.length} локалей × ${GREETING_FRAME_COUNT} кадров; hero AVIF в бюджете; ` +
    `с настоящими кадрами: ${GREETING_REAL_FRAME_LOCALES.length || 'ни одной, пока схемы'}; ` +
    'схема «Вы в кадре» в бюджете)',
);
