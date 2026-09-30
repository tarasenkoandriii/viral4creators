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
import {
  GREETING_FRAME_COUNT,
  GREETING_REAL_FRAME_LOCALES,
  greetingFrame,
  greetingFramesAreReal,
  greetingHero,
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

  // Hero — всегда схема: такого экрана в продукте нет, снять его нельзя.
  const hero = greetingHero(locale);
  assert.equal(hero.real, false, `${locale}: hero не может быть «снимком»`);
  assert.equal(hero.src, '/illustrations/greet-hero.svg');
  assert.deepEqual([hero.width, hero.height], [840, 540]);
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
 * Бюджеты — §5.3 ТЗ (≤90 КБ hero, ≤120 КБ кадр; схема «Вы в кадре» —
 * кадр, этап J).
 *
 * «Без текста» проверяется по элементам, а не по символам: цифры в
 * SVG — это координаты. `<text>` сделал бы картинку зависимой от
 * локали (схема одна на пять), `<image>`/`href` — от чужого адреса,
 * `<foreignObject>` — от HTML внутри картинки. Любой `http` кроме
 * пространства имён — это домен на картинке или внешняя загрузка.
 */
const schemes = [
  { file: 'greet-hero.svg', max: 90 * 1024 },
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
  `greeting-frames: ok (${locales.length} локалей × ${GREETING_FRAME_COUNT} кадров + hero; ` +
    `с настоящими кадрами: ${GREETING_REAL_FRAME_LOCALES.length || 'ни одной, пока схемы'}; ` +
    'схема «Вы в кадре» в бюджете)',
);
