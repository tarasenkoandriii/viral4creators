/**
 * Шов между списком локалей с настоящими кадрами
 * (`src/lib/tutorial-frames.ts`), словарями и разметкой секции «Как это
 * выглядит» (этап I ТЗ `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * Проверяется главное свойство этой конструкции: **картинки и текст
 * переключаются вместе.** Страница, которая продаёт достоверность, не
 * может сначала получить настоящие кадры, а оговорку «ниже схемы
 * интерфейса, а не сам интерфейс» потерять через неделю — или
 * наоборот, объявить кадры настоящими, пока внизу схемы.
 *
 * Файловую сторону (лежат ли на диске четыре `.avif` для объявленной
 * локали и укладываются ли они в бюджет) проверяет шов 17 в
 * `scripts/check-docs.mjs`: там есть доступ ко всему репозиторию.
 */
import assert from 'node:assert/strict';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import {
  FRAME_COUNT,
  REAL_FRAME_LOCALES,
  SHOT_CSS_WIDTH,
  frameImage,
  frameSizes,
  hasRealFrames,
} from '../src/lib/tutorial-frames';

for (const locale of locales) {
  const how = getDictionary(locale).siteTutorialLanding.how;

  assert.equal(
    how.items.length,
    FRAME_COUNT,
    `${locale}: кадров в словаре ${how.items.length}, а модуль рассчитан на ${FRAME_COUNT}`,
  );

  // Обе оговорки обязаны существовать в каждой локали: переключение
  // односторонним быть не может, иначе на украинском кадры станут
  // настоящими, а сказать об этом будет нечем.
  for (const key of ['lead', 'leadReal', 'shotAlt'] as const) {
    assert.ok(
      typeof how[key] === 'string' && how[key].trim().length > 0,
      `${locale}: how.${key} пустой`,
    );
  }
  assert.notEqual(
    how.lead,
    how.leadReal,
    `${locale}: оговорка про схемы и оговорка про настоящие кадры совпадают — переключать нечего`,
  );
}

// Список локалей — только из настоящих локалей продукта: опечатка
// завела бы ветку, в которую никто никогда не попадёт.
for (const locale of REAL_FRAME_LOCALES) {
  assert.ok(
    (locales as readonly string[]).includes(locale),
    `в REAL_FRAME_LOCALES попала неизвестная локаль «${locale}»`,
  );
}

for (const locale of locales) {
  const real = hasRealFrames(locale);
  for (let i = 1; i <= FRAME_COUNT; i += 1) {
    const frame = frameImage(locale, i);
    assert.equal(frame.real, real, `${locale}, кадр ${i}: тип не совпал со списком`);
    if (real) {
      assert.equal(frame.src, `/illustrations/tutorial-shot-${locale}-${i}.avif`);
      // Портрет: снимок телефона, обрезанный по значимой зоне.
      assert.ok(frame.height > frame.width, `${locale}, кадр ${i}: снимок должен быть вертикальным`);
      assert.equal(typeof frameSizes(true), 'string');
    } else {
      assert.equal(frame.src, `/illustrations/tutorial-frame-${i}.svg`);
      // Ландшафт: холст схемы 3:2.
      assert.ok(frame.width > frame.height, `кадр ${i}: схема должна быть ландшафтной`);
      // `sizes` у SVG не нужен — браузеру не из чего выбирать.
      assert.equal(frameSizes(false), undefined);
    }
  }
}

/**
 * `sizes` не имеет права обещать браузеру больше, чем кадр реально
 * занимает: он верит и берёт вариант покрупнее. Первая редакция
 * подставляла сюда ширины ландшафтной схемы (481/664/342) при слоте в
 * 278px — браузер запрашивал `w=640`, вдвое больше нужного (А-И2).
 */
const promised = (frameSizes(true) ?? '')
  .split(',')
  .map((part) => Number(part.trim().match(/(\d+)px\s*$/)?.[1] ?? 0));
assert.ok(promised.length > 0, 'frameSizes(true) должен называть ширину');
for (const width of promised) {
  assert.ok(
    width > 0 && width <= SHOT_CSS_WIDTH,
    `sizes обещает ${width}px при потолке ${SHOT_CSS_WIDTH}px — браузер возьмёт картинку крупнее нужного`,
  );
}

console.log(
  `tutorial-frames: ok (${locales.length} локалей × ${FRAME_COUNT} кадров; ` +
    `с настоящими кадрами: ${REAL_FRAME_LOCALES.length || 'ни одной, пока схемы'})`,
);
