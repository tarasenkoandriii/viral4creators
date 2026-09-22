import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDictionary } from '../../../lib/get-dictionary';
import { OG_LOCALES, isLocale, type Locale } from '../../../lib/i18n';
import {
  getSharedVideo,
  SHARED_VIDEO_REVALIDATE_SECONDS,
} from '../../../lib/shared-video-api';
import { SITE_URL, SITE_NAME, TMA_URL } from '../../../lib/content';
import { ShareButtons } from '../../../components/ShareButtons';
import { jsonLdScript } from '../../../lib/json-ld';

/**
 * Публичная страница готового ролика и петля шеринга (ТЗ §40, этап 60).
 *
 * НЕТ `[locale]`-сегмента — намеренно (см. middleware.ts): у снимка
 * страницы одна зафиксированная локаль автора на момент публикации
 * (`SharedVideoPage.locale`), переводов не запрашивалось. Текст интерфейса
 * вокруг плеера читается из тех же словарей, что и весь остальной лендинг
 * (`getDictionary(page.locale)`), просто без URL-переключателя.
 *
 * Статики a-la generateStaticParams здесь НЕТ (в отличие от блога): id
 * страниц заранее неизвестны и появляются в любой момент по решению
 * оператора — маршрут рендерится по требованию и держится `revalidate`
 * (тот же ISR-приём, что и у блога, см. lib/shared-video-api.ts).
 */
export const revalidate = SHARED_VIDEO_REVALIDATE_SECONDS;

const INTL_LOCALE: Record<string, string> = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  en: 'en-US',
  de: 'de-DE',
  es: 'es-ES',
};

function localeOf(raw: string): Locale {
  return isLocale(raw) ? raw : 'ru';
}

/** "9:16" → 9/16 для CSS `aspect-ratio`; нераспознанное — 16:9. */
function cssAspectRatio(raw: string | null): string {
  const m = raw?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return m ? `${m[1]} / ${m[2]}` : '16 / 9';
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const page = await getSharedVideo(params.id);
  if (!page) return {};
  const locale = localeOf(page.locale);
  const dict = getDictionary(locale);
  // Этап 1 витрины (находка 1.1 аудита): у поздравления `productName` и
  // `productDescription` — NULL, и прежняя строка выдавала бы пустое
  // описание в <meta>, og и Twitter-карточке. Для поздравления описание
  // берётся из словаря: имя получателя в него не попадает НИКОГДА (см.
  // snapshotFromSession на бэкенде — это персональные данные третьего
  // лица, которое страницу не публиковало).
  const isGreeting = page.projectType === 'GREETING_VIDEO';
  const description = (
    page.productDescription ??
    page.productName ??
    (isGreeting ? dict.sharedVideo.greetingMetaDescription : page.title)
  ).slice(0, 200);
  const images = page.productImageUrl ? [page.productImageUrl] : undefined;
  return {
    title: `${page.title}${dict.sharedVideo.metaTitleSuffix}`,
    description,
    alternates: { canonical: `${SITE_URL}/video/${page.id}` },
    openGraph: {
      title: page.title,
      description,
      type: 'video.other',
      locale: OG_LOCALES[locale],
      images,
      videos: [{ url: page.videoUrl }],
    },
    twitter: {
      card: images ? 'summary_large_image' : 'summary',
      title: page.title,
      description,
      images,
    },
    // Страница одна на конкретный ролик, а не контент, который нужен
    // поисковику постоянно, — но и прятать её незачем, ссылка публичная.
    robots: { index: true, follow: true },
  };
}

export default async function SharedVideoPage({
  params,
}: {
  params: { id: string };
}) {
  const page = await getSharedVideo(params.id);
  if (!page) notFound();

  const locale = localeOf(page.locale);
  const dict = getDictionary(locale);
  const isGreeting = page.projectType === 'GREETING_VIDEO';
  const pageUrl = `${SITE_URL}/video/${page.id}`;
  const priceText =
    page.price != null
      ? new Intl.NumberFormat(INTL_LOCALE[locale] ?? 'ru-RU', {
          style: 'currency',
          currency: page.currency ?? 'RUB',
          maximumFractionDigits: 0,
        }).format(page.price)
      : null;

  // Schema.org VideoObject — то же обоснование, что у JSON-LD блога
  // (app/[locale]/blog/[slug]/page.tsx): абсолютные URL, машиночитаемая
  // разметка для шаринга/поисковика, а не переизобретение вручную в JSX.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: page.title,
    description:
      page.productDescription ??
      page.productName ??
      (isGreeting ? dict.sharedVideo.greetingMetaDescription : page.title),
    thumbnailUrl: page.productImageUrl ?? undefined,
    uploadDate: page.createdAt,
    contentUrl: page.videoUrl,
    embedUrl: pageUrl,
    publisher: { '@type': 'Organization', name: SITE_NAME },
  };

  return (
    <>
      <main className="wrap shared-video-page">
        <p className="shared-video-back">
          <Link href="/">{dict.sharedVideo.backToHome}</Link>
        </p>

        {/* Фича №20 — «магическая ссылка» с раскрытием: у поздравления
            перед плеером стоит заставка, а не голое видео. Момент
            вручения — половина подарка, и открыть его должен сам
            получатель.

            Сделано БЕЗ единой строки JavaScript: скрытый чекбокс и
            `<label>` поверх него. Причина не в экономии — страница
            приходит по ссылке из мессенджера, и открывают её во
            встроенных webview, где скрипт может не выполниться или
            выполниться позже картинки. Пустая тёмная плашка вместо
            подарка — худший из возможных первых кадров. Здесь же без
            JS просто сразу виден плеер: заставка не «сломалась», её
            нет.

            Текст заставки общий («Вам поздравление» + повод): имени
            отправителя в снимке страницы нет и не будет — публичная
            страница намеренно не выносит наружу персональные данные
            брифа (см. snapshotFromSession). */}
        {isGreeting && (
          <input
            type="checkbox"
            id="greeting-reveal"
            className="sr-only greeting-reveal-toggle"
          />
        )}
        {isGreeting && (
          <div className="greeting-reveal-cover">
            <span className="greeting-reveal-title">
              {dict.sharedVideo.revealTitle}
              {page.occasion && ` · ${dict.sharedVideo.occasion[page.occasion]}`}
            </span>
            <label className="cta" htmlFor="greeting-reveal">
              {dict.sharedVideo.revealButton}
            </label>
            <span className="greeting-reveal-hint">
              {dict.sharedVideo.revealHint}
            </span>
          </div>
        )}

        <div
          className="shared-video-player"
          style={{ aspectRatio: cssAspectRatio(page.aspectRatio) }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- пользовательский UGC-ролик без дорожки субтитров, как и у остальных плееров проекта (VideoPlayer.tsx) */}
          <video
            src={page.videoUrl}
            controls
            playsInline
            poster={page.productImageUrl ?? undefined}
          />
        </div>

        <h1 className="shared-video-title">{page.title}</h1>

        {/* Товарная рамка — только у товарного ролика. У поздравления
            её нет ни в каком виде: ни названия, ни цены, ни фото
            (находка 1.1 аудита — до этой правки страница рендерила бы
            пустой блок с пустым названием). Вместо неё — повод, если он
            известен. */}
        {isGreeting ? (
          <p className="shared-video-greeting-occasion">
            {dict.sharedVideo.greetingLabel}
            {page.occasion && ` · ${dict.sharedVideo.occasion[page.occasion]}`}
          </p>
        ) : (
        <div className="shared-video-product">
          {page.productImageUrl && (
            // Своя копия в Blob (SharedVideoService.keepOwnCopy), не
            // чужой хостинг — но next/image потребовал бы завести домен
            // Blob-хранилища в remotePatterns ради одной маленькой
            // фотографии товара; проще держаться уже принятого в этом
            // проекте паттерна (см. тот же eslint-disable в blog/page.tsx).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="shared-video-product-photo"
              src={page.productImageUrl}
              alt={page.productName ?? page.title}
            />
          )}
          <div className="shared-video-product-body">
            <p className="shared-video-product-name">{page.productName}</p>
            {page.productDescription && (
              <p className="shared-video-product-desc">
                {page.productDescription}
              </p>
            )}
            {priceText && (
              <p className="shared-video-product-price">
                {dict.sharedVideo.priceLabel}: {priceText}
              </p>
            )}
          </div>
        </div>
        )}

        <div className="shared-video-actions">
          {/* «Сделать такой же» для ТОВАРНОГО ролика форкает разбор
              референса (`?fromShared=` → App.tsx → GenerationWizard). У
              поздравления форкать нечего: разбора у него нет
              (`libraryEntryId` пуст), и тот же параметр привёл бы
              человека, пришедшего за поздравлением, в товарный визард.
              Поэтому у него своя ссылка — прямо на создание проекта, где
              поздравление и есть один из типов. */}
          <a
            className="cta"
            href={
              isGreeting
                ? // Фича №29: петля обязана приводить в ТУ ЖЕ форму, а
                  // не в общий мастер. `entry` теперь читается
                  // (`landing-entry.ts` во frontend), а известный повод
                  // открывает форму сразу с ним — зритель, которому
                  // понравилось поздравление с днём рождения, попадает
                  // на форму дня рождения, а не на товарный ролик.
                  `${TMA_URL}?entry=greetings${
                    page.occasion ? `&occasion=${page.occasion}` : ''
                  }#/projects/new`
                : `${TMA_URL}?fromShared=${page.id}`
            }
          >
            {isGreeting
              ? dict.sharedVideo.greetingMakeSameCta
              : dict.sharedVideo.makeSameCta}
          </a>
          <ShareButtons
            url={pageUrl}
            title={page.title}
            label={dict.sharedVideo.shareCta}
            copiedLabel={dict.sharedVideo.linkCopied}
          />
        </div>

        <p className="shared-video-powered">{dict.sharedVideo.poweredBy}</p>
      </main>
      {/* eslint-disable-next-line react/no-danger */}
      <script
        type="application/ld+json"
        // Г-3.2: jsonLdScript (не голый JSON.stringify) экранирует `<`,
        // чтобы `</script>` в пользовательском title/productDescription
        // не обрывал тег раньше времени.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
    </>
  );
}
