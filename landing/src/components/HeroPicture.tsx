/**
 * Картинка первого экрана (главная, поздравления, обучалки) — `<picture>`
 * с AVIF, запасными WebP/JPEG и двумя ширинами (TODO «лендинг: AVIF без
 * `srcset` и запасного формата», 07.10.2026).
 *
 * ## Почему не `next/image`
 *
 * Было `<Image … unoptimized>`: один AVIF 1536 px без `srcset` и без
 * запасного формата. Safari < 16 и iOS 15 WebView (встроенный браузер
 * Telegram на старых iPhone) AVIF не декодируют — в первом экране
 * оставалась пустая оправа; телефон 2× качал 1536 px там, где хватает 768.
 * `next/image` запасного ФОРМАТА в разметке не умеет вовсе (только через
 * оптимизатор и `Accept`), а оптимизатор здесь выключен сознательно —
 * исходник уже сжат, и пережимать его на каждой ширине незачем. Отсюда
 * обычный `<picture>`: браузер сам берёт первый понятный ему `<source>` и
 * качает ОДИН файл нужной ширины. Компонент серверный — в клиентский
 * бандл не попадает.
 *
 * ## Без сдвига вёрстки
 *
 * `width`/`height` на `<img>` — пропорция 3:2 известна до загрузки
 * (правило `.frame-shot img { width:100%; height:auto }`), рамка не
 * прыгает. Все файлы — производные от одного AVIF
 * (`scripts/hero-fallbacks.mjs`); наличие и бюджеты держит
 * `scripts/greeting-frames.test.ts`.
 */

/** Имена hero — производные файлы собирает `scripts/hero-fallbacks.mjs`. */
export const HERO_IMAGES = [
  'ads-hero-v2',
  'greetings-hero-v2',
  'tutorial-hero-v2',
] as const;
export type HeroImageName = (typeof HERO_IMAGES)[number];

export const HERO_WIDTH = 1536;
export const HERO_HEIGHT = 1024;
export const HERO_SMALL_WIDTH = 768;
/** Колонка hero на ≥900px — 46% ширины, ниже — во всю ширину. */
export const HERO_SIZES = '(min-width: 900px) 46vw, 100vw';

const FORMATS = [
  { ext: 'avif', type: 'image/avif' },
  { ext: 'webp', type: 'image/webp' },
] as const;

function srcSet(name: HeroImageName, ext: string): string {
  return (
    `/illustrations/${name}-${HERO_SMALL_WIDTH}.${ext} ${HERO_SMALL_WIDTH}w, ` +
    `/illustrations/${name}.${ext} ${HERO_WIDTH}w`
  );
}

export function HeroPicture({ name }: { name: HeroImageName }) {
  return (
    <picture>
      {FORMATS.map((format) => (
        <source
          key={format.ext}
          type={format.type}
          srcSet={srcSet(name, format.ext)}
          sizes={HERO_SIZES}
        />
      ))}
      {/* Без `fetchPriority="high"` и предзагрузки: на телефоне (360px)
          кадр ниже первого экрана, и высокий приоритет отнимал канал у
          CSS/JS. `loading="eager"` — на десктопе кадр в первом экране и не
          должен ждать ленивой загрузки. JPEG — последний рубеж для
          браузеров без AVIF и WebP. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/illustrations/${name}.jpg`}
        srcSet={srcSet(name, 'jpg')}
        sizes={HERO_SIZES}
        width={HERO_WIDTH}
        height={HERO_HEIGHT}
        alt=""
        loading="eager"
        decoding="async"
      />
    </picture>
  );
}
