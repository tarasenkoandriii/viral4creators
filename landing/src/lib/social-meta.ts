import type { Metadata } from 'next';
import { OG_LOCALES, type Locale } from './i18n';

/**
 * `openGraph` + `twitter` одной парой — чтобы они не расходились.
 *
 * Появилось по находкам Ф-3 и Ф-7 аудита живого лендинга.
 *
 * **Ф-7 — та, ради которой это общая функция, а не просто картинка.**
 * `twitter` задавался ровно в одном месте — `[locale]/layout.tsx`, с
 * заголовком и описанием ГЛАВНОЙ страницы. Остальные страницы свой
 * `twitter` не задавали вовсе, а метаданные Next наследуются по
 * ключам верхнего уровня: `openGraph` они переопределяли, `twitter`
 * — нет. В результате ссылка на страницу поздравлений или обучалок,
 * отправленная туда, где читают `twitter:`-теги, разворачивалась
 * заголовком «viral4creators — UGC-реклама из одного примера» и
 * описанием разбора референсов. На самой странице это не видно
 * никак — только в чужом превью.
 *
 * **Ф-3: `og:image` не было нигде.** Ссылка разворачивалась текстом
 * без картинки — для продукта, который продаёт видео, потеря именно
 * там, где ссылку пересылают. Картинки лежат статикой в `public/og/`
 * (по одной на сайт × локаль) и собираются из тех же строк словаря,
 * что и сама страница.
 *
 * Тип карточки — `summary_large_image`: у нас есть картинка 1200×630,
 * а `summary` показал бы её крошечным квадратом сбоку.
 */
export function socialMeta(opts: {
  title: string;
  description: string;
  /** Абсолютный адрес страницы; он же `og:url`. */
  url: string;
  locale: Locale;
  /** Абсолютный адрес картинки 1200×630. */
  image: string;
  type?: 'website' | 'article';
}): Pick<Metadata, 'openGraph' | 'twitter'> {
  const images = [{ url: opts.image, width: 1200, height: 630, alt: opts.title }];
  return {
    openGraph: {
      title: opts.title,
      description: opts.description,
      url: opts.url,
      locale: OG_LOCALES[opts.locale],
      type: opts.type ?? 'website',
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: opts.title,
      description: opts.description,
      images,
    },
  };
}

/** Адрес статической OG-картинки сайта и локали. */
export function ogImageUrl(
  origin: string,
  site: 'main' | 'greetings' | 'tutorial',
  locale: Locale,
): string {
  return `${origin}/og/${site}-${locale}.jpg`;
}
